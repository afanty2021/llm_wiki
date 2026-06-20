# src-server Graph Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植桌面 `graph-insights.ts`——惊喜连接（4 信号打分）与知识缺口（3 类型检测）的纯计算分析。

**Architecture:** `services/graph.rs` 追加两个纯函数 + 类型（`SurprisingConnection`/`KnowledgeGap`），消费 2c 的 `build_graph` 产出（cached WikiGraph）。`routes/graph.rs` 的 `get_insights` handler 替换为调用这两个函数。

**Tech Stack:** Rust + Axum（纯计算，无新依赖）

**Spec:** `docs/superpowers/specs/2026-06-20-src-server-insights-design.md`（2 轮 review）

---

## 前置条件

- **2c（graph API）已实现**：`build_graph` 返回 `WikiGraph{nodes, edges, communities}`，类型（`GraphNode`/`GraphEdge`/`CommunityInfo`）均为 `pub`，`node_type` 包含 `"system"`（reserved pages）。`build_graph` 有 cache。
- 本 plan **仅修改 graph.rs（追加）+ routes/graph.rs（替换 handler）**。
- 集成测试 `#[ignore]`（PG + project 249）。

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src-server/src/services/graph.rs` | 追加 `SurprisingConnection`/`KnowledgeGap` 类型 + `find_surprising_connections` + `detect_knowledge_gaps` | Modify（追加）|
| `src-server/src/routes/graph.rs` | `get_insights` handler 替换为调新函数 | Modify |

---

## Task 1：类型定义 + 空图边界测试

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试（空图→空，类型可构造）**

在 `graph.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn empty_graph_gives_empty_insights() {
        let g = WikiGraph { nodes: vec![], edges: vec![], communities: vec![] };
        assert!(find_surprising_connections(&g, 5).is_empty());
        assert!(detect_knowledge_gaps(&g, 8).is_empty());
    }
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib graph::tests::empty_graph 2>&1 | tail -3
```
Expected: 编译失败（`find_surprising_connections`/`detect_knowledge_gaps` 未定义）。

- [ ] **Step 3: 加类型定义 + 两个函数占位**

在 `related_nodes` 之后追加：

```rust
#[derive(serde::Serialize, Clone)]
pub struct SurprisingConnection {
    pub source: GraphNode,
    pub target: GraphNode,
    pub score: i32,
    pub reasons: Vec<String>,
    pub key: String,
}

#[derive(serde::Serialize, Clone)]
pub struct KnowledgeGap {
    #[serde(rename = "type")]
    pub r#type: String,      // "isolated-node" | "sparse-community" | "bridge-node"
    pub title: String,
    pub description: String,
    pub nodeIds: Vec<String>,
    pub suggestion: String,
}

pub fn find_surprising_connections(_graph: &WikiGraph, _limit: usize) -> Vec<SurprisingConnection> {
    Vec::new() // Task 2 实现
}

pub fn detect_knowledge_gaps(_graph: &WikiGraph, _limit: usize) -> Vec<KnowledgeGap> {
    Vec::new() // Task 3 实现
}
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib graph::tests::empty_graph 2>&1 | tail -3
```
Expected: passed（空图返回空）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): insights 类型定义(SurprisingConnection/KnowledgeGap) + 空图占位"
```

---

## Task 2：find_surprising_connections（4 信号打分）

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试（跨社区+3/distant-pair+2/边缘枢纽+2/弱边+1/阈值 score<3 不入选/system 排除）**

在 `mod tests` 追加：

```rust
    fn mk_node(id: &str, label: &str, ty: &str, deg: i32, comm: usize) -> GraphNode {
        GraphNode { id: id.into(), label: label.into(), node_type: ty.into(), path: id.into(), link_count: deg, community: comm }
    }
    fn mk_edge(src: &str, tgt: &str, w: f64) -> GraphEdge {
        GraphEdge { source: src.into(), target: tgt.into(), weight: w }
    }

    #[test]
    fn surprising_cross_community_gives_3() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",2,0), mk_node("b","B","concept",3,1)],
            edges: vec![mk_edge("a","b",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert_eq!(s.len(), 1, "cross-community edge should be surprising (score≥3)");
        assert_eq!(s[0].score, 3);
        assert!(s[0].reasons.iter().any(|r| r.contains("community")));
    }

    #[test]
    fn surprising_distant_pair_gives_2() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","source",2,1), mk_node("b","B","concept",2,0)],
            edges: vec![mk_edge("a","b",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s[0].score >= 5, "cross-community(+3) + distant-pair(+2) = 5, got {}", s[0].score);
        assert!(s[0].reasons.iter().any(|r| r.contains("connects")));
    }

    #[test]
    fn surprising_peripheral_to_hub_needs_both_conditions() {
        // min deg ≤2 AND max deg ≥ 0.5 × maxDegree (global max=10)
        let g = WikiGraph {
            nodes: vec![
                mk_node("peri","P","entity",2,0),
                mk_node("hub","H","concept",6,1),  // 6 ≥ 10*0.5 → hub
                mk_node("ref","R","entity",10,1),   // maxDegree=10
            ],
            edges: vec![mk_edge("peri","hub",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(!s.is_empty(), "peri-hub should be surprising: {:?}", s);
        assert!(s[0].reasons.iter().any(|r| r.contains("peripheral")));
    }

    #[test]
    fn surprising_peripheral_to_peripheral_not_surprising_on_signal3() {
        // both deg≤2 but no hub → signal 3 should NOT fire
        let g = WikiGraph {
            nodes: vec![mk_node("p1","P1","entity",2,0), mk_node("p2","P2","concept",1,1)],
            edges: vec![mk_edge("p1","p2",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        // cross-community(+3) only, no peripheral-hub signal
        assert_eq!(s[0].score, 3, "should only be 3 (cross-community), not 5: {:?}", s[0].reasons);
        assert!(!s[0].reasons.iter().any(|r| r.contains("peripheral")));
    }

    #[test]
    fn surprising_weak_edge_gives_1() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",2,0), mk_node("b","B","concept",3,1)],
            edges: vec![mk_edge("a","b",1.5)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        // cross-community(+3) + weak-edge(+1) = 4
        assert!(s[0].score >= 4);
        assert!(s[0].reasons.iter().any(|r| r.contains("weak")));
    }

    #[test]
    fn surprising_score_2_not_included() {
        // same community (=0), same type (=0), not peripheral-hub, weak edge (+1) → 1 → excluded
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",5,0), mk_node("b","B","entity",5,0)],
            edges: vec![mk_edge("a","b",1.5)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s.is_empty(), "score<3 should not be included: {:?}", s);
    }

    #[test]
    fn surprising_excludes_system_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",2,0), mk_node("sys","Index","system",2,1)],
            edges: vec![mk_edge("a","sys",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s.is_empty(), "edges involving system nodes should be excluded");
    }
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib graph::tests::surprising_ 2>&1 | tail -3
```
Expected: 多个 FAIL（当前返回空）。

- [ ] **Step 3: 实现 find_surprising_connections**

把占位替换为完整实现：

```rust
pub fn find_surprising_connections(graph: &WikiGraph, limit: usize) -> Vec<SurprisingConnection> {
    use std::collections::HashMap;

    let node_map: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let degree_map: HashMap<&str, i32> = graph.nodes.iter().map(|n| (n.id.as_str(), n.link_count)).collect();
    let max_degree = graph.nodes.iter().map(|n| n.link_count).max().unwrap_or(1).max(1);

    // 桌面 distant-pairs（source-concept / source-synthesis / query-entity 及反向）
    let is_distant_pair = |a: &str, b: &str| -> bool {
        matches!(
            (a, b),
            ("source", "concept") | ("concept", "source")
                | ("source", "synthesis") | ("synthesis", "source")
                | ("query", "entity") | ("entity", "query")
        )
    };

    let mut scored: Vec<SurprisingConnection> = Vec::new();
    for e in &graph.edges {
        let source = match node_map.get(e.source.as_str()) { Some(n) => *n, None => continue };
        let target = match node_map.get(e.target.as_str()) { Some(n) => *n, None => continue };
        // 排除 structural 节点（system 类型，case-insensitive）
        if source.node_type.to_lowercase() == "system" || target.node_type.to_lowercase() == "system" {
            continue;
        }

        let mut score = 0i32;
        let mut reasons: Vec<String> = Vec::new();

        // Signal 1: 跨社区 (+3)
        if source.community != target.community {
            score += 3;
            reasons.push("crosses community boundary".into());
        }

        // Signal 2: 跨类型（distant-pair +2，其它异类型 +1）
        if source.node_type != target.node_type {
            if is_distant_pair(&source.node_type, &target.node_type) {
                score += 2;
                reasons.push(format!("connects {} to {}", source.node_type, target.node_type));
            } else {
                score += 1;
                reasons.push("different types".into());
            }
        }

        // Signal 3: 边缘↔枢纽耦合。双条件：min deg ≤ 2 且 max deg ≥ 0.5 × maxDegree
        let sd = degree_map.get(e.source.as_str()).copied().unwrap_or(0);
        let td = degree_map.get(e.target.as_str()).copied().unwrap_or(0);
        if sd.min(td) <= 2 && sd.max(td) as f64 >= max_degree as f64 * 0.5 {
            score += 2;
            reasons.push("peripheral node links to hub".into());
        }

        // Signal 4: 弱边（0 < weight < 2）+1
        if e.weight > 0.0 && e.weight < 2.0 {
            score += 1;
            reasons.push("weak but present connection".into());
        }

        if score >= 3 && !reasons.is_empty() {
            let mut ids = [source.id.clone(), target.id.clone()];
            ids.sort();
            let key = ids.join(":::");
            scored.push(SurprisingConnection {
                source: source.clone(),
                target: target.clone(),
                score,
                reasons,
                key,
            });
        }
    }
    scored.sort_by(|a, b| b.score.cmp(&a.score));
    scored.truncate(limit);
    scored
}
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib graph::tests::surprising_ 2>&1 | tail -5
```
Expected: 7 个 surprising 测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): find_surprising_connections 4 信号打分(移植 graph-insights.ts)"
```

---

## Task 3：detect_knowledge_gaps（三类检测）

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试（isolated/sparse/bridge + 桌面序 + system 排除）**

在 `mod tests` 追加：

```rust
    #[test]
    fn gaps_isolated_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("orphan","Orphan","entity",0,0), mk_node("conn","Connected","concept",5,0)],
            edges: vec![mk_edge("conn","orphan",5.0)],
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "isolated-node"));
    }

    #[test]
    fn gaps_sparse_community() {
        let g = WikiGraph {
            nodes: vec![
                mk_node("a","A","concept",2,0), mk_node("b","B","concept",2,0), mk_node("c","C","concept",1,0),
            ],
            edges: vec![mk_edge("a","b",5.0)], // only one edge — cohesion=1/3≈0.33... wait need cohesion<0.15
            communities: vec![CommunityInfo{id:0,node_count:3,cohesion:0.10,top_nodes:vec!["A".into()]}],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "sparse-community"));
    }

    #[test]
    fn gaps_bridge_nodes() {
        // node a connects to b(comm0), c(comm1), d(comm2) → 3 communities
        let g = WikiGraph {
            nodes: vec![
                mk_node("bridge","Bridge","concept",3,0),
                mk_node("b","B","concept",1,1),
                mk_node("c","C","concept",1,2),
                mk_node("d","D","concept",1,3),
            ],
            edges: vec![mk_edge("bridge","b",5.0),mk_edge("bridge","c",5.0),mk_edge("bridge","d",5.0)],
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "bridge-node"));
    }

    #[test]
    fn gaps_desktop_order_isolated_sparse_bridge() {
        // 三类 gap 同时存在
        let g = WikiGraph {
            nodes: vec![
                mk_node("orphan","O","entity",0,0),
                mk_node("a","A","concept",2,0), mk_node("b","B","concept",2,0), mk_node("c","C","concept",1,0),
                mk_node("bridge","Br","concept",3,0),
                mk_node("x","X","concept",1,1), mk_node("y","Y","concept",1,2), mk_node("z","Z","concept",1,3),
            ],
            edges: vec![
                mk_edge("a","b",5.0),
                mk_edge("orphan","bridge",5.0),
                mk_edge("bridge","x",5.0), mk_edge("bridge","y",5.0), mk_edge("bridge","z",5.0),
            ],
            communities: vec![CommunityInfo{id:0,node_count:3,cohesion:0.10,top_nodes:vec!["A".into()]}],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        let types: Vec<&str> = gaps.iter().map(|g| g.r#type.as_str()).collect();
        // 桌面序：isolated → sparse → bridge
        let iso = types.iter().position(|t| *t == "isolated-node");
        let spa = types.iter().position(|t| *t == "sparse-community");
        let bri = types.iter().position(|t| *t == "bridge-node");
        assert!(iso < spa, "desktop order: isolated before sparse, got {:?}", types);
        assert!(spa < bri, "desktop order: sparse before bridge, got {:?}", types);
    }

    #[test]
    fn gaps_exclude_system_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("sys","Idx","system",0,0),
                        mk_node("orphan","O","entity",0,1)],
            edges: vec![],
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        // system node should NOT be isolated; only orphan counts
        let iso = gaps.iter().find(|g| g.r#type == "isolated-node");
        assert!(iso.is_some());
        assert!(!iso.unwrap().nodeIds.contains(&"sys".to_string()));
    }
```

- [ ] **Step 2: 跑确认失败**（占位返回空）

```bash
cd src-server && cargo test --lib graph::tests::gaps_ 2>&1 | tail -3
```
Expected: 5 个 FAIL。

- [ ] **Step 3: 实现 detect_knowledge_gaps**

把占位替换为：

```rust
pub fn detect_knowledge_gaps(graph: &WikiGraph, limit: usize) -> Vec<KnowledgeGap> {
    use std::collections::{HashMap, HashSet};

    let mut gaps: Vec<KnowledgeGap> = Vec::new();

    // 1. isolated nodes (degree ≤ 1, exclude system)
    let isolated: Vec<&GraphNode> = graph.nodes.iter()
        .filter(|n| n.link_count <= 1 && n.node_type.to_lowercase() != "system")
        .collect();
    if !isolated.is_empty() {
        let top5: Vec<String> = isolated.iter().take(5).map(|n| n.label.clone()).collect();
        let desc = if isolated.len() > 5 {
            format!("{}, ... and {} more", top5.join(", "), isolated.len() - 5)
        } else {
            top5.join(", ")
        };
        gaps.push(KnowledgeGap {
            r#type: "isolated-node".into(),
            title: format!("{} isolated page{}", isolated.len(), if isolated.len() > 1 { "s" } else { "" }),
            description: desc,
            nodeIds: isolated.iter().map(|n| n.id.clone()).collect(),
            suggestion: "These pages have few or no connections. Consider adding [[wikilinks]] to related pages, or research to expand their content.".into(),
        });
    }

    // 2. sparse communities (cohesion < 0.15, ≥ 3 nodes)
    let comm_nodes: HashMap<usize, Vec<&GraphNode>> = {
        let mut m: HashMap<usize, Vec<&GraphNode>> = HashMap::new();
        for n in &graph.nodes {
            m.entry(n.community).or_default().push(n);
        }
        m
    };
    for c in &graph.communities {
        if c.cohesion < 0.15 && c.node_count >= 3 {
            let first = c.top_nodes.first().cloned().unwrap_or_else(|| format!("Community {}", c.id));
            gaps.push(KnowledgeGap {
                r#type: "sparse-community".into(),
                title: format!("Sparse cluster: {}", first),
                description: format!("{} pages with cohesion {:.2} — internal connections are weak.", c.node_count, c.cohesion),
                nodeIds: comm_nodes.get(&c.id).map(|ns| ns.iter().map(|n| n.id.clone()).collect()).unwrap_or_default(),
                suggestion: "This knowledge area lacks internal cross-references. Consider adding links between these pages or researching to fill gaps.".into(),
            });
        }
    }

    // 3. bridge nodes (neighbors span ≥ 3 communities, exclude system)
    let mut comm_neighbors: HashMap<&str, HashSet<usize>> = graph.nodes.iter()
        .map(|n| (n.id.as_str(), HashSet::new())).collect();
    let node_map: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for e in &graph.edges {
        if let (Some(s), Some(t)) = (node_map.get(e.source.as_str()), node_map.get(e.target.as_str())) {
            comm_neighbors.get_mut(e.source.as_str()).map(|cs| { cs.insert(t.community); });
            comm_neighbors.get_mut(e.target.as_str()).map(|cs| { cs.insert(s.community); });
        }
    }
    let mut bridges: Vec<(&GraphNode, usize)> = graph.nodes.iter()
        .filter(|n| {
            if n.node_type.to_lowercase() == "system" { return false; }
            comm_neighbors.get(n.id.as_str()).map(|c| c.len() >= 3).unwrap_or(false)
        })
        .map(|n| (n, comm_neighbors.get(n.id.as_str()).map(|c| c.len()).unwrap_or(0)))
        .collect();
    bridges.sort_by(|a, b| b.1.cmp(&a.1)); // desc by community count
    for (bridge, count) in bridges.iter().take(3) {
        gaps.push(KnowledgeGap {
            r#type: "bridge-node".into(),
            title: format!("Key bridge: {}", bridge.label),
            description: format!("Connects {} different knowledge clusters. This is a critical junction in your wiki.", count),
            nodeIds: vec![bridge.id.clone()],
            suggestion: "This page bridges multiple knowledge areas. Ensure it's well-maintained — if it's thin, expanding it will strengthen your entire wiki.".into(),
        });
    }

    gaps.truncate(limit); // 桌面 overall slice
    gaps
}
```

> 桌面序（isolated→sparse→bridge）由构造顺序自然保证：isolated 先 push、sparse 逐社区追加、bridge 最后。`truncate(limit)` 在末尾统一做，与桌面 `slice(0, limit)` 一致。

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib graph::tests::gaps_ 2>&1 | tail -5
```
Expected: 5 个 pass（含 `gaps_desktop_order` 序检查）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): detect_knowledge_gaps 三类检测(移植,桌面序)"
```

---

## Task 4：routes/graph.rs 接线 + 手动验证

**Files:**
- Modify: `src-server/src/routes/graph.rs`

- [ ] **Step 1: 替换 get_insights handler**

把 `get_insights` 的 handler body（目前返回 stats）替换为调 insights 函数：

```rust
pub async fn get_insights(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let graph = crate::services::graph::build_graph(&state.db, project_id).await?;
    let surprising = crate::services::graph::find_surprising_connections(&graph, 5);
    let gaps = crate::services::graph::detect_knowledge_gaps(&graph, 8);
    Ok(Json(serde_json::json!({
        "surprisingConnections": surprising,
        "knowledgeGaps": gaps,
    })))
}
```
> 旧 stats（`node_count/edge_count/density`）移除。响应 camelCase 由 `SurprisingConnection`/`KnowledgeGap` 各自的 `#[serde(rename_all = "camelCase")]` 控制——如需加（Task 1 没加），在类型定义补 `#[serde(rename_all = "camelCase")]`。

- [ ] **Step 2: 全工程编译 + 全量非 ignore 测试**

```bash
cd src-server && cargo check 2>&1 | tail -3
cd src-server && cargo test --lib 2>&1 | tail -3
```
Expected: `Finished`；graph 单测全 pass。

- [ ] **Step 3: 重启 server + 手动验证 /insights**

```bash
pkill -f 'target/debug/llm-wiki-server'; sleep 2
cd src-server && nohup cargo run > /tmp/llmwiki_server.log 2>&1 &
# 等 listening (curl /health)
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"<你的 e2e 用户名>","password":"Pass1234!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "http://localhost:8080/api/v1/graph/249/insights" -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json;d=json.load(sys.stdin)
sc=d.get('surprisingConnections',[]); kg=d.get('knowledgeGaps',[])
print(f'surprising: {len(sc)}, gaps: {len(kg)}')
for s in sc[:3]: print(f'  surprise: {s[\"source\"][\"label\"]}–{s[\"target\"][\"label\"]} score={s[\"score\"]}')
for g in kg[:3]: print(f'  gap: [{g[\"type\"]}] {g[\"title\"]}')
"
```
Expected: surprising/gaps 有结果、无 system 标签页、bridge 排序正确。

- [ ] **Step 4: Commit**

```bash
git add src-server/src/routes/graph.rs
git commit -m "feat(src-server): /insights 替换为 surprising connections + knowledge gaps"
```

---

## 验收对照（spec §9）

- [ ] 信号 3 双条件（min≤2 且 max≥maxDegree×0.5）— Task 2 `surprising_peripheral_to_hub_needs_both_conditions`
- [ ] score=2 不入选（`surprising_score_2_not_included`）— Task 2
- [ ] system 排除（`surprising_excludes_system_nodes` + `gaps_exclude_system_nodes`）— Tasks 2/3
- [ ] 三类 gap + 桌面序（`gaps_desktop_order`）— Task 3
- [ ] bridge 按跨社区数 desc — Task 3（`.sort_by(|a,b| b.1.cmp(&a.1))`）
- [ ] /insights 返回 surprisingConnections + knowledgeGaps — Task 4

## 依赖提醒

- 依赖 **2c**（`build_graph` 返回 `WikiGraph`、类型 `GraphNode`/`GraphEdge`/`CommunityInfo` 为 pub）。
- 不依赖 2a/2b。

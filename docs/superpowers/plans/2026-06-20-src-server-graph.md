# src-server Graph API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植桌面知识图谱到 src-server——真 Louvain 社区（自移植 + petgraph）+ 四信号 relevance 边权 + 节点 id=path + 相关节点端点。

**Architecture:** `services/louvain.rs`（新，纯函数 petgraph→社区）+ `services/graph.rs`（重写：RetrievalGraph/四信号/resolve/build_graph 两阶段建边/related_nodes）+ `routes/graph.rs`（加 `/related`）。数据来自 `wiki_pages` 表。

**Tech Stack:** Rust + Axum + SQLx + **petgraph（新依赖）**

**Spec:** `docs/superpowers/specs/2026-06-20-src-server-graph-design.md`（2 轮 review）

---

## 前置条件

- Layer 1（wiki 数据层 + pages CRUD）已实现。
- PG（docker `src-server-postgres-1` @ 5433）在跑；集成测试需已 ingest 的 project（如 249）。
- 集成测试 `#[ignore]` + `cargo test -- --ignored`。
- 现状：`services/graph.rs` 有 `build_graph`（**假社区**、边权 1.0、节点 id=`node_{i}`）；`routes/graph.rs` 有 `/:pid` + `/:pid/insights`。本 plan 重写 graph 服务、新增 louvain 模块、加 related 端点。
- **不依赖 2a/2b**（graph 独立于 embedding/search）。

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src-server/Cargo.toml` | 加 petgraph 依赖 | Modify |
| `src-server/src/services/louvain.rs` | 纯函数 Louvain（petgraph→Vec<usize>）| Create |
| `src-server/src/services/mod.rs` | 声明 louvain 模块 | Modify |
| `src-server/src/services/graph.rs` | RetrievalGraph/四信号/resolve/build_graph/related_nodes | Rewrite |
| `src-server/src/routes/graph.rs` | 加 `GET /:pid/related` | Modify |

---

## Task 1: petgraph 依赖 + louvain 模块脚手架

**Files:**
- Modify: `src-server/Cargo.toml`
- Create: `src-server/src/services/louvain.rs`
- Modify: `src-server/src/services/mod.rs`

- [ ] **Step 1: 加 petgraph 依赖**

在 `src-server/Cargo.toml` 的 `[dependencies]` 节追加：

```toml
petgraph = "0.7"
```

- [ ] **Step 2: 创建 louvain.rs 占位（含签名 + 编译能过）**

`src/services/louvain.rs`：

```rust
// 纯函数 Louvain 社区检测（自移植，无并行）。详见 Task 2 实现。
// 入参：petgraph 无向图（边权 f64）。出参：每个节点（按 NodeIndex 序）的 community id。

use petgraph::graph::Graph;
use petgraph::Undirected;

pub fn louvain(_graph: &Graph<(), f64, Undirected>, _resolution: f64) -> Vec<usize> {
    Vec::new()  // Task 2 实现
}
```

- [ ] **Step 3: 声明模块**

`src/services/mod.rs` 追加一行（与现有 `pub mod graph;` 等同级）：

```rust
pub mod louvain;
```

- [ ] **Step 4: 编译确认（拉取 petgraph）**

```bash
cd src-server && cargo check 2>&1 | tail -5
```
Expected: `Finished`（首次会下载 petgraph）。

- [ ] **Step 5: Commit**

```bash
git add src-server/Cargo.toml src-server/Cargo.lock src-server/src/services/louvain.rs src-server/src/services/mod.rs
git commit -m "chore(src-server): 加 petgraph 依赖 + louvain 模块脚手架"
```

---

## Task 2: Louvain 实现 + 测试

**Files:**
- Modify: `src-server/src/services/louvain.rs`

- [ ] **Step 1: 写失败测试（两自然簇能分开 + 确定性）**

`src/services/louvain.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use petgraph::graph::Graph;

    fn graph_from_edges(n: usize, edges: &[(usize, usize, f64)]) -> Graph<(), f64, Undirected> {
        let mut g = Graph::<(), f64, Undirected>::new_undirected();
        let nodes: Vec<_> = (0..n).map(|_| g.add_node(())).collect();
        for &(s, t, w) in edges {
            g.add_edge(nodes[s], nodes[t], w);
        }
        g
    }

    #[test]
    fn separates_two_clusters() {
        // 簇1={0,1,2} 内部全连；簇2={3,4} 内部连；仅一条簇间边(2-3)
        let g = graph_from_edges(5, &[
            (0,1,1.0),(1,2,1.0),(0,2,1.0),
            (3,4,1.0),
            (2,3,0.1),  // 弱簇间
        ]);
        let c = louvain(&g, 1.0);
        // 0,1,2 同社区；3,4 同社区；两簇不同
        assert_eq!(c[0], c[1]); assert_eq!(c[1], c[2]);
        assert_eq!(c[3], c[4]);
        assert_ne!(c[0], c[3], "{:?} 应分成两簇", c);
    }

    #[test]
    fn deterministic() {
        let g = graph_from_edges(6, &[(0,1,1.0),(1,2,1.0),(2,0,1.0),(3,4,1.0),(4,5,1.0),(5,3,1.0),(2,3,0.2)]);
        let a = louvain(&g, 1.0);
        let b = louvain(&g, 1.0);
        assert_eq!(a, b, "louvain 必须确定性");
    }

    #[test]
    fn empty_and_single() {
        let g0: Graph<(), f64, Undirected> = Graph::new_undirected();
        assert_eq!(louvain(&g0, 1.0), Vec::<usize>::new());
        let mut g1 = Graph::<(), f64, Undirected>::new_undirected();
        g1.add_node(());
        assert_eq!(louvain(&g1, 1.0), vec![0]);
    }

    #[test]
    fn no_edges_each_own_community() {
        // 无边 → 各自独立（重编号 0..n）
        let g = graph_from_edges(3, &[]);
        let c = louvain(&g, 1.0);
        assert_eq!(c.len(), 3);
        assert_eq!(c.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    }
}
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib louvain:: 2>&1 | tail -5
```
Expected: `separates_two_clusters` 等 FAIL（当前返回空 Vec）。

- [ ] **Step 3: 实现 louvain（多级 local-moving + aggregate）**

把 `louvain.rs` 的占位 `pub fn louvain` 整体替换为完整实现：

```rust
use petgraph::graph::Graph;
use petgraph::visit::EdgeRef;
use petgraph::Undirected;
use std::collections::HashMap;

type Adj = Vec<HashMap<usize, f64>>;

fn build_adj(n: usize, edges: &[(usize, usize, f64)]) -> Adj {
    let mut adj: Adj = vec![HashMap::new(); n];
    for &(s, t, w) in edges {
        *adj[s].entry(t).or_insert(0.0) += w;
        if s != t {
            *adj[t].entry(s).or_insert(0.0) += w;
        }
    }
    adj
}

fn degree(adj: &Adj, i: usize) -> f64 {
    // 自环 adj[i][i] 计一次，degree 惯例计 2x
    let self_w = adj[i].get(&i).copied().unwrap_or(0.0);
    adj[i].values().sum::<f64>() + self_w
}

fn graph_weight(adj: &Adj) -> f64 {
    let mut m = 0.0;
    for i in 0..adj.len() {
        for (&j, &w) in &adj[i] {
            if j >= i {
                m += w; // 无向边计一次（i<=j，含自环）
            }
        }
    }
    m
}

fn renumber(comm: &[usize]) -> Vec<usize> {
    let mut map: HashMap<usize, usize> = HashMap::new();
    let mut next = 0usize;
    comm.iter()
        .map(|&c| {
            if !map.contains_key(&c) {
                map.insert(c, next);
                next += 1;
            }
            map[&c]
        })
        .collect()
}

/// 单层 local-moving：返回当前层每个节点的社区（重编号 0..k 连续）。
fn one_level(adj: &Adj, resolution: f64) -> Vec<usize> {
    let n = adj.len();
    if n == 0 {
        return Vec::new();
    }
    let m = graph_weight(adj);
    let two_m = 2.0 * m;
    if two_m == 0.0 {
        return (0..n).collect(); // 无边：各自独立
    }
    let mut comm: Vec<usize> = (0..n).collect();
    let mut sigma_tot: Vec<f64> = (0..n).map(|i| degree(adj, i)).collect();
    let mut improved = true;
    while improved {
        improved = false;
        for i in 0..n {
            let ci = comm[i];
            let ki = degree(adj, i);
            // i 到各邻居社区的权重和
            let mut neighbor_comm: HashMap<usize, f64> = HashMap::new();
            for (&j, &w) in &adj[i] {
                if j == i {
                    continue;
                }
                *neighbor_comm.entry(comm[j]).or_insert(0.0) += w;
            }
            // 先把 i 从当前社区移出
            sigma_tot[ci] -= ki;
            // 留在原地（空社区）gain=0；移入邻居社区 c 的 gain（Blondel，去公共因子 2m）：
            //   gain = k_i_in - resolution * sigma_tot[c] * k_i / (2m)
            let mut best_comm = ci;
            let mut best_gain = 0.0;
            for (&c, &k_i_in) in &neighbor_comm {
                let gain = k_i_in - resolution * sigma_tot[c] * ki / two_m;
                if gain > best_gain + 1e-12 {
                    best_gain = gain;
                    best_comm = c;
                }
            }
            sigma_tot[best_comm] += ki;
            if best_comm != ci {
                comm[i] = best_comm;
                improved = true;
            }
        }
    }
    renumber(&comm)
}

/// Louvain 多级：local-moving → aggregate → 重复直到某层无合并。
pub fn louvain(graph: &Graph<(), f64, Undirected>, resolution: f64) -> Vec<usize> {
    let n = graph.node_count();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }
    let mut edges: Vec<(usize, usize, f64)> =
        graph.edge_references().map(|e| (e.source().index(), e.target().index(), *e.weight())).collect();
    let mut adj = build_adj(n, &edges);
    // 原始节点 → 当前层节点索引（随 aggregate 更新）
    let mut orig_to_layer_node: Vec<usize> = (0..n).collect();

    loop {
        let layer_comm = one_level(&adj, resolution);
        let k = *layer_comm.iter().max().unwrap_or(&0) + 1; // 本层社区数
        if k == adj.len() {
            // 本层无合并 → 收敛。把社区赋给原始节点。
            let result: Vec<usize> = (0..n).map(|orig| layer_comm[orig_to_layer_node[orig]]).collect();
            return renumber(&result);
        }
        // aggregate：新层 k 个节点（社区内边变自环、跨社区边合并）
        let mut new_edges: Vec<(usize, usize, f64)> = Vec::new();
        for i in 0..adj.len() {
            for (&j, &w) in &adj[i] {
                new_edges.push((layer_comm[i], layer_comm[j], w));
            }
        }
        adj = build_adj(k, &new_edges);
        // 更新 orig → 新层节点（= 旧层节点所在社区）
        for orig in 0..n {
            orig_to_layer_node[orig] = layer_comm[orig_to_layer_node[orig]];
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd src-server && cargo test --lib louvain:: 2>&1 | tail -5
```
Expected: 4 个测试 passed。若 `separates_two_clusters` 不过（簇没分开），检查 ΔQ 公式与 `resolution` 默认 1.0，必要时微调。

- [ ] **Step 5: 桌面 graphology 对拍（#[ignore]，可选但推荐）**

在 `louvain.rs` 的 `mod tests` 追加（需手工跑桌面 graphology 拿期望值，标 ignore 避免阻塞 CI）：

```rust
    #[test]
    #[ignore = "需先在桌面跑 graphology-communities-louvain 拿期望划分，再比结构（非数字）"]
    fn matches_desktop_graphology_partition_structure() {
        // 取一个 ~20 节点的图，桌面 graphology louvain(g,{resolution:1}) 得 expected[]。
        // 本测试比"每对节点是否同社区"的结构一致，不比 community id 数字（JS/Rust 编号可能不同）。
        // 实现时：填 expected_partition，断言 partition_structure(louvain(g,1.0)) == partition_structure(expected)。
        // fn partition_structure(comm: &[usize]) -> HashSet<(usize,usize)> { 同社区的所有节点对 }
    }
```

- [ ] **Step 6: Commit**

```bash
git add src-server/src/services/louvain.rs
git commit -m "feat(src-server): louvain 多级社区检测(自移植 petgraph)+ 单测"
```

---

## Task 3: 四信号 relevance（移植 graph-relevance.ts）

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试（四信号各一例 + TYPE_AFFINITY）**

把 `src/services/graph.rs` **整个文件替换**为（含类型 + 四信号，build_graph 在 Task 5 实现）：

```rust
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use crate::AppError;

// ── 四信号权重（桌面 graph-relevance.ts 原值）──
const W_DIRECT_LINK: f64 = 3.0;
const W_SOURCE_OVERLAP: f64 = 4.0;
const W_COMMON_NEIGHBOR: f64 = 1.5;
const W_TYPE_AFFINITY: f64 = 1.0;

/// 类型亲和度矩阵（照搬桌面；新 type 走 default 0.5）。
fn type_affinity(a: &str, b: &str) -> f64 {
    let m = |t: &str| -> std::collections::HashMap<&str, f64> {
        let mut h = std::collections::HashMap::new();
        match t {
            "entity" => { h.insert("concept",1.2); h.insert("entity",0.8); h.insert("source",1.0); h.insert("synthesis",1.0); h.insert("query",0.8); }
            "concept" => { h.insert("entity",1.2); h.insert("concept",0.8); h.insert("source",1.0); h.insert("synthesis",1.2); h.insert("query",1.0); }
            "source" => { h.insert("entity",1.0); h.insert("concept",1.0); h.insert("source",0.5); h.insert("query",0.8); h.insert("synthesis",1.0); }
            "query" => { h.insert("concept",1.0); h.insert("entity",0.8); h.insert("synthesis",1.0); h.insert("source",0.8); h.insert("query",0.5); }
            "synthesis" => { h.insert("concept",1.2); h.insert("entity",1.0); h.insert("source",1.0); h.insert("query",1.0); h.insert("synthesis",0.8); }
            _ => {}
        }
        h
    };
    *m(a).get(b).unwrap_or(&0.5)
}

#[derive(Clone, Default)]
pub(crate) struct RetrievalNode {
    pub id: String,        // path
    pub title: String,
    pub r#type: String,
    pub sources: HashSet<String>,
    pub out_links: HashSet<String>,
    pub in_links: HashSet<String>,
}

pub(crate) struct RetrievalGraph {
    pub nodes: HashMap<String, RetrievalNode>,
}

impl RetrievalGraph {
    fn neighbors(&self, id: &str) -> HashSet<String> {
        let mut s = HashSet::new();
        if let Some(n) = self.nodes.get(id) {
            for x in &n.out_links { s.insert(x.clone()); }
            for x in &n.in_links { s.insert(x.clone()); }
        }
        s
    }
    fn degree(&self, id: &str) -> usize {
        self.neighbors(id).len()
    }
}

/// 四信号相关性（移植 calculateRelevance）。
pub(crate) fn calculate_relevance(a: &RetrievalNode, b: &RetrievalNode, g: &RetrievalGraph) -> f64 {
    if a.id == b.id { return 0.0; }
    // 1. directLink
    let direct = ((a.out_links.contains(&b.id) || b.out_links.contains(&a.id)) as i32 as f64) * W_DIRECT_LINK;
    // 2. sourceOverlap
    let shared = a.sources.intersection(&b.sources).count() as f64 * W_SOURCE_OVERLAP;
    // 3. commonNeighbor (Adamic-Adar)
    let na = g.neighbors(&a.id);
    let nb = g.neighbors(&b.id);
    let mut aa = 0.0;
    for c in na.intersection(&nb) {
        let deg = g.degree(c).max(2) as f64;
        aa += 1.0 / deg.ln();
    }
    let common = aa * W_COMMON_NEIGHBOR;
    // 4. typeAffinity
    let ta = type_affinity(&a.r#type, &b.r#type) * W_TYPE_AFFINITY;
    direct + shared + common + ta
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, t: &str, sources: &[&str], out: &[&str], inl: &[&str]) -> RetrievalNode {
        RetrievalNode {
            id: id.into(), title: id.into(), r#type: t.into(),
            sources: sources.iter().map(|s| s.to_string()).collect(),
            out_links: out.iter().map(|s| s.to_string()).collect(),
            in_links: inl.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn direct_link_signal() {
        let a = node("a", "entity", &[], &["b"], &[]);
        let b = node("b", "entity", &[], &[], &["a"]);
        let g = RetrievalGraph { nodes: [("a".to_string(), a.clone()), ("b".to_string(), b.clone())].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        // direct 3.0 + typeAffinity(entity,entity)=0.8*1.0=0.8；无 source/neighbor
        assert!((r - (3.0 + 0.8)).abs() < 1e-9, "got {}", r);
    }

    #[test]
    fn source_overlap_signal() {
        let a = node("a", "entity", &["s1","s2"], &[], &[]);
        let b = node("b", "concept", &["s2","s3"], &[], &[]);
        let g = RetrievalGraph { nodes: [("a".to_string(), a.clone()), ("b".to_string(), b.clone())].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        // shared{s2}=1 → 4.0；typeAffinity(entity,concept)=1.2；无 direct/neighbor
        assert!((r - (4.0 + 1.2)).abs() < 1e-9, "got {}", r);
    }

    #[test]
    fn common_neighbor_adamic_adar() {
        // a-b 无直连、无共享 source；但共享邻居 c（degree 2 → 1/ln2）
        let a = node("a", "entity", &[], &["c"], &[]);
        let b = node("b", "entity", &[], &["c"], &[]);
        let c = node("c", "entity", &[], &[], &["a","b"]);
        let g = RetrievalGraph { nodes: [("a".into(),a.clone()),("b".into(),b.clone()),("c".into(),c)].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        // commonNeighbor = (1/ln2)*1.5 ≈ 2.164；typeAffinity(entity,entity)=0.8
        let expect = (1.0 / 2f64.ln()) * 1.5 + 0.8;
        assert!((r - expect).abs() < 1e-9, "got {} expect {}", r, expect);
    }

    #[test]
    fn type_affinity_matrix_values() {
        assert!((type_affinity("entity","concept") - 1.2).abs() < 1e-9);
        assert!((type_affinity("source","source") - 0.5).abs() < 1e-9);
        assert!((type_affinity("unknowntype","entity") - 0.5).abs() < 1e-9); // default
    }
}
```

- [ ] **Step 2: 跑确认通过**

```bash
cd src-server && cargo test --lib graph:: 2>&1 | tail -5
```
Expected: 4 个 relevance 测试 passed（注意：此 task 删了旧 build_graph，全工程 `cargo check` 会因 routes/graph.rs 调 build_graph 报错——Task 5 修；本 task 只保证 graph 模块单测过）。

- [ ] **Step 3: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): 四信号 relevance + TYPE_AFFINITY(移植 graph-relevance.ts)"
```

---

## Task 4: resolve_wikilink + stem_to_path 构造

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试（模糊匹配 → path）**

在 `graph.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn resolve_wikilink_fuzzy_to_path() {
        // stem_to_path: 归一化 stem(lowercase+空格→连字符) → path
        let mut s2p = std::collections::HashMap::new();
        s2p.insert("alice".into(), "entities/alice.md".into());
        s2p.insert("project-phoenix".into(), "entities/project-phoenix.md".into());
        // 大小写
        assert_eq!(resolve_wikilink("Alice", &s2p), Some("entities/alice.md".into()));
        // 空格↔连字符
        assert_eq!(resolve_wikilink("Project Phoenix", &s2p), Some("entities/project-phoenix.md".into()));
        // 未命中
        assert_eq!(resolve_wikilink("nonexistent", &s2p), None);
    }

    #[test]
    fn build_stem_to_path_dedup_first() {
        // 重复 stem 取首个（path 不同但 stem 同）
        let paths = vec!["entities/alice.md".to_string(), "concepts/alice.md".to_string()];
        let s2p = build_stem_to_path(&paths);
        assert_eq!(s2p.get("alice"), Some(&"entities/alice.md".to_string()));
    }
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib graph::tests::resolve_wikilink graph::tests::build_stem_to_path 2>&1 | tail -3
```
Expected: 编译失败（`resolve_wikilink`/`build_stem_to_path` 未定义）。

- [ ] **Step 3: 实现 resolve_wikilink + build_stem_to_path**

在 `calculate_relevance` 之后追加：

```rust
/// 归一化 stem/raw：小写 + 空格→连字符。
fn normalize_stem(s: &str) -> String {
    s.to_lowercase().replace(' ', "-")
}

/// 从 path 提取 stem：最后一个 '/' 之后、".md" 之前。
fn path_stem(path: &str) -> &str {
    let last = path.rsplit('/').next().unwrap_or(path);
    last.trim_end_matches(".md")
}

/// 构造 stem_to_path：归一化 stem → path；重复 stem 取首个（§11 #6）。
pub(crate) fn build_stem_to_path(paths: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for p in paths {
        let key = normalize_stem(path_stem(p));
        if map.contains_key(&key) {
            tracing::warn!("dup stem {} (keep first: {:?}, dropped: {})", key, map.get(&key), p);
        } else {
            map.insert(key, p.clone());
        }
    }
    map
}

/// [[X]] → path：归一化 raw 后查 stem_to_path。
pub(crate) fn resolve_wikilink(raw: &str, stem_to_path: &HashMap<String, String>) -> Option<String> {
    stem_to_path.get(&normalize_stem(raw.trim())).cloned()
}
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib graph::tests::resolve_wikilink graph::tests::build_stem_to_path 2>&1 | tail -3
```
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): resolve_wikilink + stem_to_path 构造(模糊匹配/冲突取首个)"
```

---

## Task 5: build_graph 重写（两阶段建边 + Louvain + relevance 边权）+ 集成测试

**Files:**
- Modify: `src-server/src/services/graph.rs`
- Create: `src-server/tests/graph_integration.rs`

- [ ] **Step 1: 在 graph.rs 追加类型 + build_graph + 相关函数**

在 `resolve_wikilink` 之后追加（WikiGraph 等响应类型 + build_graph 主流程 + related_nodes；Task 6 用 related_nodes）：

```rust
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,        // path
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub path: String,
    #[serde(rename = "linkCount")]
    pub link_count: i32,
    pub community: usize,
}

#[derive(Serialize, Clone)]
pub struct GraphEdge {
    pub source: String,    // path
    pub target: String,    // path
    pub weight: f64,       // relevance
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommunityInfo {
    pub id: usize,
    pub node_count: usize,
    pub cohesion: f64,
    pub top_nodes: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct WikiGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub communities: Vec<CommunityInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNode {
    pub path: String,
    pub title: String,
    pub relevance: f64,
}

/// 项目级缓存：(project_id, max_updated_at) → WikiGraph
static GRAPH_CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<(i32, i64), WikiGraph>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(sqlx::FromRow)]
struct WikiPageRow {
    path: String,
    title: String,
    page_type: Option<String>,
    content: Option<String>,
    sources: Option<serde_json::Value>,
}

/// [[X]] 提取（移植桌面 regex，target 不 resolve）。
fn extract_wikilinks(content: &str) -> Vec<String> {
    let re = regex_lite::Regex::new(r"\[\[([^\]|\n]+?)(?:\|[^\]]+)?\]\]").unwrap();
    re.captures_iter(content).map(|c| c.get(1).unwrap().as_str().trim().to_string()).collect()
}

fn sources_from_json(v: &Option<serde_json::Value>) -> HashSet<String> {
    v.as_ref().and_then(|x| x.as_array()).map(|arr| {
        arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
    }).unwrap_or_default()
}

/// 主入口：从 wiki_pages 构建图谱（真 Louvain + relevance 边权 + node id=path + 过滤 query）。
pub async fn build_graph(pool: &PgPool, project_id: i32) -> Result<WikiGraph, AppError> {
    // 缓存键 = max(updated_at)
    let max_ts: Option<i64> = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM COALESCE(MAX(updated_at), TIMESTAMPTZ '1970-01-01'))::BIGINT \
         FROM wiki_pages WHERE project_id = $1"
    ).bind(project_id).fetch_optional(pool).await.map_err(AppError::DatabaseError)?.flatten();
    let cache_ts = max_ts.unwrap_or(0);
    if let Ok(cache) = GRAPH_CACHE.lock() {
        if let Some(g) = cache.get(&(project_id, cache_ts)) {
            return Ok(g.clone());
        }
    }

    let pages: Vec<WikiPageRow> = sqlx::query_as::<_, WikiPageRow>(
        "SELECT path, COALESCE(title,'') AS title, page_type, content, sources \
         FROM wiki_pages WHERE project_id = $1 AND COALESCE(page_type,'') != 'query'"
    ).bind(project_id).fetch_all(pool).await.map_err(AppError::DatabaseError)?;

    if pages.is_empty() {
        let empty = WikiGraph { nodes: vec![], edges: vec![], communities: vec![] };
        return Ok(empty);
    }

    let paths: Vec<String> = pages.iter().map(|p| p.path.clone()).collect();
    let stem_to_path = build_stem_to_path(&paths);
    let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i,p)| (p.clone(), i)).collect();

    // 3a. 占位无向边（weight=1.0）+ wikilinks
    let mut adj_out: Vec<HashSet<String>> = pages.iter().map(|_| HashSet::new()).collect();
    let mut placeholder_edges: Vec<(String, String)> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    for p in &pages {
        let content = p.content.as_deref().unwrap_or("");
        for raw in extract_wikilinks(content) {
            let tgt = match resolve_wikilink(&raw, &stem_to_path) { Some(t) => t, None => continue };
            if tgt == p.path { continue; }
            let key = if &p.path < &tgt { (p.path.clone(), tgt.clone()) } else { (tgt.clone(), p.path.clone()) };
            if seen_edges.contains(&key) { continue; }
            seen_edges.insert(key);
            placeholder_edges.push((p.path.clone(), tgt.clone()));
            let si = path_index[&p.path]; let ti = path_index[&tgt];
            adj_out[si].insert(tgt.clone());
        }
    }
    // 3b. 反填 inLinks → 完成 RetrievalGraph
    let mut rnodes: HashMap<String, RetrievalNode> = HashMap::new();
    for p in &pages {
        let i = path_index[&p.path];
        let mut in_links: HashSet<String> = HashSet::new();
        // 反向遍历占位边
        for (s, t) in &placeholder_edges {
            if t == &p.path { in_links.insert(s.clone()); }
        }
        rnodes.insert(p.path.clone(), RetrievalNode {
            id: p.path.clone(), title: p.title.clone(),
            r#type: p.page_type.clone().unwrap_or_else(|| "other".into()),
            sources: sources_from_json(&p.sources),
            out_links: adj_out[i].clone(),
            in_links,
        });
    }
    let rgraph = RetrievalGraph { nodes: rnodes };

    // 4. 算 relevance 替换 weight
    let mut edges: Vec<GraphEdge> = placeholder_edges.iter().map(|(s, t)| {
        let a = rgraph.nodes.get(s).unwrap();
        let b = rgraph.nodes.get(t).unwrap();
        GraphEdge { source: s.clone(), target: t.clone(), weight: calculate_relevance(a, b, &rgraph) }
    }).collect();

    // 6. petgraph + Louvain
    let mut pg = petgraph::graph::Graph::<(), f64, petgraph::Undirected>::new_undirected();
    let pg_nodes: Vec<_> = (0..pages.len()).map(|_| pg.add_node(())).collect();
    let pi = |path: &str| pg_nodes[path_index[path]];
    for e in &edges {
        pg.add_edge(pi(&e.source), pi(&e.target), e.weight);
    }
    let comm = crate::services::louvain::louvain(&pg, 1.0); // 按 pg 节点序

    // 7. 社区 info + 重编号。按社区大小降序处理，保证 communities[k] 与 id_remap 对齐
    //    （避免 HashMap 迭代非确定性致 ties 错位）。
    let mut groups_vec: Vec<(usize, Vec<usize>)> = {
        let mut m: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, &c) in comm.iter().enumerate() { m.entry(c).or_default().push(i); }
        m.into_iter().collect()
    };
    groups_vec.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    let edge_pair: HashSet<(String, String)> = edges.iter().map(|e| {
        if e.source < e.target { (e.source.clone(), e.target.clone()) } else { (e.target.clone(), e.source.clone()) }
    }).collect();
    let mut communities: Vec<CommunityInfo> = Vec::new();
    let mut id_remap: HashMap<usize, usize> = HashMap::new();
    for (new_id, (old_label, members)) in groups_vec.iter().enumerate() {
        id_remap.insert(*old_label, new_id);
        let n = members.len();
        let possible = if n > 1 { n * (n - 1) / 2 } else { 1 }; // n=1 → cohesion=0 防 NaN
        let mut intra = 0;
        for a in 0..n {
            for b in (a + 1)..n {
                let pa = &pages[members[a]].path;
                let pb = &pages[members[b]].path;
                let key = if pa < pb { (pa.clone(), pb.clone()) } else { (pb.clone(), pa.clone()) };
                if edge_pair.contains(&key) { intra += 1; }
            }
        }
        let cohesion = intra as f64 / possible as f64;
        // topNodes：按 linkCount(in+out) 降序取 top5
        let mut lc: Vec<(usize, i32)> = members.iter().map(|&i| {
            let p = &pages[i];
            let deg = adj_out[path_index[&p.path]].len() as i32
                + edges.iter().filter(|e| e.target == p.path).count() as i32;
            (i, deg)
        }).collect();
        lc.sort_by(|a, b| b.1.cmp(&a.1));
        let top_nodes: Vec<String> = lc.iter().take(5).map(|(i, _)| pages[*i].title.clone()).collect();
        communities.push(CommunityInfo { id: new_id, node_count: n, cohesion, top_nodes });
    }

    let mut nodes: Vec<GraphNode> = pages.iter().enumerate().map(|(i, p)| {
        let deg = adj_out[i].len() as i32 + edges.iter().filter(|e| e.target == p.path).count() as i32;
        GraphNode {
            id: p.path.clone(), label: p.title.clone(),
            node_type: p.page_type.clone().unwrap_or_else(|| "other".into()),
            path: p.path.clone(), link_count: deg,
            community: id_remap[&comm[i]],
        }
    }).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| (&a.source, &a.target).cmp(&(&b.source, &b.target)));

    let graph = WikiGraph { nodes, edges, communities };
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.retain(|&(pid, _), _| pid != project_id);
        cache.insert((project_id, cache_ts), graph.clone());
    }
    Ok(graph)
}
```

- [ ] **Step 2: 写 #[ignore] 集成测试**

`src/tests/graph_integration.rs`：

```rust
// 需 PG(project 249 已 ingest)。cargo test --test graph_integration -- --ignored
#![cfg(test)]
use llm_wiki_server::services::graph;

#[tokio::test]
#[ignore = "requires PG with ingested project 249"]
async fn build_graph_assigns_communities_and_relevance_weights() {
    let cfg = llm_wiki_server::AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(cfg.database_url()).await.unwrap();
    let g = graph::build_graph(&pool, 249).await.unwrap();
    assert!(!g.nodes.is_empty(), "project 249 应有 wiki 页");
    assert!(g.nodes.iter().all(|n| n.id == n.path), "node id 应=path");
    // 边权非全 1.0（relevance 生效）
    let all_one = g.edges.iter().all(|e| (e.weight - 1.0).abs() < 1e-9);
    assert!(!all_one || g.edges.is_empty(), "边权应为 relevance（非全 1.0）: {:?}", g.edges.iter().map(|e| e.weight).collect::<Vec<_>>());
    // 单节点社区 cohesion=0（无 NaN）
    assert!(g.communities.iter().all(|c| c.cohesion.is_finite()));
}
```

- [ ] **Step 3: 全工程编译确认**

```bash
cd src-server && cargo check 2>&1 | tail -5
```
Expected: `Finished`（build_graph 已重建，routes/graph.rs 调它应通过）。

- [ ] **Step 4: 跑 --ignored + 单测确认**

```bash
cd src-server && cargo test --lib graph:: 2>&1 | tail -3
cd src-server && cargo test --test graph_integration -- --ignored 2>&1 | tail -5
```
Expected: graph 单测全 pass；集成测试 pass（前提 project 249 已 ingest）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs src-server/tests/graph_integration.rs
git commit -m "feat(src-server): build_graph 重写(两阶段建边+真 Louvain+relevance 边权+node id=path)"
```

---

## Task 6: related_nodes（邻边按 relevance top-N）

**Files:**
- Modify: `src-server/src/services/graph.rs`

- [ ] **Step 1: 写失败测试**

在 `graph.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn related_nodes_sorted_by_weight_topn() {
        let g = WikiGraph {
            nodes: vec![
                GraphNode { id: "a".into(), label: "A".into(), node_type: "entity".into(), path: "a".into(), link_count: 0, community: 0 },
            ],
            edges: vec![
                GraphEdge { source: "a".into(), target: "b".into(), weight: 0.5 },
                GraphEdge { source: "c".into(), target: "a".into(), weight: 3.0 },
                GraphEdge { source: "a".into(), target: "d".into(), weight: 1.2 },
                GraphEdge { source: "x".into(), target: "y".into(), weight: 9.0 }, // 无关
            ],
            communities: vec![],
        };
        let r = related_nodes(&g, "a", 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].path, "c"); // weight 3.0 最高
        assert_eq!(r[1].path, "d"); // 1.2 次之
    }
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib graph::tests::related_nodes 2>&1 | tail -3
```
Expected: 编译失败（`related_nodes` 未定义）。

- [ ] **Step 3: 实现 related_nodes**

在 `build_graph` 之后追加：

```rust
/// 相关节点：path 的邻边按 weight desc 取 top-N。需 title，从 nodes 查。
pub fn related_nodes(graph: &WikiGraph, path: &str, limit: usize) -> Vec<RelatedNode> {
    let title_of: HashMap<&str, &str> = graph.nodes.iter().map(|n| (n.id.as_str(), n.label.as_str())).collect();
    let mut hits: Vec<(String, f64)> = graph.edges.iter()
        .filter_map(|e| {
            if e.source == path { Some((e.target.clone(), e.weight)) }
            else if e.target == path { Some((e.source.clone(), e.weight)) }
            else { None }
        })
        .collect();
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().take(limit).map(|(p, w)| RelatedNode {
        title: title_of.get(p.as_str()).map(|s| s.to_string()).unwrap_or_else(|| p.clone()),
        path: p, relevance: w,
    }).collect()
}
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib graph::tests::related_nodes 2>&1 | tail -3
```
Expected: passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/graph.rs
git commit -m "feat(src-server): related_nodes 邻边按 relevance desc top-N"
```

---

## Task 7: routes/graph.rs 加 /related + 手动验证

**Files:**
- Modify: `src-server/src/routes/graph.rs`

- [ ] **Step 1: 加 related handler + 路由**

把 `src/routes/graph.rs` 的 `graph_routes()` 改为加一行路由，并新增 `get_related`：

```rust
pub fn graph_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:project_id", axum::routing::get(get_graph))
        .route("/:project_id/insights", axum::routing::get(get_insights))
        .route("/:project_id/related", axum::routing::get(get_related))
}

#[derive(serde::Deserialize)]
pub struct RelatedQuery {
    pub path: String,
    pub limit: Option<usize>,
}

pub async fn get_related(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
    axum::extract::Query(q): axum::extract::Query<RelatedQuery>,
) -> Result<Json<Vec<crate::services::graph::RelatedNode>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let g = crate::services::graph::build_graph(&state.db, project_id).await?;
    if !g.nodes.iter().any(|n| n.id == q.path) {
        return Err(AppError::ResourceNotFound("page not in graph".into()));
    }
    let limit = q.limit.unwrap_or(10).min(50);
    Ok(Json(crate::services::graph::related_nodes(&g, &q.path, limit)))
}
```

（`get_graph`/`get_insights` 保留不动；`Json`/`Path`/`State` 已在文件顶部 use。）

- [ ] **Step 2: 全工程编译 + 全量非 ignore 测试**

```bash
cd src-server && cargo check 2>&1 | tail -3
cd src-server && cargo test --lib 2>&1 | tail -3
```
Expected: `Finished`；lib 测试全 pass。

- [ ] **Step 3: 重启 server + 手动验证 /graph + /related**

```bash
pkill -f 'target/debug/llm-wiki-server'; sleep 2
cd src-server && nohup cargo run > /tmp/llmwiki_server.log 2>&1 &
# 等 listening
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"<你的 e2e 用户名>","password":"Pass1234!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "=== /graph ==="; curl -s "http://localhost:8080/api/v1/graph/249" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin);print('nodes',len(d['nodes']),'edges',len(d['edges']),'communities',len(d['communities']));print('sample edge weight',d['edges'][0]['weight'] if d['edges'] else None)"
echo "=== /related ==="; curl -s "http://localhost:8080/api/v1/graph/249/related?path=entities/alice.md&limit=5" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -15
```
Expected: /graph 返回 nodes/edges/communities，边 weight 非 1.0；/related 返回 alice 的相关页按 relevance 排序。

- [ ] **Step 4: Commit**

```bash
git add src-server/src/routes/graph.rs
git commit -m "feat(src-server): GET /:pid/related 相关节点端点"
```

---

## 验收对照（spec §12）

- [ ] louvain 5 节点 ΔQ + 两簇分开 — Task 2
- [ ] calculate_relevance 四信号 — Task 3
- [ ] resolve_wikilink 模糊匹配 — Task 4
- [ ] build_graph 节点 id=path、边 source/target=path、weight=relevance、过滤 query — Task 5
- [ ] 单节点社区 cohesion=0 — Task 5
- [ ] /related 邻边按 relevance top-N — Task 6/7
- [ ] 缓存命中（max(updated_at) 未变不重建）— Task 5

## 依赖提醒

- **petgraph** 是新依赖（Task 1 加）。
- **不依赖 2a/2b**（graph 独立）。
- Louvain 自移植（Task 2）是核心；若 `separates_two_clusters` 不过，先核 ΔQ 公式 + resolution=1.0；桌面 graphology 对拍（Task 2 Step 5）是最终正确性门。

# src-server Graph API 设计（Layer 2c）

> **状态**：设计确认（2026-06-20，已并入 review 反馈）| **依赖**：Layer 1（wiki 数据层 + pages CRUD）
>
> **范围**：移植桌面图谱到 src-server——`wiki-graph` 构建（wikilink 边 + 四信号 relevance 边权）+ 真正的 Louvain 社区检测（自移植、petgraph）+ 相关节点端点。insights（惊喜连接/知识缺口）是 **2d**，不在本 spec。

---

## 1. 背景与目标

桌面 `wiki-graph.ts::buildWikiGraph` + `graph-relevance.ts` 实现了成熟的知识图谱：wikilink 边、四信号相关性边权、Louvain 社区、cohesion/topNodes。src-server `services/graph.rs` 现有 build_graph 但**社区检测是假的**（按 page_type 分组）、**无四信号 relevance**（边权恒 1.0）、**无 source 信号**、节点 id 是位置序号 `"node_{i}"`。

本层目标：
- **真正的 Louvain**（自移植，petgraph，替换假社区）
- **四信号 relevance 边权**（移植 graph-relevance.ts）
- **节点 id = path**（DB 唯一、全链路一致，改进而非偏离桌面 stem）
- **相关节点端点**（零成本：读已算边权）
- `type=query` 节点过滤（对齐桌面）

### 现状核实（已查证）

| 项 | 桌面 | src-server 现状 |
|----|------|----------------|
| 社区检测 | Louvain（graphology lib, resolution=1）| **假**：按 page_type 分组、cohesion=1/n |
| 边权 | 四信号 relevance | 恒 1.0 |
| source 信号 | frontmatter sources 共享 | 未取 |
| 节点 id | 文件名 stem | `"node_{i}"` 位置序号 |
| 过滤 | type=query 不入图 | 无过滤 |
| 缓存 | — | by `(project_id, max(updated_at))` ✓ 沿用 |
| routes | — | `GET /:pid`（图）+ `GET /:pid/insights`（统计占位）|

---

## 2. 关键决策（已与用户确认 + review 修订）

| 决策 | 选择 | 理由 |
|------|------|------|
| Louvain 实现 | **自移植到 Rust**（petgraph 入参）| 零依赖风险、与桌面 graphology 同算法可对齐、wiki 规模性能够 |
| 节点 id | **path**（非桌面 stem）| DB 唯一、与 search/embeddings/pages 全链路一致；桌面用 stem 纯粹因无 DB path |
| 四信号 scope | **边权 + 相关节点端点** | 边权在 build 阶段算好；related 端点零成本读边；与 2d（全局挖结构）边界清晰 |
| 缓存 | **by max(updated_at)** | 沿用现有；wiki_pages 变更自动失效 |

---

## 3. 桌面 → 服务端移植差异

| | 桌面 | 服务端 |
|---|------|--------|
| 数据源 | 扫 wiki/*.md 文件 | 查 `wiki_pages` 表（path/title/page_type/content/sources）|
| 节点 id | 文件名 stem（会冲突，需 keep_best_match）| **path**（UNIQUE 约束消除冲突）|
| 边 source/target | stem | **path**（= 节点 id）|
| wikilink resolve target | stem | **path**（resolve 逻辑同桌面模糊匹配，仅最后一步 target 换 path）|
| 向量/图库 | graphology（JS）| **petgraph**（Rust，新依赖）|

> 节点 id=path 是结构性决策：edges 的 source/target 也都是 path（= 节点 id），前端 sigma.js 用 node.id 做键、node.path 导航，id=path 两用。

---

## 4. 数据流（build_graph）—— 两阶段建边（关键）

```
GET /api/v1/graph/:project_id
  1. 查 wiki_pages(path,title,page_type,content,sources) WHERE project_id AND page_type != 'query'
  2. 提取 [[wikilinks]] → resolve_wikilink([[X]]) → path（模糊匹配 stem/title，target=path）
  3a. 建无向占位边（去重，weight=1.0 占位）+ node.linkCount(in+out)
  3b. 由占位边反填 inLinks：对每条 A→B，把 A 加进 B.inLinks → 完成 RetrievalGraph
       （outLinks 已在 3a 由 wikilinks 直接得到；inLinks 需反向遍历边）
  4. 对每条边算 calculate_relevance(A,B,RetrievalGraph) → 替换 weight（四信号真值）
  5. （relevance 一般 >0；若某边算出 0 可选过滤）
  6. 建 petgraph::Graph<(), f64, Undirected>（边权=relevance）→ louvain(resolution=1.0) → community/path
  7. 社区 info：cohesion = intra_edges / possible_edges；
       **intra_edges = 两端点(source/target)均属本社区的无向边数（计数，非边权和）**；
       possible_edges = n>1 ? n(n-1)/2 : 1（**n=1 → cohesion=0 防 NaN**）；
       topNodes = 按 linkCount top5；重编号 0,1,2...
  8. 缓存 by (project_id, max(wiki_pages.updated_at))
  → {nodes[id=path], edges[source=path,target=path,weight=relevance], communities}
```

> **两阶段建边**（review #1）：inLinks 依赖边结构、relevance 又依赖 RetrievalGraph——必须先建占位边(weight=1) → 反填 inLinks 完成 RetrievalGraph → 再算 relevance 替换 weight。顺序不能乱。

---

## 5. API 契约

| 端点 | 返回 |
|------|------|
| `GET /api/v1/graph/:project_id` | `{nodes:[{id,label,type,path,linkCount,community}], edges:[{source,target,weight}], communities:[{id,nodeCount,cohesion,topNodes}]}` |
| `GET /api/v1/graph/:project_id/related?path=<p>&limit=<n>`（**新**）| `[{path,title,relevance}]` —— 该节点邻边按 weight desc 排序 top-N（零成本：读已算边权）|
| `GET /api/v1/graph/:project_id/insights` | 暂保持统计占位；**真 insights 是 2d** |

- `node.id = path`；`path` 字段冗余保留（shape 兼容）。
- `edge.source/target = path`（= 节点 id）。
- `edge.weight = relevance`（四信号分，非 1.0）。
- related 的 `path` query 参数与 pages CRUD 的 `?path=` 一致；URL 编码（`entities%2Falice.md`）axum Query 自动处理。

---

## 6. 组件改动

### 6.1 `services/louvain.rs`（新建，纯函数 + 无并行）

```rust
/// Louvain 社区检测。入参 petgraph 无向图（边权 f64），出参每个节点的 community id
/// （按 petgraph 节点索引序）。resolution: 桌面 graphology 用 1.0。
/// 两阶段迭代（local moving + aggregate）直到 ΔQ 无增益。单线程（几百节点 ms 级）。
pub fn louvain(
    graph: &petgraph::graph::Graph<(), f64, petgraph::Undirected>,
    resolution: f64,
) -> Vec<usize>;
```
调用方负责 petgraph 节点索引 ↔ path 映射。petgraph 成为新依赖（2a/2b Cargo.toml 无，需新增）。

### 6.2 `services/graph.rs`（重写）

移植 `graph-relevance.ts`：
```rust
struct RetrievalNode {
    id: String,             // path
    title: String, r#type: String,
    sources: HashSet<String>,
    out_links: HashSet<String>, in_links: HashSet<String>,
}
struct RetrievalGraph { nodes: HashMap<String, RetrievalNode> }

fn build_retrieval_graph(pages, edges_placeholder) -> RetrievalGraph;  // out_links 来自 wikilinks，in_links 反填自占位边
fn calculate_relevance(a: &RetrievalNode, b: &RetrievalNode, g: &RetrievalGraph) -> f64;
fn resolve_wikilink(raw: &str, stem_to_path: &HashMap<String,String>) -> Option<String>;
// stem_to_path 构造（build_graph 启动时一次，所有 page）：
//   for path in pages:
//     stem = path.rsplit('/').next().trim_end_matches(".md")          // entities/alice.md → "alice"
//     key  = stem.to_lowercase().replace(' ', "-")                     // 归一化：小写 + 空格→连字符
//     if stem_to_path.contains_key(&key) { warn("dup stem, keep first") }   // §11 #6 冲突取首个
//     else { stem_to_path.insert(key, path); }
//   resolve_wikilink(raw): key = raw.to_lowercase().replace(' ', "-") → stem_to_path.get(&key).cloned()
```
- `build_graph(pool, project_id)`：§4 数据流 8 步；node id=path、过滤 type=query、真 Louvain、relevance 边权、cohesion（n=1→0）、重编号、缓存。
- `related_nodes(graph: &WikiGraph, path: &str, limit: usize) -> Vec<RelatedNode>`：遍历 edges（source==path 或 target==path）→ 取对端 → 按 weight desc → take limit。

### 6.3 `routes/graph.rs`

加 `GET /:project_id/related`（`Query{path, limit}`）；`/:project_id` + `/:project_id/insights` 保留。

---

## 7. 四信号 relevance（移植 graph-relevance.ts）

```
calculate_relevance(A, B, g):
  directLink     = (A.out_links∋B.id || B.out_links∋A.id ? 1 : 0) × 3.0
  sourceOverlap  = |A.sources ∩ B.sources| × 4.0
  commonNeighbor = Σ_{n ∈ (neighbors(A) ∩ neighbors(B))} 1/ln(max(degree(n), 2)) × 1.5   // Adamic-Adar
  typeAffinity   = TYPE_AFFINITY[A.type][B.type]（缺省 0.5）× 1.0
  return directLink + sourceOverlap + commonNeighbor + typeAffinity

neighbors(n) = n.out_links ∪ n.in_links；degree(n) = |neighbors(n)|
TYPE_AFFINITY 矩阵照搬桌面（entity/concept/source/synthesis/query 互权重）。
```

---

## 8. Louvain 实现 + 测试

- petgraph::Graph<(), f64, Undirected> 入参；resolution 参数（默认 1.0）。
- 标准两阶段：① 每节点尝试移到邻居社区使 modularity ΔQ 最大，直到一轮无移动 ② aggregate 同社区节点为大节点，重复直到层数稳定。
- 单线程，输出 `Vec<usize>`（petgraph 节点索引序）。
- **测试**：
  - 5 节点小图手算 ΔQ 公式对拍（modularity 单调不减不变量）+ 确定性（同输入同输出）。
  - 两自然簇（如 {a,b,c} 内部全连、{d,e} 内部连、仅一条簇间边）→ 能被分开成 2 社区。
  - **桌面 graphology 对拍**：同一图喂两边，比 **partition 结构**（每对节点是否同社区），**不比 community id 数字**（JS/Rust 编号可能不同）；或两边都按社区大小降序重编号后再比。

---

## 9. 缓存 + 错误处理

- **缓存**：`(project_id, max(updated_at))`（沿用）；wiki_pages 变更 → updated_at 变 → 自动失效。
- **空图**（无 wiki 页 / 全是 query 类型）：空 nodes/edges/communities。
- **小图**（<2 节点）：Louvain 平凡（全一社区）；related 无邻边→空。
- **related path 不存在**：404。
- Louvain/relevance 纯计算不抛错；仅 wiki_pages 查询可能 DB 错→500。

---

## 10. 测试策略

**单元（CI 可跑）**：
- `louvain`：5 节点 ΔQ 正确性 + 确定性 + 两簇分离（§8）。
- `calculate_relevance`：四信号各一例（directLink / sourceOverlap / commonNeighbor / typeAffinity）+ TYPE_AFFINITY 值。
- `resolve_wikilink`：`[[Alice]]` / `[[alice]]` / `[[Alice Bob]]` → path（大小写/连字符容错）。
- `related_nodes`：邻边按 weight desc top-N。
- `cohesion`：单节点社区 = 0（防 NaN）。

**集成（`#[ignore]`，PG + 已 ingest project 249）**：GET /graph → communities 已分配、edge weight ∈ relevance 范围（非全 1.0）；GET /related?path=entities/alice.md → bob/acme 等在 top。

---

## 11. 已知限制 / 范围边界

1. **Louvain 自移植**（petgraph 依赖，~150 行 + ΔQ 单测）。
2. **related = 本地邻边遍历**（读已算边权）；**全局惊喜连接/知识缺口是 2d**（挖结构、需新算法），边界清晰。
3. **type=query 节点过滤**（对齐桌面）。
4. **节点 id=path**（桌面 stem 的改进）。
5. **/insights 暂为统计占位**（2d 重做）。
6. **stem 冲突**：UNIQUE(project_id,path) 消除 path 冲突；但 `[[X]]` 若匹配多个 path（同名 stem），取首个 + warn（沿用桌面 keep_best_match 语义）。
7. **TYPE_AFFINITY 矩阵硬编码**（照搬桌面值）：ingest 若新增 page type 需同步更新矩阵，否则新 type 走 default 0.5。

---

## 12. 验收标准

- [ ] `louvain` 5 节点 ΔQ 公式正确 + 两自然簇能分开
- [ ] `calculate_relevance` 四信号各例符合公式
- [ ] `resolve_wikilink` 大小写/连字符容错 → path
- [ ] `build_graph` 节点 id=path、边 source/target=path、weight=relevance（非全 1）、过滤 type=query
- [ ] 单节点社区 cohesion=0（无 NaN）
- [ ] `GET /related?path=...` 返回邻边按 relevance desc top-N
- [ ] 缓存命中：同 project 两次请求，第二次不重建（max(updated_at) 未变）

---

## 13. 与前后层关系

- **1（wiki 数据层）**：提供 wiki_pages（path/title/page_type/content/sources）。
- **2a/2b（embedding/search）**：独立，2c 不依赖它们。
- **2d（insights）**：消费 2c 的 graph + relevance 做全局惊喜连接/知识缺口。

---

## 附录：review 反馈落实记录（2026-06-20）

| # | review 问题 | 落实 |
|---|------------|------|
| 1 | RetrievalGraph 鸡生蛋（inLinks 依赖边、relevance 依赖 RetrievalGraph）| §4 改两阶段建边：占位边(weight=1)→反填 inLinks→算 relevance 替换 weight |
| 2 | edge source/target 未说明也变 path | §3/§5 明确 edge source/target = path（= 节点 id）|
| 3 | cohesion 单节点 NaN | §4 step7 + §10：n=1 → cohesion=0（possible_edges=n>1?n(n-1)/2:1）|
| 4 | Louvain 对拍 community id 编号差异 | §8：比 partition 结构或两边按大小重编号，不比数字 |
| 5 | TYPE_AFFINITY 硬编码 | §11 #7：新 page type 需同步矩阵否则走 default 0.5 |

### round 2（2026-06-20）

| # | 复查问题 | 落实 |
|---|---------|------|
| 6 | stem_to_path 构造算法未定义（resolve_wikilink 无法实现）| §6.2 补构造：path→stem→归一化(小写+空格→连字符)为 key、冲突取首个+warn；resolve 同归一化查表 |
| 7 | intra_edges 在 cohesion 公式未定义（计数还是权和？）| §4 step7 明确：两端点同属本社区的无向边**计数**（非权和），与 possible_edges 同量纲 → cohesion∈[0,1] |

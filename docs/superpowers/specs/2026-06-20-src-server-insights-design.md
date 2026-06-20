# src-server Graph Insights 设计（Layer 2d）

> **状态**：设计确认（2026-06-20）| **依赖**：Layer 2c（graph API——`build_graph` 产出 nodes/edges/communities + cached）
>
> **范围**：移植桌面 `graph-insights.ts` 到 src-server——惊喜连接（surprising connections）与知识缺口（knowledge gaps）的纯计算分析。无 LLM、无额外 DB 查询。本 spec 是 Layer 2 的最后一块。

---

## 1. 背景与目标

桌面 `src/lib/graph-insights.ts`（193 行）在已构建的图谱（nodes/edges/communities）上运行纯计算分析，产出两类洞察：

- **惊喜连接**：4 信号打分——跨社区/跨类型/边缘↔枢纽/弱边——揭露"不该连却连了"的有趣边
- **知识缺口**：3 类——孤立节点/稀疏社区/桥节点——指出知识图谱的结构薄弱点

src-server 的 `/insights` 端点目前只返回 `{node_count, edge_count, density}` 统计（占位）。本层替换为真正的 insights。

### 桌面参考（已查证）

`src/lib/graph-insights.ts`（193 行）。核心算法见 §3/§4。

---

## 2. 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 计算方式 | **纯计算移植**（无 LLM）| 桌面即是纯计算；LLM 成本高、非必要 |
| 数据源 | **2c `build_graph` 产出（cached）** | 零新 DB 查询、零新基础设施 |
| 结构页排除 | **`node_type.to_lowercase() == "system"`** | 2c rebuild_reserved 给 index/log/overview 设 page_type='system'；case-insensitive（实测有 "system"/"System" 混用）|
| 类型谱系 | **移植原算法 + 标注风险**（graceful degradation）| 见 §8 #1 |
| API | 替换 `/insights` stats 占位 | 前端无消费方依赖旧 stats |

---

## 3. 惊喜连接（find_surprising_connections）

移植桌面。每条边打分（排除 `node_type == "system"` 的节点），**四信号**：

| # | 信号 | 条件 | 得分 | reason |
|---|------|------|------|--------|
| 1 | 跨社区 | `source.community != target.community` | **+3** | "crosses community boundary" |
| 2a | 跨类型（distant pair）| `source.type != target.type` 且 pair ∈ {source-concept, concept-source, source-synthesis, synthesis-source, query-entity, entity-query} | **+2** | "connects {s.type} to {t.type}" |
| 2b | 跨类型（其它）| `source.type != target.type` 且 pair 不在 distant set | **+1** | "different types" |
| 3 | 边缘↔枢纽 | **双条件**：`min(deg_s, deg_t) ≤ 2` **且** `max(deg_s, deg_t) ≥ maxDegree × 0.5`（maxDegree = 全局最大 linkCount）| **+2** | "peripheral node links to hub" |
| 4 | 弱边 | `0 < edge.weight < 2`（低 relevance）| **+1** | "weak but present connection" |

- 入选：**`score ≥ 3 且 reasons 非空`**
- 按 score desc 排序，取 top `limit`（默认 5）
- key = sorted(source.id, target.id) joined by `:::`（stable id）

> **信号 3 的双条件**（review 重点指正）：仅检查 `min deg ≤ 2` 会产生假阳性——度≤2 的节点很多但不是 hub 连就平常。必须同时满足另一端是 hub（degree ≥ 50% 最大度），这才是"小节点被大节点拽着"的惊喜结构。

## 4. 知识缺口（detect_knowledge_gaps）

移植桌面。三类 gap（排除 `node_type == "system"` 的节点）：

| 类型 | 条件 | 聚合 | suggestion |
|------|------|------|-----------|
| **isolated-node** | `linkCount ≤ 1` | 聚合成 1 条（"N isolated pages"，description 展示 top5 label）| "这些页缺链接，考虑加 [[wikilinks]] 或扩展内容" |
| **sparse-community** | `cohesion < 0.15` 且 `nodeCount ≥ 3` | 每社区 1 条（"Sparse cluster: {topNodes[0]}"）| "该知识区内部交叉引用薄弱" |
| **bridge-node** | 邻居跨越 **≥ 3** 个不同社区 | 按跨社区数 desc，top 3 各 1 条（"Key bridge: {label}"）| "该页桥接多个知识集群，确保维护好" |

按 `limit`（默认 8）截断；bridge 排前面（本身 limit≤3）、isolated 1 条、sparse 补充。

---

## 5. 数据流 + API

```
GET /api/v1/graph/:project_id/insights
  → build_graph(pool, project_id)  （2c cached）  → WikiGraph
  → find_surprising_connections(&graph, limit=5)    → Vec<SurprisingConnection>
  → detect_knowledge_gaps(&graph, limit=8)          → Vec<KnowledgeGap>
  → { surprisingConnections, knowledgeGaps }
```

**API 响应**（替换现有 stats 占位）：
```json
{
  "surprisingConnections": [{
    "source": GraphNode, "target": GraphNode,
    "score": 5, "reasons": ["crosses community boundary", "peripheral node links to hub"],
    "key": "a:::b"
  }],
  "knowledgeGaps": [{
    "type": "isolated-node",
    "title": "3 isolated pages",
    "description": "Alice, Bob, Carol",
    "nodeIds": ["entities/alice.md", "entities/bob.md", ...],
    "suggestion": "These pages have few or no connections..."
  }]
}
```

---

## 6. 组件改动

**`services/graph.rs`** 追加两个纯函数 + 类型：

```rust
#[derive(Serialize)]
pub struct SurprisingConnection {
    pub source: GraphNode, pub target: GraphNode,
    pub score: i32, pub reasons: Vec<String>, pub key: String,
}

#[derive(Serialize)]
pub struct KnowledgeGap {
    pub r#type: String,  // "isolated-node" | "sparse-community" | "bridge-node"
    pub title: String, pub description: String,
    pub nodeIds: Vec<String>, pub suggestion: String,
}

pub fn find_surprising_connections(graph: &WikiGraph, limit: usize) -> Vec<SurprisingConnection>;
pub fn detect_knowledge_gaps(graph: &WikiGraph, limit: usize) -> Vec<KnowledgeGap>;
```

**`routes/graph.rs`** `get_insights` handler：替换 stats 占位，调 `build_graph` 后跑两个函数。

---

## 7. 测试

**单元（CI 可跑，纯函数 + 手工构造 WikiGraph）**：
- 信号 1（跨社区 +3）：两节点不同 community 的边入选
- 信号 2（distant-pair +2）：source-concept 配对（需构造 node_type=source/concept 的节点）
- 信号 3（边缘↔枢纽 +2）：min deg≤2 且 max deg≥0.5*maxDegree 双条件成立（构造全局 maxDegree=10、一端 deg=2、另一端 deg=6 的边）
- 信号 4（弱边 +1）：weight∈(0,2)
- 阈值：**score=2 不入选**（<3），score=3 入选
- system 节点被排除（surprising + gaps）
- gap 三类各一例（isolated/sparse-community/bridge）
- bridge 按跨社区数 desc top3

**集成（`#[ignore]`，PG + project 249）**：GET /insights → surprisingConnections/gaps 有结果、无 system 页。

---

## 8. 已知限制 / 范围边界

1. ⚠️ **类型谱系不匹配（2c 共患）**：桌面类型信号（2c TYPE_AFFINITY + 2d distant-pairs）假设 page_type ∈ {entity,concept,source,synthesis,query}；但 server 实测产出 {Person, Organization, Project, concept, system, ...}（step2 prompt 未强制枚举）。影响：distant-pairs 大多退化成 +1（"different types"）、typeAffinity 大多走 default 0.5——**信号弱化但不报错**。本 spec 移植原算法（graceful degradation）；真正的修法是规范化 step2 prompt 强制 canonical 类型（entity/concept/source/synthesis/query）——**那是单独的 follow-up**，不在 2d 范围。
2. **纯计算、无 LLM**：确定性、廉价（毫秒级，复用 2c cached graph）。
3. **/insights 替换 stats 占位**（node_count/edge_count/density 移除）。
4. **只读分析**：不做自动修复（如自动加 wikilink）——YAGNI。

---

## 9. 验收标准

- [ ] 信号 3（边缘↔枢纽）**双条件**同时满足才 +2
- [ ] score=2 不入选、score=3 入选
- [ ] system 类型节点被排除
- [ ] 三类 gap 能产生（isolated/sparse-community/bridge）
- [ ] bridge 按跨社区数 desc 排序
- [ ] `GET /insights` 返回 `{surprisingConnections, knowledgeGaps}`（非旧 stats 占位）

---

## 10. 与前后层关系

- **2c（graph）**：消费者——build_graph 产出 nodes/edges/communities（cached）。
- **2a/2b**：独立。
- **Layer 2 至此全部 spec 完成**（2a/2b/2c/2d）。

---

## 附录：review 反馈落实记录（2026-06-20）

| # | review 问题 | 落实 |
|---|------------|------|
| 1 | 信号 3 数学速记缺 hub-degree 条件（`maxDeg ≥ maxDegree*0.5`），实施者会误以为只需 `min degree ≤ 2` → 假阳性 | §3 信号 3 补全双条件：`min≤2 且 max≥maxDegree×0.5`（与桌面逐字一致）|
| 2 | §6 测试列表不完整、"di弱边"缩写不清 | §7 重写为完整四信号列表（跨社区+3 / distant-pair+2 & 其它异类+1 / 边缘枢纽+2 / 弱边+1）；加阈值 `score=2 不入选` 测试 |

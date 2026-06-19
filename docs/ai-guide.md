← [CLAUDE.md](../CLAUDE.md)

## 🤖 AI 使用指引

### 核心概念理解

#### 1. 两步摄取 (Two-Step Ingest)

- **Step 1 (Analysis)**: LLM 分析源文件 → 结构化分析
  - 关键实体、概念、论点
  - 与现有 wiki 的连接
  - 矛盾与张力
  - Wiki 结构建议

- **Step 2 (Generation)**: LLM 基于分析生成 wiki 文件
  - 带源文件 frontmatter 的摘要
  - 实体页面、概念页面（带交叉引用）
  - 更新 index.md, log.md, overview.md
  - 审核项（预生成搜索查询）
  - Deep Research 搜索查询

- **增强功能**:
  - SHA256 增量缓存（未变更文件自动跳过）
  - 持久化摄取队列（串行处理，崩溃恢复）
  - 文件夹导入（保留目录结构，文件夹路径作为分类提示）
  - 自动嵌入（启用向量搜索时）
  - 源文件可追溯性（每个 wiki 页面包含 `sources: []` 字段）

#### 2. 四信号相关性模型 (4-Signal Relevance)

| 信号 | 权重 | 描述 |
|------|------|------|
| **Direct link** | ×3.0 | `[[wikilink]]` 直接连接 |
| **Source overlap** | ×4.0 | 共享源文件 (frontmatter `sources[]`) |
| **Adamic-Adar** | ×1.5 | 共同邻居（加权邻居度数） |
| **Type affinity** | ×1.0 | 同类型页面奖励 |

#### 3. Louvain 社区检测

- 自动发现知识聚类
- 计算社区内聚度 (cohesion = actual edges / possible edges)
- 低内聚度社区 (< 0.15) 标记警告
- 12 色社区调色板

#### 4. 多阶段检索管道

- **Phase 1**: 分词搜索（英文单词分割 + 中文 CJK bigram，标题匹配 +10 分）
- **Phase 1.5**: 向量语义搜索（可选，LanceDB，余弦相似度）
- **Phase 2**: 图扩展（2-hop 遍历，衰减）
- **Phase 3**: 预算控制（可配置 4K-1M tokens，60/20/5/15 分配）
- **Phase 4**: 上下文组装（编号页面，引用格式 [1], [2]）

### AI 辅助开发建议

#### 1. 理解数据流

```
用户导入文件
  → autoIngest()
  → LLM 分析 (Step 1)
  → LLM 生成 (Step 2)
  → 写入文件
  → 更新图

搜索查询
  → searchWiki()
  → 分词 + 向量 + 图扩展
  → 排序
  → 返回结果

删除文件
  → 级联清理
  → 移除 source summary
  → 更新相关页面
  → 清理 wikilinks
```

#### 2. 关键文件路径

- **摄取逻辑**: `src/lib/ingest.ts` (核心两步摄取)
- **LLM 客户端**: `src/lib/llm-client.ts` (流式调用)
- **知识图谱**: `src/lib/wiki-graph.ts` (图构建 + Louvain)
- **搜索**: `src/lib/search.ts` (多阶段检索)
- **相关性**: `src/lib/graph-relevance.ts` (四信号模型)
- **图洞察**: `src/lib/graph-insights.ts` (惊喜连接、知识缺口)
- **Rust 后端**: `src-tauri/src/commands/` (文件操作，向量存储)
- **Clip Server**: `src-tauri/src/clip_server.rs` (HTTP 服务器)

#### 3. 状态管理

- **wiki-store**: 项目状态、文件树、LLM 配置、dataVersion
- **chat-store**: 对话历史、当前会话、多会话管理
- **review-store**: 审核队列
- **activity-store**: 实时活动面板
- **research-store**: 深度研究状态

#### 4. Tauri 命令模式

- 前端调用: `import { readFile } from "@/commands/fs"`
- 后端注册: `src-tauri/src/lib.rs` 中的 `invoke_handler`
- Rust 实现: `src-tauri/src/commands/` 目录

#### 5. 常见任务模式

- **添加新的 LLM provider**: 修改 `src/lib/llm-providers.ts`
- **扩展文件格式支持**: 修改 `src-tauri/src/commands/fs.rs` 的 `read_file()`
- **自定义图布局**: 修改 `src/components/graph/graph-view.tsx`
- **添加新的审核类型**: 修改 `src/lib/ingest.ts` 的 `parseReviewBlocks()`
- **修改相关性权重**: 修改 `src/lib/graph-relevance.ts`
- **添加新的搜索阶段**: 修改 `src/lib/search.ts`

### AI 上下文优化

当使用 AI 工具（如 Claude Code）时，可以提供以下上下文以获得更好的帮助：

```
这是一个 Tauri v2 桌面应用，前端 React 19 + TypeScript，后端 Rust。

核心功能：
1. 两步 LLM 摄取 (分析 → 生成)
2. 知识图谱可视化 (sigma.js + Louvain)
3. 多阶段搜索 (分词 + 向量 + 图)
4. Web Clipper (Chrome 扩展 + HTTP 服务器)

关键文件：
- src/lib/ingest.ts (两步摄取)
- src/lib/wiki-graph.ts (图构建)
- src/lib/graph-relevance.ts (四信号相关性)
- src-tauri/src/clip_server.rs (Web Clipper 服务)

技术栈：
- 前端: React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui
- 后端: Rust, Tauri v2, LanceDB (可选), pdf-extract, docx-rs
- LLM: OpenAI, Anthropic, Google, Ollama, MiniMax, Custom
```


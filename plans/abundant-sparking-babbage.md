# CLAUDE.md 导航式重构 + AGENTS.md 软链接

## Context

CLAUDE.md 当前 **667 行 / 15 section**，作为 AI 上下文过长（每次会话全量加载）。目标：精简为**导航地图式**（顶层简介 + 链接），具体内容拆到 **6 个子文档**链接过去；另创建 **AGENTS.md 软链接**到 CLAUDE.md（AI agent 工具约定文件名，两者同步）。

原则：**信息零丢失**——667 行内容完整迁移到子文档，CLAUDE.md 只做导航。

## 方案

### 1. .gitignore（让子文档 tracked）

当前 `.gitignore:24-25`：`# Internal docs (not shipped)` + `docs/`。移除 `docs/` 行（line 25），让 `docs/*.md` 子文档正常 tracked（不需 -f）。

- `AGENTS.md`（line 26）**保留 ignore**——软链接本地存在、不提交（同步靠软链接，不需 git）。
- `docs/superpowers/` 已 -f tracked，移除 `docs/` 不影响（git 已跟踪的文件不受 gitignore 影响）。

### 2. 6 个子文档（docs/ 下，内容从 CLAUDE.md 对应 section 完整迁出）

| 子文档 | 来源 section（CLAUDE.md 行号）|
|--------|------------------------------|
| `docs/CHANGELOG.md` | 变更记录（L11-53）|
| `docs/architecture.md` | 项目愿景 + 架构总览 + 模块结构图 + 模块索引 + 项目目录结构（L54-191, L552-622）|
| `docs/development.md` | 运行与开发 + 测试策略 + 编码规范（L192-305）|
| `docs/ai-guide.md` | AI 使用指引（L306-441）|
| `docs/features.md` | 关键特性（L442-551）|
| `docs/resources.md` | 相关资源 + 许可证 + 致谢（L623-667）|

每个子文档：顶部加"← [CLAUDE.md](../CLAUDE.md)"回链，正文完整迁移原 section（保留表格/mermaid 图/代码块）。

### 3. CLAUDE.md 精简（667 → ~60 行）

```
# LLM Wiki
> 跨平台桌面应用（React 19 + Tauri v2 + Rust），把文档自动转化为结构化、互联的知识库。
> 基于 Andrej Karpathy 的 llm-wiki 设计模式。

## 快速导航
| 主题 | 文档 |
|------|------|
| 架构与模块 | docs/architecture.md |
| 开发指南 | docs/development.md |
| AI 使用指引 | docs/ai-guide.md |
| 关键特性 | docs/features.md |
| 变更记录 | docs/CHANGELOG.md |
| 相关资源 | docs/resources.md |

## 快速入口
- **技术栈**：React 19 + Tauri v2 (Rust) + LanceDB + Milkdown + sigma.js
- **启动**：`npm run tauri dev`（前端 1420）
- **核心文件**：`src/lib/ingest.ts`（两步摄取）/ `wiki-graph.ts`（图谱）/ `search.ts`（多阶段检索）
- **测试**：`npm test`
- **版本**：0.4.0（2026-06-15）
```

### 4. AGENTS.md 软链接

`ln -s CLAUDE.md AGENTS.md`（相对软链接，AGENTS.md → CLAUDE.md）。AGENTS.md 被 .gitignore，本地软链接不提交；任何工具读 AGENTS.md 等同 CLAUDE.md。

## 文件改动清单

- **改** `.gitignore`：移除 `docs/`（line 25）
- **改** `CLAUDE.md`：重写为精简导航（~60 行）
- **建** `docs/CHANGELOG.md`、`docs/architecture.md`、`docs/development.md`、`docs/ai-guide.md`、`docs/features.md`、`docs/resources.md`
- **建** `AGENTS.md`：软链接 → CLAUDE.md

## 验证

1. **链接有效**：CLAUDE.md 导航表的 6 个 `docs/*.md` 都存在且内容完整（对照原 667 行无丢失）。
2. **软链接**：`cat AGENTS.md` 输出 = CLAUDE.md 内容；`ls -l AGENTS.md` 显示 `-> CLAUDE.md`。
3. **git 跟踪**：`git status` 显示 `docs/*.md` 为新 tracked 文件（改 gitignore 后），`AGENTS.md` 不出现（ignored）。
4. **提交**：`git add .gitignore CLAUDE.md docs/CHANGELOG.md docs/architecture.md docs/development.md docs/ai-guide.md docs/features.md docs/resources.md`（不 add AGENTS.md）+ commit。
5. **回归**：子文档内 mermaid 图（架构图/模块图）渲染正常；表格完整。

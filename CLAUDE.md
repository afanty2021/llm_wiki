# LLM Wiki

> 跨平台桌面应用（React 19 + Tauri v2 + Rust），把文档自动转化为结构化、互联的知识库。
> 基于 Andrej Karpathy 的 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 设计模式——Human curates, LLM maintains。

**Version**: 0.4.0 · **Last Updated**: 2026-06-15 · **Project Type**: Cross-platform Desktop (Tauri v2)

---

## 🗺️ 快速导航

具体内容拆到子文档，按主题查阅：

| 主题 | 文档 | 内容 |
|------|------|------|
| 🏗️ 架构与模块 | [architecture.md](docs/architecture.md) | 项目愿景、技术栈、架构图、模块结构图、模块索引、目录结构 |
| 🚀 开发指南 | [development.md](docs/development.md) | 环境要求、开发/构建、Chrome 扩展、测试策略、编码规范 |
| 🤖 AI 使用指引 | [ai-guide.md](docs/ai-guide.md) | 两步摄取、四信号相关性、Louvain、多阶段检索、数据流、关键文件、常见任务 |
| 🔑 关键特性 | [features.md](docs/features.md) | 摄取、图谱、搜索、Deep Research、Web Clipper、多格式、审核、日志等 9 大特性 |
| 📋 变更记录 | [CHANGELOG.md](docs/CHANGELOG.md) | 版本变更日志 |
| 🔗 相关资源 | [resources.md](docs/resources.md) | 设计灵感、技术文档、外部服务、许可证、致谢 |

---

## ⚡ 快速入口

- **技术栈**：React 19 + Tauri v2 (Rust) + LanceDB + Milkdown + sigma.js + Zustand
- **启动开发**：`npm run tauri dev`（前端热重载 1420）
- **测试**：`npm test`（Vitest）/ `cargo test`（Rust）
- **核心文件**：`src/lib/ingest.ts`（两步摄取）/ `wiki-graph.ts`（图谱 + Louvain）/ `search.ts`（多阶段检索）/ `graph-relevance.ts`（四信号相关性）
- **Rust 后端**：`src-tauri/src/commands/`（fs / project / vectorstore）+ `clip_server.rs`（Web Clipper）

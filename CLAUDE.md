# LLM Wiki

> 跨平台桌面应用（React 19 + Tauri v2 + Rust），把文档自动转化为结构化、互联的知识库。
> 基于 Andrej Karpathy 的 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 设计模式——Human curates, LLM maintains。

**Version**: 0.6.10+fork · **Last Updated**: 2026-09-07 · **Project Type**: Desktop (Tauri v2) + 独立服务端 (src-server) + MCP Server

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
| 🖥️ 服务端 | [src-server/](src-server/) | 独立 axum + Postgres 服务（API + web 同源 :8080），自带 workspace/迁移/docker-compose |
| 🔌 MCP Server | [mcp-server/](mcp-server/) | `llm-wiki-training`（教师工具面）+ `llm-wiki-admin`（training_overview 只读），TypeScript |
| 🛠️ 运维脚本 | [tools/ltutor/](tools/ltutor/) | Python：admin-tool-guard 守卫、教师周报开通等 |
| 📐 计划与评审 | [docs/superpowers/](docs/superpowers/) | 实施计划 / spec / 评审报告 / 部署 runbook 落盘区；Hermes 集成文档在其 hermes/ 子目录 |

---

## ⚡ 快速入口

- **技术栈**：React 19 + Tauri v2 (Rust) + LanceDB + Milkdown + sigma.js + Zustand
- **启动开发**：`npm run tauri dev`（前端热重载 1420）
- **测试**：`npm run test:mocks`（CI 门，2253+ 用例）/ `npm run test:llm`（真模型，慢）/ `npm --prefix mcp-server test` / `cargo test`（分 workspace，见下）
- **核心文件**：`src/lib/ingest.ts`（两步摄取）/ `wiki-graph.ts`（图谱 + Louvain）/ `search.ts`（多阶段检索）/ `graph-relevance.ts`（四信号相关性）
- **Rust 后端**：`src-tauri/src/commands/`（fs / project / search / vectorstore 等）+ `api_server.rs`（本地 HTTP API）+ `clip_server.rs`（Web Clipper）
- **服务端**：`src-server/`（axum + Postgres docker :5433；API + web 同源 :8080；launchd `wiki.src-server`）
- **MCP**：`mcp-server/` → `llm-wiki-training`（`TRAINING__PROJECT_ID` 绑定项目）+ `llm-wiki-admin`

## ⚠️ 硬约束（改代码前必读）

1. **两个互不相通的 cargo workspace**：根目录（src-tauri + crates，Tauri 应用）与 `src-server/`（llm-wiki-server）——src-server 的 build/test 必须 `cd src-server` 后执行。
2. **src-server 集成测试连 live PG**（docker 5433 = 生产库），跑集成测试前知情。
3. **web 部署**：同源 :8080 必须 `npm run build:web`（dist 运行时读盘）——纯前端改动 build:web 即完成部署；web/desktop 双门控（WEB-1 型）别被桌面侧重构吞掉。
4. **MCP 非热生效**：改 mcp-server 后必须 `npm run mcp:build`，消费方（Hermes 网关）重启才吃到新工具。
5. **SKILL 热部署**：`docs/superpowers/hermes/lt-tutor/SKILL.md` 双份 cp 即生效（仓源 + `~/.hermes/profiles/lt-tutor/` 运行副本），无需重启。
6. **git 纪律**：`git add` 禁 `-A`；提交前必查 `git branch --show-current`（本仓库有并行会话共存，分支会被切走）。
7. **密钥不进仓不回显**（bootstrap.env / 各 .env / launchd plist 各有落点）；launchd 改动 bootout 完全退出后再 bootstrap；重启 src-server/Hermes 避开周日 19:00 教师周报窗。

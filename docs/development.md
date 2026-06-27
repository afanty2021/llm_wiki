← [CLAUDE.md](../CLAUDE.md)

## 🚀 运行与开发

### 环境要求

- **Node.js**: 20+
- **Rust**: 1.70+ (2021 edition)
- **操作系统**: macOS, Windows, Linux

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发服务器 (前端 Vite + Tauri)
npm run tauri dev
# 前端热重载端口: 1420

# 前端单独运行 (端口 1420)
npm run dev

# 运行测试
npm test

# Rust 代码检查
cargo clippy
cargo fmt
```

### 生产构建

```bash
# 构建前端
npm run build

# 构建 Tauri 应用
npm run tauri build

# 生成的安装包位置:
# - macOS: src-tauri/target/release/bundle/dmg/
# - Windows: src-tauri/target/release/bundle/msi/
# - Linux: src-tauri/target/release/bundle/deb/ 或 .AppImage
```

### Chrome 扩展安装

1. 打开 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `extension/` 目录

---

## 🧪 测试策略

本项目跨三个测试目标:前端 (Vitest)、桌面端 Rust (`src-tauri`)、Web 服务端 Rust (`src-server`)。

### 前端测试 (Vitest)

- **框架**: Vitest 4.x（配置在 `vitest.config.ts`）
- **规模**: 125+ 测试文件，覆盖 `src/lib/`、`src/components/`、`src/stores/`、`src/i18n/`
- **分两类**:
  - **mock 测试**（默认）: 纯逻辑，不调真实 LLM —— `*.test.ts`
  - **real-llm 测试**: 调真实 LLM provider，串行运行 —— `*.real-llm.test.ts`
- **主要覆盖域**: 摄取 (`ingest*`)、搜索 (`search*`、`graph-search`)、embedding、`sweep-reviews`、`deep-research`、`lint`、`wiki-*`、`okf-export`、`i18n-parity` 等

```bash
# 全量（mock + real-llm）
npm test

# 仅 mock 测试（CI 默认，无需 provider）
npm run test:mocks

# 仅 real-llm 测试（需配置 LLM provider，串行）
npm run test:llm

# 监听模式（开发时推荐）
npm run test -- --watch
```

### 桌面端测试 (src-tauri)

Rust 原生 `#[test]` / `#[tokio::test]`，约 155 个，位于 `src-tauri/src/` 各模块的 `mod tests`。

```bash
cd src-tauri && cargo test
```

### Web 服务端测试 (src-server)

三层（用 `cargo -p llm-wiki-server` 或在 `src-server/` 下运行）:

| 层 | 内容 | 依赖 |
|---|---|---|
| `--lib` 单测 | ~180 个：SSE 解析、文档分块、review 解析、storage、auth 等 | 无 |
| `--test integration` | ~68 个：auth / files / pages / reviews / ingest-queue / research / permissions 等 | PG + Redis |
| `#[ignore]` | ~9 个：embedding / search / golden-recall / graph | 本地 omlx (@8001 bge-m3) 或预播种 project 249 |

```bash
cd src-server

# lib 单测（无外部依赖）
cargo test --lib

# 集成测试（需 PG@5433 + Redis@6380）
docker compose up -d            # 起 pgvector + redis，见 docker-compose.yml
cargo test --test integration

# ignored 测试（需本地 omlx embedding 服务 + 预播种数据）
cargo test -- --ignored
```

> **本地陷阱**: 若同时跑着 src-server main (@8080)，其 ingest worker 会 `BRPOP` 消费 `ingest:queue`，使 `ingest_queue_test::enqueue_and_job_status_roundtrip` 失败 —— 停掉 server 再跑即过（非代码 bug，CI 里不复现）。

### CI (`.github/workflows/`)

- **`ci.yml` · `check`**: mac / linux / windows 三平台跑 `vite build` + `src-tauri cargo build`。
- **`ci.yml` · `src-server-test`**: ubuntu 起 `pgvector/pgvector:pg16` (@5433) + `redis:7` (@6380)，`sqlx migrate run` 后 `cargo test --lib --test integration`（不含 `#[ignore]`）。
- **`build.yml`**: tag `v*` 触发多平台发版打包（tauri-action）；`workflow_dispatch` 可手动出包。

> **fork 仓库注意**: `afanty2021/llm_wiki` 的 GitHub Actions 默认不运行，需在 Actions 页手动点一次 "Enable workflows"（一次性，无 API）；启用后 push / `workflow_dispatch` 才触发。

### 测试覆盖现状

覆盖较完整，已知缺口:

- `src/lib/wiki-graph.ts`、`graph-relevance.ts` 无直接单测（部分由 `graph-search` / `graph-filters` 间接覆盖）。
- 端到端（摄取 → 搜索 → 聊天全链路）靠前端 `*.real-llm.test.ts` + src-server integration 拼接，无单一全链路 E2E 脚本。

---

## 📐 编码规范

### TypeScript/JavaScript

- **风格指南**: 遵循 ESLint 默认配置
- **类型安全**: 严格使用 TypeScript 类型
- **组件命名**: PascalCase for components, camelCase for utilities
- **文件组织**: 按功能模块分组 (components/, lib/, stores/)

### Rust

- **版本**: 2021 edition
- **风格**: `cargo fmt` (rustfmt)
- **Linter**: `cargo clippy`
- **错误处理**:
  - 桌面端 (`src-tauri` commands): `Result<T, String>` 返回错误信息给前端
  - Web 服务端 (`src-server`): `AppError`（axum `IntoResponse`），统一映射 HTTP 状态码

### 代码质量工具

- **前端**: ESLint + TypeScript
- **后端**: rustfmt + clippy
- **CI/CD**: GitHub Actions (多平台构建测试)


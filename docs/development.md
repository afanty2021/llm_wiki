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

前端有两种形态，产物落**不同目录**（`vite.config.ts` 按 mode 分流）。本仓检出同时是 live 运行目录——`dist/` 就是 src-server :8080 运行时读盘的静态根，所以只有 web 形态可以写它：

| 形态 | 命令 | 产物目录 | 消费方 |
|------|------|---------|------|
| web（API 同源相对请求） | `npm run build:web`（`vite build --mode web`） | `dist/` | src-server `frontend.dist_dir`；运行时读盘，构建完即部署、无需重启 |
| 桌面（API base = `http://localhost:8080`） | `npm run build` / `build:desktop`（`vite build`） | `dist-desktop/` | Tauri `frontendDist`，`tauri build` 编译期内嵌 |

```bash
# 构建 web 形态 → dist/（即 :8080 部署）
npm run build:web

# 构建 Tauri 应用（beforeBuildCommand 自动构建桌面前端 → dist-desktop/ 并内嵌）
npm run tauri build
# 只要 .app、不造 DMG：npm run tauri -- build --bundles app（flag 须写在 -- 之后，否则被 npm 吃掉）

# 生成的安装包位置:
# - macOS: src-tauri/target/release/bundle/dmg/
# - Windows: src-tauri/target/release/bundle/msi/
# - Linux: src-tauri/target/release/bundle/deb/ 或 .AppImage
```

> **桌面包内的 MCP server 是只读拷进来的**：三个平台的 tauri conf 把检出里的 `mcp-server/{package.json,dist,node_modules}` 作为 resources 打进 bundle，`tauri build` **不重建**它们——本仓这两处是 Hermes 网关 live 加载的进程入口，`npm ci` 会清掉运行中进程的 node_modules、重建会直接改写线上。要让 bundle 带上新的 MCP 代码，打包前显式 `npm run mcp:build`（CI 另有显式的 "Prepare MCP server resources" 步骤）。
>
> 回归钉 `src/lib/build-form.test.ts`（在 `npm run test:mocks` 内）：上游合并若吞掉产物目录分流、让 `beforeBuildCommand` 重新去建 mcp-server、或 `frontendDist` 与实际产物目录脱节，测试即红。历史：2026-11-24 前两种形态同写 `dist/`，10-25 本地打包后 :8080 被静默换成桌面形态近一月（2026-11-25 结构性根治）。

### Chrome 扩展安装

1. 打开 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `extension/` 目录

---

## 🧪 测试策略

本项目跨三个测试目标:前端 (Vitest)、桌面端 Rust (`src-tauri`)、Web 服务端 Rust (`src-server`)。

### 前端测试 (Vitest)

- **框架**: Vitest 4.x（配置在 `vite.config.ts`）
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

Rust 原生 `#[test]` / `#[tokio::test]`，约 160 个，位于 `src-tauri/src/` 各模块的 `mod tests`。

```bash
cd src-tauri && cargo test
```

### Web 服务端测试 (src-server)

三层（用 `cargo -p llm-wiki-server` 或在 `src-server/` 下运行）:

| 层 | 内容 | 依赖 |
|---|---|---|
| `--lib` 单测 | ~198 个：SSE 解析、文档分块、review 解析、storage、auth 等 | 无 |
| `--test integration` | ~93 个：auth / files / pages / reviews / ingest-queue / research / training / media / permissions 等 | PG + Redis |
| `#[ignore]` | ~18 个：embedding / search / golden-recall / graph | 本地 omlx (@8001 bge-m3) 或预播种 project 249 |

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

## 🧰 摄取运维

### 修复性重投 SOP（ingested_files 去重吞没）

**适用场景**: 摄取 job 显示 succeeded，但部分（或全部）源因 `ingested_files` 去重被跳过、未产出页。已有两次先例：

- **2026-09-02 直播回放批**: 零页产出（zero_page_sources），须先 DELETE 对应 `ingested_files` 行再重新 trigger，直接重跑仍会被去重吞掉。
- **2026-09-14 孤儿章批（job `e8e73204`）**: 12 源中 11 章被 `ingested_files` 去重吞掉；备份后 DELETE 11 行、重投 job `f753f756` 才闭合。

**操作步骤**（按序执行，①②不可颠倒）：

```bash
# ① 备份目标行（psql 连 src-server 库，端口 5433；按实际 project_id 与路径前缀调整筛选条件。列名是 original_path，非 file_path）
\copy (SELECT * FROM ingested_files WHERE project_id = <PID> AND original_path LIKE '<目标路径前缀>%') TO 'backup_ingested_files_<日期>.csv' CSV HEADER

# ② 删除目标路径的去重记录（条件须与 ① 完全一致，先 SELECT COUNT 确认行数）
DELETE FROM ingested_files WHERE project_id = <PID> AND original_path LIKE '<目标路径前缀>%';

# ③ 重新 trigger 摄取 job（CLI / API / UI 任一入口）

# ④ 按源对账页产出 —— job succeeded ≠ 源落库
```

**④ 逐源对账（必做）**: 检查 job result JSON 的计账字段——

- `dedup_skipped`: 被去重跳过的源列表；
- `zero_page_sources`: 产出零页的源列表；
- `merge_stats`: 合并统计。

逐源核对「应产出页数 = 实际落库页数」。**部分吞没形态（跳过 + 正常混合，written > 0）不会触发管线侧的全跳过汇总告警，只有这一步能捕捉**；全部源被去重跳过（written=0 且无失败）才触发全跳过汇总告警；零页源触发的是逐源 warning。

**边界提醒**:

- 不要跳过①直接 DELETE——删错行后无恢复手段。
- ②的 WHERE 条件务必先 `SELECT COUNT(*)` 复核，避免误伤同 project 下其他路径。
- 09-02 批的教训：不 DELETE 直接重 trigger，重跑 job 仍会被同一批 `ingested_files` 记录吞掉，形成「看似成功实则零产出」的循环。

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


# src-server 文件轮转 + /logs API 实施方案

## Context

src-server（独立 axum web 服务）日志仅 stdout fmt + HTTP 请求中间件，缺文件持久化/轮转/查看/导出/清除/级别控制。本次移植 src-tauri 已验证的日志核心（含审计 #1/#3/#5/#6/#7/#8 修复）到 src-server，并暴露 `/api/v1/logs` REST API（admin 权限），能力对齐桌面版。不动 src-tauri。

## 模块结构（新建/改动）

| 文件 | 动作 | 内容 |
|------|------|------|
| `src-server/Cargo.toml` | 改 | 加 `tracing-appender="0.2"`；tracing-subscriber features 加 `json`,`fmt` |
| `src-server/src/services/logging.rs` | 新建 | 移植核心：appender+Write+轮转 / SharedHandle+reopen / init_logging / 文件操作 / 级别控制 / types |
| `src-server/src/services/mod.rs` | 改 | `pub mod logging;` |
| `src-server/src/routes/logs.rs` | 新建 | 6 handler + `logs_routes()` |
| `src-server/src/routes/mod.rs` | 改 | `mod logs;` + nest `/api/v1/logs` |
| `src-server/src/middleware/auth.rs` | 改 | 加 `require_admin`（require_auth + username ∈ ADMIN_USERNAMES） |
| `src-server/src/config.rs` | 改 | 加 `LoggingConfig{dir,max_size_bytes,max_files,level}` + `admin_usernames` |
| `src-server/src/main.rs` | 改 | 替换 fmt init 为 `logging::init_logging(...)`（在 create_app 前） |

## 移植策略（services/logging.rs）

从 `src-tauri/src/logging/manager.rs` 复制，**适配点**：
- `init_logging(log_dir: PathBuf, level: String, max_size_bytes: u64, max_files: usize)` —— 4 参（无 AppHandle / 无 app_data_dir / 无 app-state.json 持久化；轮转参数从 config 传入）
- 去 `NotifyLayer`（桌面通知，src-server 不需要）
- 去 `crate::logging::config` 的读写持久化（级别来自 ENV + 内存），**但迁移 `is_valid_level` 纯校验函数到本模块**（set_log_level 依赖它校验，否则编译失败）
- 保留 `#[cfg(debug_assertions)]` stdout layer（审计 #2）
- 保留 json 文件 layer + reload handle + WorkerGuard + SHARED OnceLock

**直接复制（含审计修复）**：
- `SizeBasedRollingFileAppender` + `Write` impl（含 #3：轮转后 `size = new_size + buf.len()`）
- `SharedHandle` + `reopen_shared`（含 #1：根治幽灵文件；#2 锁顺序 file→size；#8 持锁无 expect）
- `clear_logs` / `get_log_files`（含 #7 `is_current_log` strip_suffix）/ `read_log_file` + `extract_entry`（含 #6 frontend_ts 回退）/ `export_logs`（含 #5 时分秒+mtime 升序）
- `get_log_level` / `set_log_level`（去持久化分支）+ `is_valid_level` 纯校验函数（set_log_level 依赖）

## admin 权限方案（ENV 白名单，无 DB 改动）

User 表无 role/admin 字段；JWT Claims={sub,username,exp}。方案：
- config 加 `admin_usernames: Vec<String>`（ENV `ADMIN_USERNAMES` 逗号分隔，默认空）
- `require_admin(state, headers) -> Result<Claims, AppError>`：调 `require_auth` 后查 `claims.username ∈ admin_usernames`，否则 `AppError::PermissionDenied`(403)
- 每个 logs handler 首行 `let _claims = require_admin(&state, &headers).await?;`（与现有 require_auth 普通函数模式一致，非全局中间件）

## API 端点（routes/logs.rs）

| 方法路径 | handler | 对应 src-tauri |
|----------|---------|----------------|
| `GET /api/v1/logs?limit&offset&level&keyword&trace_id` | list_logs | read_log_file |
| `GET /api/v1/logs/files` | list_log_files | get_log_files |
| `GET /api/v1/logs/export?days` | export_logs → 文件下载 | export_logs |
| `DELETE /api/v1/logs` | clear_logs | clear_logs |
| `GET /api/v1/logs/level` | get_level | get_log_level |
| `PUT /api/v1/logs/level` `{level}` | set_level | set_log_level |

全部经 `require_admin`（各 handler 内联首行调用，与 require_auth 普通函数模式一致，非全局中间件）。返回 `Result<Json<T>, AppError>`。

**export 适配（P2）**：src-tauri `export_logs` 返回本地路径（桌面端可直接打开）；src-server 是 HTTP 服务，返回服务端路径给客户端无效。handler 改为：调 `export_logs` 生成文件拿 path → 读文件内容 → 以 `Content-Type: application/x-ndjson` + `Content-Disposition: attachment; filename=...` 返回下载 body。export 文件留存服务端 logs 目录（可审计）。

## config 新增（config.rs，separator `__`）

```rust
pub struct LoggingConfig {
    pub dir: String,            // 默认 "./logs"
    pub max_size_bytes: u64,    // 默认 10*1024*1024
    pub max_files: usize,       // 默认 5
    pub level: String,          // 默认 "INFO"
}
// AppConfig 加：pub logging: LoggingConfig, pub admin_usernames: Vec<String>（默认空）
// ENV: LOGGING__DIR / LOGGING__MAX_SIZE_BYTES / LOGGING__MAX_FILES / LOGGING__LEVEL / ADMIN_USERNAMES=a,b
```

## main.rs 集成

```rust
// 替换现有 tracing_subscriber fmt init 为：
llm_wiki_server::services::logging::init_logging(
    config.logging.dir.clone(),
    config.logging.level.clone(),
    config.logging.max_size_bytes,
    config.logging.max_files,
)?;
```
在 `create_app` 前，保证启动期日志（含 worker bind）可写文件。

## 测试策略

- **services/logging 单测**（移植 src-tauri 已验证测试）：appender 轮转（#3 size 断言）/ read 解析+过滤 / clear reopen（#1 幽灵文件）/ export 唯一名+排序（#5）/ extract_entry frontend_ts（#6）/ is_current_log（#7）
- **require_admin 单测**：纯函数测（mock Claims + 白名单 → 通过/403）
- **logs 端点**：handler 逻辑用 read_log_file 等纯函数覆盖；JWT 集成测试复杂，依赖 require_admin 单测 + 手动验证（admin token 可访问、非 admin 403）

## 验证

1. `cargo test --manifest-path src-server/Cargo.toml -p llm-wiki-server logging` —— logging 单测全过
2. `cargo test --manifest-path src-server/Cargo.toml` —— src-server 全量不回归（排除 [[src-server-preexisting-test-failures]] 已知项）
3. `cargo build -p llm-wiki-server` —— 编译通过
4. 手动：起 src-server → `curl -H "Authorization: Bearer <admin token>" localhost:8080/api/v1/logs/files` → 200；非 admin/无 token → 401/403
5. /simplify + reviewer + general-purpose agent 三路审查（capabilities）

## 风险

- src-server 多线程 vs src-tauri 单 worker：SharedHandle Arc<Mutex> 串行化，行为一致（#1 修复基于 Arc 共享，与线程数无关）
- set_log_level 重启丢失（无持久化）→ 运维场景可接受，文档注明
- ADMIN_USERNAMES 默认空 → 无 admin 时所有 /logs 返回 403（部署须配置）

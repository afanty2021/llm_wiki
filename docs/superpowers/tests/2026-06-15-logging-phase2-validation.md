# 日志系统阶段 2 手动验证

> 日期: 2026-06-15 | 验证者: _____ | 应用版本: _____

## 验证环境
- [ ] `npm run tauri dev` 启动成功，控制台无 tracing 初始化错误
- [ ] 日志文件路径：`~/Library/Application Support/com.llmwiki.app/logs/llm-wiki.log`（macOS）

## 功能 1：请求追踪传播
- [ ] **trace_id 端到端一致**：导入一个文件触发读取 → 查看 llm-wiki.log，前端 send_log 日志与后端 read_file span 的 trace_id 相同
- [ ] **read_file span 含 trace_id**：日志中出现 `"span":{"name":"read_file","trace_id":"...","path":"..."}`
- [ ] **spawn_blocking 内部 ERROR 带 trace_id**：故意读取不存在文件，错误日志的 trace_id 与调用 trace_id 一致（验证 Span::current().enter() 生效）
- [ ] **跨命令关联**：一次摄取涉及多次调用时，前端可显式传同一 trace_id，日志中可串联

## 功能 2：Error 桌面通知
- [ ] **macOS 权限请求**：首次触发 ERROR，系统弹出通知权限请求，允许
- [ ] **后端 ERROR 触发通知**：读取不存在文件（触发后端 error!），桌面通知弹出，标题「LLM Wiki 发生错误」，body 含错误摘要
- [ ] **前端 ERROR 触发通知**：制造前端 ERROR（如调用一个会失败的操作），同样弹出通知
- [ ] **通知 body 无多余引号**：通知文本显示为「读取失败」而非 `"\"读取失败\""`（验证 strip_debug_quotes）
- [ ] **10s 去重**：连续制造多个 ERROR，10 秒内仅弹一条通知，body 含「更多错误详见日志」
- [ ] **配置开关关闭**：设置中关闭「错误桌面通知」→ 再制造 ERROR → 无通知
- [ ] **配置开关开启**：重新开启 → 制造 ERROR → 通知恢复
- [ ] **macOS 主线程安全**：通知正常弹出，无 `This API cannot be called on the main thread` panic（验证 run_on_main_thread）

## 自动化测试
- [ ] `npm test -- --run` 前端全绿（含 invoke-traced.test.ts 5 个）
- [ ] `cd src-tauri && cargo test logging` 后端全绿（含 config 5 个 + notify_layer 9 个）
- [ ] `npm run typecheck` 无新增错误
- [ ] `cd src-tauri && cargo clippy` 无新增 error 级别 lint

## 平台备注
- Windows 开发模式：通知图标显示为 PowerShell，生产构建（已安装）正常显示应用图标
- Linux：依赖桌面环境的通知守护进程（libnotify）

## 已知限制
- search.ts / file-sync.ts / *-cli-transport.ts 的 invoke 调用点需单独调查后按同模式迁移（本阶段未覆盖，因 grep 未发现明确 invoke() 调用）

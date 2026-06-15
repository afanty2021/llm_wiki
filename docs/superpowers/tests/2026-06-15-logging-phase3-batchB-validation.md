# 日志系统阶段 3 批次 B 手动验证

> 日期: 2026-06-15 | 验证者: _____ | 应用版本: _____

## 自动化测试
- [ ] `cd src-tauri && cargo test logging::manager::tests` — read_* 10 个测试全通过（含现有 3 个旧测试 = 13 passed）
- [ ] `cd src-tauri && cargo check` — 0 error
- [ ] `npm run typecheck` — 无新增错误
- [ ] `npm test -- --run` — 全绿（1415 pass）

## read_log_file 命令验证
- [ ] **空日志目录**：首次运行（无日志）打开查看器显示"暂无日志记录"
- [ ] **基本加载**：产生若干日志后打开查看器，显示最新 100 条（时间降序）
- [ ] **分页**：日志 >100 条时，下一页/上一页按钮工作正常
- [ ] **级别筛选**：点击级别 chip toggle，列表随之过滤
- [ ] **关键字搜索**：输入关键字，模糊匹配 message + module（大小写不敏感）
- [ ] **trace_id 过滤**：输入一个 trace_id，精确匹配该请求日志
- [ ] **ERROR 高亮**：ERROR 行红色背景
- [ ] **并发安全**：查看器打开时持续产生日志（不崩溃，轮转瞬间最多丢几行）

## 字段提取验证
- [ ] **前端日志 module**：前端日志显示 span.module（如 src/lib/ingest.ts），非 "frontend"
- [ ] **后端日志 module**：后端日志显示 Rust target（如 llm_wiki::commands::fs）
- [ ] **trace_id 显示**：阶段 2 起的日志带 trace_id

## 已知限制
- 逻辑反序读取（read lines then .rev()），非物理反序 seek——当前文件全读（10MB <200ms）
- total 每次请求重新扫描全部文件（YAGNI，不缓存；60MB <1s）
- 单次最多返回 500 条（MAX_LOG_LIMIT）

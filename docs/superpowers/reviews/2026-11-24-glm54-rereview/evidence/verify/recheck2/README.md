# 第二轮复审归档（2026-11-25，用户口令「max 复查近期评审修复」）

对象是 11-24 晚闭环复审之后新增、且从未被独立评审过的 8 笔提交：`7b6da1d6`、`710111b0`、`300c3771`、`e9738730`、`cb78ed06`（未推送）与 `0f17695f`、`e8ee2893`、`8887af93`（已推）。
方式：四个互不相见的独立评审席串行派出（每席只拿任务书），协调者对每席的 Important 与承重数字亲手重验。
裁决与结论以 [`report.md`](../../../../report.md) §十一 为准，本目录只是原文与证据。

| 件 | 内容 |
|---|---|
| `R1.md`–`R4.md` | 四席评审报告原文（各带一行归档头注） |
| `coordinator/notes.md` | 协调者亲验笔记（每席亲验了什么、数字是多少） |
| `coordinator/summary-*.txt` | 协调者各轮验证脚本的汇总输出：R1 变异矩阵（light）、构建行为与 `test:mocks`（heavy）、tauri 端到端、R2、R3、R4 回归钉矩阵、暖构建下 mcp-server/dist 变更 / 缺失实验 |
| `coordinator/nail-hardened-C.test.ts` | 协调者按变异结果再加固的回归钉全文（19 个变异体全杀，未入仓，待裁定） |
| `coordinator/record-loaded-timeline.txt`、`coordinator/q4-loaded-evidence.txt` | 「崩溃修复是否在 11-24 22:00 前加载」的日志与会话库取证（只留时间戳、工具名、链接实参与工具回执字符数） |
| `coordinator/served-8080.txt` | :8080 实际下发 web 形态的 curl 取证 |
| `coordinator/r3-*.txt`、`r3-raw/`、`r4-raw/` | R3、R4 的沙箱探针、live dry-run、回归钉变异与日志窗口原始输出（协调者一份、评审席一份）与评审席登记的原始文件瑕疵 |
| `coordinator/scripts/` | 协调者验证、取证、归档与改句脚本，按运行原样归档（路径写死为本机）。`report-corrections.py` 是对 report.md 行内勘误的逐条替换表（默认演练，`--apply` 才写） |
| `coordinator/hygiene-scan.txt` | 推送前卫生扫描（命中只留掩码） |

说明：

- **脱敏**：origin 是公开仓。归档时把真实教师的企微 id 统一换成 `TeachA`–`TeachG`；任务名与用户名之间的大小写差异（R3-I1 的要害）原样保留为 `TeachF` / `teachf`。日志取证里带消息正文的行、收藏页标题行未入档。协调者脚本里的教师 id 同样已脱敏（只动字符串字面量与注释；`r3-verify.py`、`archive.py` 两个脚本原本带真实 id，归档件里连脱敏对照表也换成了化名），照抄运行需换回真实 id。
- **原件**：各席报告与全部原始输出最初落在 `/tmp/glm54-recheck-20261125/`（易失），本目录收录的是其中承重的部分；没有收录的中间产物不承重。
- **R3 席的原始文件有它自己登记的瑕疵**，见 `r3-raw/00-corrections.txt`；归档的 `10-probe.txt` 不在作废之列。

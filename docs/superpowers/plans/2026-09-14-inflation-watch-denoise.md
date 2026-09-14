# 立项：merge inflation watch 观察哨降噪 + ingested_files 去重防线（2026-09-14）

> 由 lt-full-qc-2026-09-14 全库质检立项（报告 §五/§六-4）：succeeded_with_warnings 的 144 个 job 中
> **merge inflation watch 累计 1,829 条（128 jobs）**，为 warnings 面最大噪音源，淹没真正的可行动告警
> （guard-v2 拦截、redlink 降级、embed 失败）。
> **范围扩展（2026-09-14 max 评审 Important-1 并入，用户拍板同批走 SDD）**：ingested_files 静默去重
> 对「修复性重投」无任何观测面与流程防线（§五）——两类改动同 touching job result 结构与 warnings
> 语义，合并一个批次实施。本文件为实施计划，未实施。

## 一、现状测量（2026-09-14 全库）

- 发射点：`src-server/src/services/ingest_pipeline.rs:1740-1745` —— merge 输出长度 > (旧文+新文)×80% 即推入 `result.warnings`。
- 1,829 条实锺分解：**去重后仅 999 个不同页**；830 条（45%）为同一页跨批次重复告警（每次批量重摄/教材批合并都重发）。
- 999 页占全库 6.3%。09-10 质检已抽验定性：「实测零内部重复块，合并未压缩但无拼接劣化」——观察哨在当前阈值下基本恒噪。
- 噪音机制：教材/词条类合并天然压缩率有限（小实体条目合并后 0.6-0.9 倍是常态），80% 阈值对这类形态系统性过敏。

## 二、处置选项（F 项：inflation 降噪）

| 方案 | 内容 | 成本 | 建议 |
|---|---|---|---|
| A. 结构化分流 | inflation 移出 warnings，改记 `result->merge_stats`（页级数组：path/merged_len/combined_len） | 小（改 result 结构+消费方） | **推荐主案** |
| B. 阈值收紧 | 80% → 100%（输出超过两文之和才是真膨胀）+ 绝对量下限（如 merged > 20KB 才报） | 一行 | 与 A 叠加 |
| C. 批内去重 | 同 job 内同页只报一次 | 中（需 per-job set） | A 落地后自然包含 |
| D. 生命周期去重 | 页级 DB 状态记「已报过」 | 大（新状态列） | 不建议 |

推荐组合 **A+B**：warnings 只留 actionable 告警；真膨胀（>100% 且大体量）保留为 warning，其余进 merge_stats 供审计。消费方影响：web ingest 面板 warnings 列表（预计显示量大降，语义不变）；QC 审计改读 merge_stats（信息量反而增加，含长度数值）。

## 三、实施注意（沿既有坑清单）

- result jsonb 结构变更需兼容旧 job（读取处对 merge_stats 缺键容错；`IngestJobResult` 新字段一律 `#[serde(default)]`，先例=`merged_pages`，ingest_queue.rs:77-84）。
- web 面板中文化映射若含 warnings 文案匹配（r1 语义「面板中文映射」），同步新增键；消费方=`src/components/web/web-ingest-panel.tsx`。
- 回归测试：t8 模板 fixture 带 sources 参数（I-1 教训）；merge 路径单测加「>100% 告警仍在 warnings」「80-100% 只进 stats」两条断言。
- 部署：src-server release build + launchd 重载（避开周日 19:00 周报窗）+ build:web 不需要（纯 server 侧 result 结构，前端已容错缺键——实施时核 web 消费点确认）。

## 四、范围扩展：ingested_files 静默去重防线（max 评审 Important-1）

### 4.1 机制与事故先例（代码事实）

- 去重三件套：`check_ingested_file`（pipeline :1357-1377，DB 错误容错按未摄入）→ 跳过判定（:1997-2003，**同 project+同路径+同 content_hash+同 file_size → `Ok(None)`**）→ `mark_file_ingested`（:1380-1403 upsert，调用点 :1852）。
- **静默面有两个**：
  1. `Phase1Output::Done { sp, processed: None }`（:1655-1658）——dedup 跳过记 item `done`、零告警零计数；
  2. `pages_to_write == 0`（:1876 done 条件 `pages_written > 0 || pages_to_write == 0`）——step2 生成零页的源同样 done 零告警（bigmodel thinking 静默零页事故即此面的既遂先例）。
- 双事故先例（同一陷阱两次手工救援，均无防线沉淀）：
  - 09-02 直播回放批：零页重跑须先 `DELETE ingested_files 对应行` 再重 trigger（第二次误跑踩过 hash 秒跳过）；
  - 09-14 孤儿章批：job e8e73204 12 源中 11 章被去重吞掉（item_states 全 `done/null`，唯一线索是零页写入），备份后 DELETE 11 行重投 f753f756 才闭合。
- 教训口径（max 评审）：现有记忆只记了「事后检测」方法，操作者无规程可依、管线无观测面可报警。

### 4.2 防线设计（观测面 + 规程，不改去重语义）

设计原则：**dedup 跳过本身是 resume 快路径的预期行为，不进 warnings**（防再造 F 项要消灭的噪音）；进结构化计账；仅「整源零产出」类异常进 warnings。

- **G1 源级计账结构化**：`IngestJobResult` 增 `#[serde(default)]` 字段：
  - `dedup_skipped: Vec<String>`（dedup 跳过的 source_path 清单；如担心超长 job，cap + 计数兜底，评审裁）；
  - `zero_page_sources: Vec<String>`（processed 为 Some 但 pages 为空的源）。
  - 填充点：:1655-1658（None 分支）与 :1876 done 分支（pages_to_write==0）。
- **G2 零页源 warning**：`pages_to_write == 0` 时 push `"step2: source {} produced 0 pages (possible truncation/empty output)"`——actionable（对应 bigmodel thinking 静默零页类故障）。
- **G3 job 级汇总告警**：`written==0 && failed==0 && dedup_skipped.len()==total_sources` 时 push 一条汇总 warning：「all N sources dedup-skipped (unchanged content) — if a repair reingest was intended, clear ingested_files rows first (backup!)」——09-14 事故形态的直接报警面。补齐现有 ：1913 全败告警的对偶面（全败已有、全跳过没有）。
- **G4 操作规程落 docs**：修复性重投 SOP——①备份（`\copy (SELECT …) TO … CSV`）②DELETE 目标路径行 ③重 trigger ④按源对账页产出（job succeeded ≠ 源落库）。落点 docs/development.md「摄取运维」节（或独立 runbook，评审裁）；文中引用两次事故先例。
- **明确不做**：不给去重加 force 参数 / 不改去重语义本身（本批只加观测与规程；语义变更如需要另立项）。

## 五、任务分解（合并批次，SDD 执行序）

| # | 任务 | 内容 | 涉及 |
|---|---|---|---|
| Task 1 | F-A 结构化分流 | inflation 页级记录进 `result->merge_stats`（path/merged_len/combined_len），移出 warnings | pipeline :1740-1745；IngestJobResult |
| Task 2 | F-B 阈值收紧 | 80%→100% + 绝对量下限（merged > 20KB 方报警警级），其余只进 stats | 同上 |
| Task 3 | G1+G2 源级计账与零页告警 | `dedup_skipped`/`zero_page_sources` 计账 + 零页源 warning | pipeline :1655-1658 / :1876 |
| Task 4 | G3 全跳过汇总告警 | 整 job 零写入零失败全去重 → 汇总 warning | pipeline 收尾段（:1913 旁） |
| Task 5 | G4 规程文档 | 修复性重投 SOP 入 docs + 双事故先例引用 | docs/development.md |
| Task 6 | 测试与部署 | 见 §三回归测试清单 + G 项新断言；release 部署+launchd 重载 | 测试 + 运维 |

### 测试断言清单（Task 6 汇总）

1. inflation >100% 且 >20KB → 仍在 warnings；80-100% 或 <20KB → 只进 merge_stats（t8 模板带 sources 参数）。
2. dedup 跳过 → 进 `dedup_skipped` 计账、不产生 warnings 条目。
3. 零页源 → 进 `zero_page_sources` 且产生 1 条 warning。
4. 全跳过 job → 恰 1 条汇总 warning；部分跳过 → 无汇总。
5. 旧 job 行（result 无新键）反序列化兼容（serde default），web 面板渲染不炸。
6. 面板中文映射如按文案匹配 warnings，新文案补映射（r1 语义）。

## 六、关联

- lt-full-qc-2026-09-14 报告 §五（warnings 全量归类表）+ 附录 §F（本立项）+ §C-续（09-14 去重事故与 max 评审 Important-1）。
- 09-10 today-ingest-qc 报告 §二-11（109 条判定为观察哨噪音的首次定性）。
- 记忆锚：lt-corpus-scale-and-ingest-progress（09-02 零页重跑序列）、fix-completeness-traps #45（09-12 hash 判重 + 09-14 延伸）。

# 立项：merge inflation watch 观察哨降噪（2026-09-14）

> 由 lt-full-qc-2026-09-14 全库质检立项（报告 §五/§六-4）：succeeded_with_warnings 的 144 个 job 中
> **merge inflation watch 累计 1,829 条（128 jobs）**，为 warnings 面最大噪音源，淹没真正的可行动告警
> （guard-v2 拦截、redlink 降级、embed 失败）。本文件为立项材料，未实施。

## 一、现状测量（2026-09-14 全库）

- 发射点：`src-server/src/services/ingest_pipeline.rs:1740-1745` —— merge 输出长度 > (旧文+新文)×80% 即推入 `result.warnings`。
- 1,829 条实锺分解：**去重后仅 999 个不同页**；830 条（45%）为同一页跨批次重复告警（每次批量重摄/教材批合并都重发）。
- 999 页占全库 6.3%。09-10 质检已抽验定性：「实测零内部重复块，合并未压缩但无拼接劣化」——观察哨在当前阈值下基本恒噪。
- 噪音机制：教材/词条类合并天然压缩率有限（小实体条目合并后 0.6-0.9 倍是常态），80% 阈值对这类形态系统性过敏。

## 二、处置选项

| 方案 | 内容 | 成本 | 建议 |
|---|---|---|---|
| A. 结构化分流 | inflation 移出 warnings，改记 `result->merge_stats`（页级数组：path/merged_len/combined_len） | 小（改 result 结构+消费方） | **推荐主案** |
| B. 阈值收紧 | 80% → 100%（输出超过两文之和才是真膨胀）+ 绝对量下限（如 merged > 20KB 才报） | 一行 | 与 A 叠加 |
| C. 批内去重 | 同 job 内同页只报一次 | 中（需 per-job set） | A 落地后自然包含 |
| D. 生命周期去重 | 页级 DB 状态记「已报过」 | 大（新状态列） | 不建议 |

推荐组合 **A+B**：warnings 只留 actionable 告警；真膨胀（>100% 且大体量）保留为 warning，其余进 merge_stats 供审计。消费方影响：web ingest 面板 warnings 列表（预计显示量大降，语义不变）；QC 审计改读 merge_stats（信息量反而增加，含长度数值）。

## 三、实施注意（沿既有坑清单）

- result jsonb 结构变更需兼容旧 job（读取处对 merge_stats 缺键容错）。
- web 面板中文化映射若含 warnings 文案匹配（r1 语义「面板中文映射」），同步新增键。
- 回归测试：t8 模板 fixture 带 sources 参数（I-1 教训）；merge 路径单测加「>100% 告警仍在 warnings」「80-100% 只进 stats」两条断言。
- 部署：src-server release build + launchd 重载（避开周日 19:00 周报窗）+ build:web 不需要（纯 server 侧 result 结构，前端已容错缺键——实施时核 web 消费点确认）。

## 四、关联

- lt-full-qc-2026-09-14 报告 §五（warnings 全量归类表）。
- 09-10 today-ingest-qc 报告 §二-11（109 条判定为观察哨噪音的首次定性）。

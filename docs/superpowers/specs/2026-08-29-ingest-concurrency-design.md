# src-server ingest 并发化（job 内 source 级）设计方案

- **日期**：2026-08-29（2026-08-30 设计评审 r1 修订版；round2 定稿）
- **状态**：round2 **Approve——spec 定稿可进实现**；round2 唯一 Minor（G-1 论据句
  Display 链更正）已并入
- **评审记录**：r1 = .superpowers/ingest-concurrency-design-review-2026-08-30/report.md
  （4I+5M+1 全收口）；round2 = 同目录 round2-report.md（Approve + G-1 论据句更正）
- **范围**：src-server 摄取管线 `run_ingest_job` 执行模型改造——source 级生成并发 + 归并串行两段分离；worker 层 / 归并语义 / 尾段 / CLI 契约零变化
- **分支**：`feat/ingest-concurrency`（充分评审 + 测试后才准合并）
- **背景动机**：82-173 视频批单 job 墙钟数小时，每源 ≈3 次 LLM 调用（step1 + step2 + review）全串行；N=3 并发下生成段近似 3x 墙钟

## 背景与问题

LT 师训知识库（src-server :8080，team 916 / project 614）的大批量视频摄取（58/173/82 三批）
单 job 墙钟数小时。瓶颈核实为 LLM 调用串行：job 内 source 逐个处理，每源固定 ≈3 次
LLM 调用 + 碰撞时 merge 调用，无任何并发。此前 transcriber CLI 转写层已验证 2-3 路并发
的本地 GPU 相位错开收益；server 摄取层是最后一个串行段。

**已核实的关键机制事实**（设计依据，含 r1 更正）：

| 事实 | 出处 |
|------|------|
| 三层串行：worker 单 tokio task 一次一 job（BRPOP）；job 内 source for 循环串行；尾段 reserved 重建 + 批量 embed | ingest_worker.rs:26-127；ingest_pipeline.rs:1100-1315、1322-1358 |
| **竞争点 1**：`update_item_state` 是 JSONB 读-改-写（SELECT 全量数组 → 改 → UPDATE 全量写回），并发调用丢更新 | ingest_queue.rs:354-370 |
| **竞争点 2**：wiki_pages 碰撞归并链 fetch_existing → collision_mode → merge LLM → upsert 是读-改-写，并发同路径 = 后者静默覆写前者（不合并、丢多源累积） | ingest_pipeline.rs:1163-1250、1497-1546 |
| **竞争点 3**：progress 公式按 source 序号（`i*100/total` / `(i+1)*100/total`），并发下失义 | ingest_pipeline.rs:1123、1308-1314 |
| **竞争点 4**：LLM merge 不满足交换律（A⊕B ≠ B⊕A），归并顺序必须确定 | merge_pages_via 语义 |
| **竞争点 5**：`done_this_run` / warnings 共享计账，并发需原子化或串行化 | ingest_pipeline.rs:1071-1086 |
| `process_source_path` 已经是纯生成段：读字节 + 解析 + hash 去重 + step1（redis 缓存）+ step2 + review 计算，**不写 wiki_pages**；元数据/reviews 上浮给调用方延迟写 | ingest_pipeline.rs:1369-1488 |
| 并发安全面：step1 缓存 = redis content-hash 键幂等 SET；ingested_files 读为 SELECT、写有 UNIQUE(project_id, original_path)；review 为纯插入；embed 尾批单调用 | ingest_pipeline.rs:355-390、969-1015、1269-1279、1346-1358 |
| 图谱完全不涉及：on-demand TTL 缓存（LazyLock Mutex HashMap），ingest 不写图谱 | graph.rs:197-198、262、396 |
| `check_cancel` 有写副作用：命中即 mark_job_cancelled + 发 job_cancelled 事件 + Err(Cancelled) | ingest_queue.rs:296-304 |
| **stage 有消费者（r1 更正，原"无消费者"系证伪）**：web 摄取面板**轮询**（非 EventSource，早期 grep 漏检）渲染 `处理中… ${job.stage ?? job.status}`——裸字符串透传、无枚举匹配，故表示法变更不破坏功能，但会中英混排显示（§2 附 UI 小改） | src/components/web/web-ingest-panel.tsx:72；web-ingest-panel.test.tsx:38、81 mock 了 "parsing"/"generating" |
| 429 映射链：HTTP 429 → `LlmError::RateLimited` → `AppError::LlmApiError`；step1 层单测钉死不重试（非上下文错误直接失败）；step2/review/merge 均无重试；`is_transient_msg` 不含 rate 类模式 → job 级也非 transient | llm_stream.rs:207-209；ingest_pipeline.rs:1967-1972（`step1_chat_no_retry_on_other_errors`）；ingest_queue.rs:40-44 |
| LLM 调用无超时（pipeline 三处 `timeout_secs: None`）→ 调用挂死 = job 卡 running；与今日等价（非回归），recover_pending 兜底 | ingest_pipeline.rs:442、903、942 |
| **CLI 契约**：transcriber 轮询终态（TERMINAL_JOB_STATUSES）+ 解析 `item_states` 形状 `[{path,status,error}]`——必须保持 | tools/transcriber/src/api-client.ts:53-60、cli.ts:317 |
| 测试基建：ingest 四件套集成测（ingest 158 行 / reliability 371 / queue 139 / merge 541）+ HTTP stub 伪造 LLM（team provider base_url 指向 stub 根）成熟可用 | tests/integration/*.rs；merge_ingest_test.rs:30-171 |
| config env 命名模式：`__` 分隔（如 `PAGE_RATE_LIMITS__S_PER_MIN`），AppConfig 结构体 + serde default | config.rs:283-321 |
| 集成测 PG@5433 + Redis@6380（docker），`#[ignore]` 门显式跑——不打爆 live DB | ingest_reliability_test.rs:2 |

## 方案选型

| 方案 | 概要 | 判定 |
|------|------|------|
| **A（选定）** | 两段分离：生成段（解析 + 全部生成 LLM）并发 N 路；归并段（碰撞/merge/落库/计账）按源序串行；尾段与 worker 层不动 | 竞争点全部留在串行段天然消解；零锁零迁移；CLI 契约、重试/续传语义零变化；改动集中 `run_ingest_job` |
| B | 全链路并发 + per-path tokio Mutex + item_states SQL 原子化（或拆表迁移） | merge 调用占比小、收益边际；锁粒度/merge 非确定性/迁移面大增，违背"充分评审后才合并"的成本预算 |
| C | 多 worker job 级并发 | 不解决单 job 墙钟（实际痛点）；引入跨 job 同项目页面竞争；LT 单项目零收益。否 |

## 设计

### §1 生成段（并发）

`process_source_path` **原函数零改动**复用——它天然就是生成段（不写 wiki_pages）。

```
生成段（独立 tokio task）：
  stream::iter(去重后的待处理源).map(|sp| async {
      peek_cancel?                   // ① 领任务检查点（只读 SELECT，不 mark——见 B-3）
      process_source_path(sp)        //    全部生成 LLM 调用
  }).buffered(N)                     // 保序 + 并发度 N
  → mpsc::channel(cap = 32)          // 与归并段解耦

归并段（run_ingest_job 主协程）：
  while let Some(item) = rx.recv().await { … }   // §2
```

- **`buffered(N)` 而非 `buffer_unordered`**：产出顺序 = 源序（tokio 含义上的保序
  buffer），归并段的 merge 顺序与今日串行执行完全一致。
- **channel 解耦防饿死**：若归并段直接拉 `buffered(N)` 流，归并段烧 merge LLM
  （分钟级）期间不 poll 流 → 生成管线停摆。独立生成 task + 有界 channel 后，
  归并段慢只触发背压（channel 满 → 生成段 send 阻塞），并发段持续满速。
  内存上界 = (N + 32) × 单源产物（~10-100KB），LT 规模 ~ 数 MB。
- **dispatch 去重（r1 控制器补项）**：同 job 重复 source_path 在 dispatch 时保序
  去重（首现保留）——消除"第二出现的生成段跑在第一出现 mark_file_ingested 之前
  → hash 未命中 → 重跑 step2+review"的角点（今日串行下靠 hash 命中天然防，CLI
  targets 唯一，纯防御）。
- **错误映射（r1 C-1 修正）**——map 闭包内三类错误各有归属，不允许漂移：

```rust
enum Phase1Output {
    /// processed = None 表示 hash 未变跳过（今日 Ok(None) 分支）
    Done { sp: String, processed: Option<ProcessedSource> },
    /// 单源生成失败（今日 1300-1305 同款：warning + item_state=failed，源级隔离）
    Failed { sp: String, err: String },
    /// ① peek 命中 cancel（归并段负责唯一的 mark_job_cancelled——B-3 单事件保证）
    Cancelled,
    /// ① peek 的 SELECT 出错等 job 级异常——携带 AppError 原值透传，
    /// 保住 worker is_transient_job_err 的原始分类（DatabaseError → 自动退避重试）
    JobError(AppError),
}
```

- **① 是 peek 不是 check（r1 B-3 修正）**：并发的 N 个领任务检查若各自调
  `check_cancel`（有 mark + 发事件副作用），会重复 UPDATE + 重复 job_cancelled
  事件。①改为只读 SELECT `cancel_requested`，命中产出 `Cancelled` 变体；唯一的
  `mark_job_cancelled` 由归并段收到变体时执行（每 job 恰一次，事件恰一条）。
- **dispatch 过滤**：`job.item_states` 中已 done 的源不进入流（今日 1105-1121 的
  resume 跳过，省 LLM/embedding）。

### §2 串行归并段

**今日 1137-1305 循环体的写入/计账/合并语义原样搬移**：transcripts/ 守卫、碰撞判定
Replace/Merge、merge LLM + 截断防线 + 整页回退、`fold_page_write_outcomes` 计账、
deferred-write 不变量（upsert 全成才 mark_file_ingested + review 插入）、item_state
done/failed 分流、all-failed 判定。

**取消检查点重构（r1 B-1 裁定：drain-received）**——今日三处检查点（源前 / 页前 /
尾段）在并发结构下收敛为两处：

- **移除归并段 item 开头检查点（原②）与页级检查点**。理由：cancel 置位后这两个
  检查点会在处理已生成 cohort 时立刻命中，把已付 LLM 成本的成果整体丢弃（最多
  N+32 个源），既不等价于今日（今日在飞源完整落库）也违背 drain 精神；且二者与
  drain 根本互斥（页级检查点在 drain 逐项处理时必命中，drain 流不动）。
- **终止信号 = ①产出的按序 `Cancelled` 变体**：生成段对 cancel 后的新任务立即
  产出 Cancelled（零 LLM 消耗）；该变体在保序流中位于全部已启动任务（在飞 cohort）
  的 Done 之后——归并段在收到它之前**完整落库全部已生成成果**（含 item_state），
  收到时执行唯一一次 `mark_job_cancelled` 并返回 `Err(AppError::Cancelled)`
  （今日 worker 传播路径不变）。
- **尾段检查点保留**（兜底：cancel 发生在全部任务已启动之后 → 无 Cancelled 变体
  产出 → 尾段 check_cancel 命中，今日语义）。
- **F1 威胁被结构性约束**：今日页级检查点防的是"取消后继续逐页 merge 烧完全部
  剩余调用（小时级、无界）"。新结构下取消后的归并烧配额集合 = 已生成 cohort
  （≤ N + 32 个源），生成新任务的口子在①关闭——**有界**。与今日的诚实差异：
  今日取消后 merge 烧 0 次，新设计最多烧完已生成 cohort 的碰撞页（视频批 ≈ 0，
  书籍批最坏几十分钟）。方向是"多保留成果换有界成本"，与 drain 裁定一致。

逐项等价核对：

| 语义 | 今日 | 并发版 |
|------|------|--------|
| item_states 形状 | `[{path,status,error}]` | 不变 → CLI 兼容 |
| merge 顺序 | 源序 | 源序（buffered 保序 + channel 单生产者按序 send） |
| warnings 顺序 | 源序 | 源序（归并段按序处理） |
| all-failed 判定 | `done_this_run == 0` | 同；初值 = job 快照中 prior-done 计数（等价今日 already_done 分支的 `done_this_run += 1`） |
| 取消 | 在飞源完整落库；取消点后零 merge 烧 | drain：已生成 cohort 完整落库（**更完整**，item_states 多保留）；差异 = 取消后 merge 烧配额从 0 变为有界（≤ N+32 源的碰撞页，见上） |
| merge_provider | 懒获取一次 | 不变（归并段串行持有） |
| existing_paths 清单 | job 开始查一次 | 不变（§2 slug 对齐语义本就是 job 级快照） |
| 尾段 | reserved 重建（事务）+ 批量 embed | 原样不动 |
| worker 层 | 单 job 串行 | 不动（跨 job 竞争不存在） |

**stage/progress 表示法变更（有消费者，r1 D-1 更正）**：

- 今日：每源两次 `update_job_stage("parsing"/"generating", i*100/total)`（序号失义）
- 并发版：job 开始一次 `stage="processing"`；每 item 完成（含 Failed 与 hash 跳过）
  `progress = 完成item数 * 100 / total.max(1)`（total = `job.source_paths.len()`，
  初值含 prior-done 数——与今日公式分母口径一致；散布 resume 中间值与今日不同但
  单调、终值同为 100）；尾段 `building_index` 照旧
- 消费者 = web 摄取面板（轮询裸透传渲染 `处理中… ${job.stage}`）——无枚举匹配
  不破坏功能，但显示会变"处理中… processing"（中英混排）。**附带 UI 小改**：
  面板加 stage → 中文映射（processing→处理中、building_index→构建索引，保留
  parsing→解析中 / generating→生成中 兼容在飞旧 job），未知值裸透传；面板测试
  mock 同步更新。前端改动 → 部署需 build:web
- DB 写次数略降（每源 2 次 stage 写 → 1 次 progress 写）；item_done/item_failed
  SSE 事件照发

### §3 尾段（不变）

reserved 三页重建（事务）→ all-failed 判定 → 批量 `embed_and_store`。代码零改动
（含尾段 check_cancel 兜底，见 §2）。

### §4 并发度配置

- `AppConfig` 新增 `IngestConfig { source_concurrency: usize }`（`#[serde(default)]`）
- 默认 **3**（对齐 transcriber 侧用户裁定），env `INGEST__SOURCE_CONCURRENCY`
- 启动读取时 clamp 到 1..=8（超上限 warn 日志 + 截断；0 或缺省异常值 → 1）
- **不加** API / CLI per-job 并发参数（单操作者机器，env 足够——YAGNI）
- step1 逐 chunk 串行保持（每源内部串行，源间才并发）——非目标不改

### §5 取消 / 重试 / 续传 / 部署语义（r1 B-1/B-2 重写）

**取消（drain-received，写死）**：

1. cancel 置位 → ①peek 对**未启动**任务立即产出 Cancelled 变体（零 LLM 消耗；
   领新停止）
2. **已启动 cohort（≤ N 个在飞 + channel 已缓冲）完整跑完并落库**：在飞任务
   ①已过 → 正常生成 → Done → 按源序经 channel 到达 → 归并段照常落库（页 +
   item_state=done）。此期间归并段的 merge 照常执行（有界成本，§2）
3. 归并段收到按序 Cancelled 变体 → 唯一一次 `mark_job_cancelled` → 返回
   `Err(AppError::Cancelled)` → worker 记日志不重试（今日同款）
4. 尾段兜底：全部任务启动后才 cancel → 无变体 → 尾段 check_cancel 命中

**孤儿生成段的 drop-abort 真相（r1 B-2 修正，替代原"在飞调用跑完"的错误描述）**：

- **正常取消路径无 abort**：drain 语义下 rx 存活到 Cancelled 变体被消费，在飞
  cohort 在变体之前全部完成送达——generator break 时 stream 内已无带真实工作的
  future（cancel 后新 poll 的任务都在①秒退，未 poll 的从未启动）。
- **异常路径存在 abort**：归并段因 `JobError` 变体或 §6 不变量提前返回 → rx
  drop → generator 的 send 立即失败 → break → stream 被 drop → **在飞 future
  全部取消，reqwest 连接中途关闭**（不是"跑完丢弃"）。
- **abort 安全性论证**：生成段唯一持久写 = step1 缓存 SET（LLM 调用成功后、
  `process_source_path` 尾部原子执行；redis SET 单命令原子）→ abort 的调用必未
  写缓存 → 重试时重跑该源，无半写状态。abort 反而省配额（远端可能已生成，
  连接关闭后不计入我们的等待）。

**重试**：worker 层 transient 判定 / 退避 / mark_job_retry_pending 全不动。
`JobError` 变体原值透传（C-1）保证 ① 的 DB 抖动仍走 DatabaseError → transient
→ 自动退避重试。

**续传**：resume 跳过逻辑移到 dispatch 过滤（§1）；`recover_pending` 重投安全；
跨版本互通（item_states 契约不变 + step1 缓存跨版本命中）。drain 使 cancel 后
manual_retry 的续传更省——被 drain 落库的源不再重烧 step2/review。

**部署**：纯 server 改动 + 面板 stage 映射小改（前端 → build:web）；src-server 内
`cargo build --release`（必须在 src-server/ 目录，根目录是另一个 workspace）→
launchd bootout+bootstrap；教师消息高峰期避免重启（既有运维铁律）；重启时在飞
job 走 recover_pending 重投。

### §6 生成段异常终止防护（计数不变量）

生成段 task 若 panic（今日等价场景：panic 直接击穿 worker task，job 卡 running），
channel 关闭、归并段 `recv()` 提前返 None——若无防护会**静默走尾段把残缺 job 标
succeeded**。防线：

- 生成段对每个 target 恰好 send 一个 `Phase1Output`（Cancelled / JobError 之后
  break 不再 send）
- 归并段维护 `expected = targets.len()`；channel 提前关闭（recv None）且已收数 <
  expected 且未见 Cancelled/JobError → `Err(InternalError("generator terminated
  early"))` → worker 走 mark_job_failed（可 manual_retry 自愈）
- **防护边界（r1 C-3 如实声明）**：本不变量只防"提前死"，不防"永不起"——LLM
  调用无超时（`timeout_secs: None`），单调用挂死则 job 卡 running。与今日等价
  （非回归）；remedy = 重启后 recover_pending 重投。加超时属独立加固，非本设计
  范围

### §7 配额与限流（r1 G-1 新增）

**风险评估（如实）**：zai glm-5.3-flash 与教师对话 + 桌面库共用 5h 窗配额池，
code 1308（429）在本机有实证史（标点回填 final 轮 76 error 全是 429）。server
侧对 429 现状零防御：429 → 单源 failed（`step1_chat_no_retry_on_other_errors`
钉死不重试）+ job 级非 transient。N=3 把峰值请求速率放大 3 倍打向共池 → 429
概率上升；极端 all-failed → job failed。

**缓解（承重改动）**：

- **429 归入 transient 分类**——注意真正批量承重的是 **all-failed 路径**（源级
  失败全是 warning，只有 all-failed 才以 job 级 Err 到达 worker，错误文本经
  warnings join 后包含 "Rate limited" 字样——429 在 llm_stream.rs:207 前置映射
  为 RateLimited，**不会以 "API error 429" 形态出现**；故三模式中承重的是
  "rate limit"，两处匹配均先 lowercase，不可精简掉该模式）：
  - `is_transient_job_err` 的 InternalError 分支（all-failed 承重）：追加
    `"http 429"` / `"api error 429"` / `"rate limit"` 子串匹配
  - `is_transient_msg`（LlmApiError 分支，双保险 + 未来直传路径）：同步追加同
    三模式
  - 语义：全部源 429 → job 瞬态 → 自动退避重试（step1 缓存命中使重试便宜，
    max_retries 封顶防抖）；部分源 429 → 与今日同款 succeeded_with_warnings +
    manual_retry（不引入源级 429 重试循环——范围控制，v1 非目标）
- **运维指引**：大批量摄取维持夜间错峰（既有惯例）；白天应急跑批可
  `INGEST__SOURCE_CONCURRENCY=1` 收敛峰值（env 热改需重启，接受）
- **同批同 content-hash 并发双跑（r1 A-2 接受）**：两源同内容并发 → 双跑 step1 +
  并发 SET 同键（last-writer-wins，形状守卫兜底无污染）。纯成本有界（同内容源
  罕见），接受，不做按 hash 串行化

## 语义保持清单（验收基线）

1. `item_states` 形状 `[{path,status,error}]` 不变（CLI parseFailedItemStates 兼容）
2. 终态机不变（succeeded / succeeded_with_warnings / failed / cancelled + 重试转移）
3. merge 顺序 = source 顺序（确定性保持）
4. warnings 顺序 = source 顺序
5. 取消 = drain-received：已生成 cohort 完整落库（今日在飞源完整落库的推广）；
   取消点后 merge 烧配额从 0 变为有界（≤ N+32 源碰撞页）——**本设计唯一的取消
   语义差异，已裁定接受**
6. resume = item_states done 跳过；drain 使 cancel 后续传更省
7. deferred-write 不变量 = upsert 全成才 mark + review
8. transcripts/ 守卫、W2 path 校验、step1 形状守卫等纯函数零改动
9. all-failed 判定含 prior-done 计数；① 的 job 级异常经 JobError 变体保 transient
   分类（今日 1102 检查点错误传播等价）
10. stage/progress 表示法变更（消费者 = web 面板裸透传，附中文映射 UI 小改 +
    build:web 部署）；取消事件恰一条（①只读 peek + 归并段单次 mark）

## 非目标

- job 间并发（worker 层多 job 并行）——明确不做
- 归并段 / merge LLM 并发化（方案 B 的 per-path 锁）——明确不做
- step1 chunk 级并发（每源内部多 chunk 并行）——保持源内串行
- per-job 并发度 API 参数——env 配置足够
- embedding 分批化 / 流式化——尾批单调用语义保持
- 源级 429 重试循环 / LLM 调用超时加固——独立加固项，另行立项

## 已知接受（r1 Minor 收编，各一行）

- **A-1**：review 生成段实时读 `fetch_overview` + `fetch_index_snippet`
  （review.rs:331-334）——并发下后续源的 review prompt 看到 job 前状态（今日
  串行可见渐进落库）。reviews 是建议性 + 延迟落库，不破坏不变量；质量级漂移，
  接受。
- **A-2**：同 hash 并发缓存竞态——见 §7，接受。
- **B-3**：双 mark_job_cancelled——①改 peek 后结构性消解（每 job 恰一次 mark +
  恰一条事件）。
- **C-3**：LLM 无超时挂死——见 §6 防护边界，与今日等价。
- **D-2**：新 progress 公式保留 `total.max(1)` 守卫；散布 resume 中间进度值与
  今日不同但单调、终值同为 100。
- **控制器补**：同 job 重复 source_path——dispatch 保序去重消除（§1），无重跑。

## 测试与验收

**单测**（`cargo test --lib`，真零 DB）：现有纯函数套件零回归（碰撞判定 / 计账
折叠 / FILE block 解析 / 缓存判定等 40+ 用例不动）；新增：

- progress 计算纯函数（含 total.max(1) 与 prior-done 初值）
- 生成段计数不变量判定（收数 < expected 且无 Cancelled/JobError → Err）——§6
- dispatch 去重纯函数（保序首现）
- transient 模式扩展（429 三模式在 LlmApiError 与 InternalError 两分支的分类）

**集成测**（PG@5433 + Redis@6380，`#[ignore]` 门，沿用 merge_ingest_test 的
HTTP stub 伪造 LLM 模式）：

1. **并发正确性**：3 源 N=2，stub 延迟乱序（后源快先完成）→ 全部落库、
   item_states 全 done、页面内容正确
2. **确定性归并**：两源生成同 path 页（碰撞 merge），stub 让后源先完成 →
   断言 merge 调用序列仍是源序（stub 记录调用次序断言）
3. **取消 drain 语义**：N=3 多源 job 中途 request_cancel → cancelled 终态；
   **在飞 cohort 页面全部落库 + item_states 全 done**（drain 断言）；stub 调用
   计数 = 已完成 + ①已过的在飞数（精确值——正常取消路径无 abort，stub 延迟
   可控）；job_cancelled 事件恰一条
4. **resume**：预置 item_states 部分 done → 只处理剩余源（stub 调用计数精确
   断言）
5. **单源失败隔离**：一源 stub 返 500 → 该源 failed、其余 done、job
   succeeded_with_warnings
6. **N=1 等价性**：并发度 1 跑全套现有 ingest 集成用例（buffered(1) + channel
   ≈ 今日串行，作为结构重构的回归保险）
7. **生成段计数不变量**：判定逻辑纯函数单测覆盖（收数 < expected 且无
   Cancelled/JobError → Err）；panic 实注入集成测仅在实现代价可控时加（测试
   钩子），否则纯函数覆盖为准
8. **cancel × channel 积压交织**（r1 F-1 补）：归并段 merge 慢制造积压 +
   cancel → 断言积压 cohort 全落库、变体后零新 LLM 调用
9. **cancel → manual_retry → resume 链路**（r1 F-1 补）：drain 落库的源在
   retry 后不重烧（step1 缓存命中 + step2 stub 计数为零）
10. **散布 resume + 并发 + 进度序列**（r1 F-1 补）：prior-done 散布 → progress
    单调、初值含 prior-done、终值 100
11. **N clamp 边界**（r1 F-1 补）：env 0 / 9 → 1 / 8 + warn 日志
12. **①非 Cancelled 错误分类**（r1 F-1 补）：① peek SELECT 故障注入（或等价
    桩）→ JobError 变体透传 → job 瞬态重试路径（retry_count++）
13. **终态表示法**（r1 F-1 补）：终态 progress=100 且无 parsing/generating 残留
    stage；web 面板 stage 中文映射渲染（面板测试更新 mock）
14. **all-failed 429 瞬态**（r1 G-1）：全源 stub 429 → job 瞬态重试
    （retry_count++ + 重投）

**现有四件套**（ingest / reliability / queue / merge）在新结构下原样通过——天然
回归网。

**验收标准**：全部测试绿 + 现有用例零语义漂移（清单 §语义保持 1-10）+
code-review 完整流程通过（用户铁律：充分评审测试后才合并）。

## 部署与回滚

- 部署：src-server 内 `cargo build --release`（必须在 src-server/ 目录，根目录是
  另一个 workspace）→ launchd bootout+bootstrap；面板 stage 映射小改 →
  `npm run build:web`
- 回滚：revert 提交 + 重启即回串行模型；在飞 job 跨部署由 recover_pending 重投，
  resume 语义两版互通（item_states 契约不变 + step1 缓存命中）
- 观测：job 墙钟对比（同规模批次）；web 摄取面板核对新 stage 中文文案与
  progress 推进

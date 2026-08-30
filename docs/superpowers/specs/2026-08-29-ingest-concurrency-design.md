# src-server ingest 并发化（job 内 source 级）设计方案

- **日期**：2026-08-29
- **状态**：brainstorming 分节设计五节全部确认（方案 A）→ spec 待审
- **范围**：src-server 摄取管线 `run_ingest_job` 执行模型改造——source 级生成并发 + 归并串行两段分离；worker 层 / 归并语义 / 尾段 / CLI 契约零变化
- **分支**：`feat/ingest-concurrency`（充分评审 + 测试后才准合并）
- **背景动机**：82-173 视频批单 job 墙钟数小时，每源 ≈3 次 LLM 调用（step1 + step2 + review）全串行；N=3 并发下生成段近似 3x 墙钟

## 背景与问题

LT 师训知识库（src-server :8080，team 916 / project 614）的大批量视频摄取（58/173/82 三批）
单 job 墙钟数小时。瓶颈核实为 LLM 调用串行：job 内 source 逐个处理，每源固定 ≈3 次
LLM 调用 + 碰撞时 merge 调用，无任何并发。此前 transcriber CLI 转写层已验证 2-3 路并发
的非线性收益（GPU/网络相位错开），server 摄取层是最后一个串行段。

**已核实的关键机制事实**（设计依据）：

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
| LLM 调用无共享限流器（rate_limit.rs 只覆盖 HTTP 端点）；zai 并发调用安全（transcriber 2-3 路已实证） | rate_limit.rs 全文 |
| **CLI 契约**：transcriber 轮询终态（TERMINAL_JOB_STATUSES）+ 解析 `item_states` 形状 `[{path,status,error}]`——必须保持 | tools/transcriber/src/api-client.ts:53-60、cli.ts:317 |
| stage/progress 无消费者：SSE 端点存在（routes/ingest.rs:130）但前端无订阅（src/lib 唯一 EventSource 是 streamChat）；CLI 只看 status | 全仓 grep 核实 |
| 测试基建：ingest 四件套集成测（ingest 158 行 / reliability 371 / queue 139 / merge 541）+ HTTP stub 伪造 LLM（team provider base_url 指向 stub 根）成熟可用 | tests/integration/*.rs；merge_ingest_test.rs:30-171 |
| config env 命名模式：`__` 分隔（如 `PAGE_RATE_LIMITS__S_PER_MIN`），AppConfig 结构体 + serde default | config.rs:283-321 |
| 集成测 PG@5433 + Redis@6380（docker），`#[ignore]` 门显式跑——不打爆 live DB | ingest_reliability_test.rs:2 |

## 方案选型

| 方案 | 概要 | 判定 |
|------|------|------|
| **A（选定）** | 两段分离：生成段（解析 + 全部生成 LLM）并发 N 路；归并段（碰撞/merge/落库/计账）按源序串行；尾段与 worker 层不动 | 竞争点全部留在串行段天然消解；零锁零迁移；CLI/取消/重试/续传语义零变化；改动集中 `run_ingest_job` |
| B | 全链路并发 + per-path tokio Mutex + item_states SQL 原子化（或拆表迁移） | merge 调用占比小、收益边际；锁粒度/merge 非确定性/迁移面大增，违背"充分评审后才合并"的成本预算 |
| C | 多 worker job 级并发 | 不解决单 job 墙钟（实际痛点）；引入跨 job 同项目页面竞争；LT 单项目零收益。否 |

## 设计

### §1 生成段（并发）

`process_source_path` **原函数零改动**复用——它天然就是生成段（不写 wiki_pages）。

```
生成段（独立 tokio task）：
  stream::iter(待处理源).map(|sp| async {
      check_cancel?                 // ① 领任务检查点（软停：不再领新）
      process_source_path(sp)       //    全部生成 LLM 调用
  }).buffered(N)                    // ② 保序 + 并发度 N
  → mpsc::channel(cap = 32)         // ③ 与归并段解耦

归并段（run_ingest_job 主协程）：
  while let Some(item) = rx.recv().await { … }   // §2
```

- **`buffered(N)` 而非 `buffer_unordered`**：产出顺序 = 源序（tokio 含义上的保序
  buffer），归并段的 merge 顺序与今日串行执行完全一致。
- **channel 解耦防饿死**：若归并段直接拉 `buffered(N)` 流，归并段烧 merge LLM
  （分钟级）期间不 poll 流 → 生成管线停摆。独立生成 task + 有界 channel 后，
  归并段慢只触发背压（channel 满 → 生成段 send 阻塞），并发段持续满速。
  内存上界 = (N + 32) × 单源产物（~10-100KB），LT 规模 ~ 数 MB。
- **失败隔离**：单源 `process_source_path` 失败不中断流，转为值传给归并段
  （今日 warning + item_state=failed 语义不变）：

```rust
enum Phase1Output {
    /// processed = None 表示 hash 未变跳过（今日 Ok(None) 分支）
    Done { sp: String, processed: Option<ProcessedSource> },
    Failed { sp: String, err: String },
    /// 领任务检查点命中（已 mark_job_cancelled）——归并段见此即终止
    Cancelled,
}
```

- **dispatch 过滤**：`job.item_states` 中已 done 的源不进入流（今日 1105-1121 的
  resume 跳过，省 LLM/embedding）。

### §2 归并段（串行）

**今日 1137-1305 循环体逻辑原样搬移**，一字不动的语义清单：

- item 开头 `check_cancel`（② 归并段检查点，与①双重保险、幂等）
- 页级 `check_cancel`（F1 修复保留：用户取消后不再逐页烧 merge LLM）
- transcripts/ 命名空间守卫（spec §3.2-⑤）
- 碰撞判定 Replace/Merge + merge LLM + 截断防线 + 整页回退
- `fold_page_write_outcomes` 计账 + deferred-write 不变量（upsert 全成才
  mark_file_ingested + review 插入）
- item_state done/failed 分流 + all-failed 判定

逐项等价核对：

| 语义 | 今日 | 并发版 |
|------|------|--------|
| item_states 形状 | `[{path,status,error}]` | 不变 → CLI 兼容 |
| merge 顺序 | 源序 | 源序（buffered 保序 + channel 单生产者按序 send） |
| warnings 顺序 | 源序 | 源序（归并段按序处理） |
| all-failed 判定 | `done_this_run == 0` | 同；初值 = job 快照中 prior-done 计数（等价今日 already_done 分支的 `done_this_run += 1`） |
| merge_provider | 懒获取一次 | 不变（归并段串行持有） |
| existing_paths 清单 | job 开始查一次 | 不变（§2 slug 对齐语义本就是 job 级快照） |
| 尾段 | reserved 重建（事务）+ 批量 embed | 原样不动 |
| worker 层 | 单 job 串行 | 不动（跨 job 竞争不存在） |

**唯一语义变化**：stage/progress 表示法（无消费者，已核实）——

- 今日：每源两次 `update_job_stage("parsing"/"generating", i*100/total)`（序号失义）
- 并发版：job 开始一次 `stage="processing"`；每 item 完成（含 Failed 与 hash 跳过）
  `progress = 完成item数 * 100 / total`（total = `job.source_paths.len()`，初值含
  prior-done 数——与今日公式分母口径一致）；尾段 `building_index` 照旧
- DB 写次数还略降（每源 2 次 stage 写 → 1 次 progress 写）；item_done/item_failed
  SSE 事件照发

### §3 尾段（不变）

reserved 三页重建（事务）→ all-failed 判定 → 批量 `embed_and_store`。代码零改动。

### §4 并发度配置

- `AppConfig` 新增 `IngestConfig { source_concurrency: usize }`（`#[serde(default)]`）
- 默认 **3**（对齐 transcriber 侧用户裁定），env `INGEST__SOURCE_CONCURRENCY`
- 启动读取时 clamp 到 1..=8（超上限 warn 日志 + 截断）
- **不加** API / CLI per-job 并发参数（单操作者机器，env 足够——YAGNI）
- step1 逐 chunk 串行保持（每源内部串行，源间才并发）——非目标不改

### §5 取消 / 重试 / 续传 / 部署语义

- **取消软停**（对齐 transcriber mapLimit 语义）：① 领任务检查点停止领新 →
  在飞 LLM 调用跑完 → 归并段在②或页级检查点收到 Cancelled → `Err(AppError::Cancelled)`
  返回 worker（今日传播路径不变）
- **孤儿生成段**：归并段提前 return 后 rx drop → 生成段 send 失败自然 break；
  在飞调用跑完丢弃结果。唯一写是幂等的 step1 缓存，无副作用（重试时命中缓存）。
  不 abort、不 await——注释说明
- **重试**：worker 层 transient 判定 / 退避 / mark_job_retry_pending 全不动
- **续传**：resume 跳过逻辑移到 dispatch 过滤（§1）；`recover_pending` 重投安全
- **部署**：纯 server 改动（无 web dist 重建）；launchd bootout+bootstrap 重载；
  教师消息高峰期避免重启（既有运维铁律）；重启时在飞 job 走 recover_pending 重投

### §6 生成段异常终止防护（计数不变量）

生成段 task 若 panic（今日等价场景：panic 直接击穿 worker task，job 卡 running），
channel 关闭、归并段 `recv()` 提前返 None——若无防护会**静默走尾段把残缺 job 标
succeeded**。防线：

- 生成段对每个 target 恰好 send 一个 `Phase1Output`（Cancelled 之后 break 不再 send）
- 归并段维护 `expected = targets.len()`；channel 提前关闭（recv None）且已收数 <
  expected 且未见 Cancelled → `Err(InternalError("generator terminated early"))`
  → worker 走 mark_job_failed（可 manual_retry 自愈）

## 语义保持清单（验收基线）

1. `item_states` 形状 `[{path,status,error}]` 不变（CLI parseFailedItemStates 兼容）
2. 终态机不变（succeeded / succeeded_with_warnings / failed / cancelled + 重试转移）
3. merge 顺序 = source 顺序（确定性保持）
4. warnings 顺序 = source 顺序
5. 取消 = 软停 + 检查点终止（领新停 / 在飞跑完 / 页级防线保留）
6. resume = item_states done 跳过
7. deferred-write 不变量 = upsert 全成才 mark + review
8. transcripts/ 守卫、W2 path 校验、step1 形状守卫等纯函数零改动
9. all-failed 判定含 prior-done 计数
10. 唯一变化：stage/progress 表示法（parsing/generating 双 stage 序号进度 →
    processing 单 stage + item 计数进度；无消费者，文档注明）

## 非目标

- job 间并发（worker 层多 job 并行）——明确不做
- 归并段 / merge LLM 并发化（方案 B 的 per-path 锁）——明确不做
- step1 chunk 级并发（每源内部多 chunk 并行）——保持源内串行
- per-job 并发度 API 参数——env 配置足够
- embedding 分批化 / 流式化——尾批单调用语义保持

## 测试与验收

**单测**（`cargo test --lib`，真零 DB）：现有纯函数套件零回归（碰撞判定 / 计账
折叠 / FILE block 解析 / 缓存判定等 40+ 用例不动）；新增进度计算与 dispatch
过滤的纯函数测试（若抽函数）。

**集成测**（PG@5433 + Redis@6380，`#[ignore]` 门，沿用 merge_ingest_test 的
HTTP stub 伪造 LLM 模式）新增用例：

1. **并发正确性**：3 源 N=2，stub 延迟乱序（后源快先完成）→ 全部落库、
   item_states 全 done、页面内容正确
2. **确定性归并**：两源生成同 path 页（碰撞 merge），stub 让后源先完成 →
   断言 merge 调用序列仍是源序（stub 记录调用次序断言）
3. **取消软停**：N=3 多源 job 中途 request_cancel → cancelled 终态 + stub 调用
   计数 ≈ 已完成 + 在飞（不再领新）
4. **resume**：预置 item_states 部分 done → 只处理剩余源（stub 调用计数精确断言）
5. **单源失败隔离**：一源 stub 返 500 → 该源 failed、其余 done、job
   succeeded_with_warnings
6. **N=1 等价性**：并发度 1 跑全套现有 ingest 集成用例（buffered(1) + channel ≈
   今日串行，作为结构重构的回归保险）
7. **生成段计数不变量**：判定逻辑抽纯函数单测覆盖（收数 < expected 且无 Cancelled
   → Err）；panic 实注入集成测仅在实现代价可控时加（测试钩子），否则纯函数覆盖为准

**现有四件套**（ingest / reliability / queue / merge）在新结构下原样通过——天然回归网。

**验收标准**：全部测试绿 + 现有用例零语义漂移 + code-review 完整流程通过
（用户铁律：充分评审测试后才合并）。

## 部署与回滚

- 部署：src-server 内 `cargo build --release`（必须在 src-server/ 目录，根目录是
  另一个 workspace）→ launchd bootout+bootstrap；无前端改动无需 build:web
- 回滚：revert 提交 + 重启即回串行模型；在飞 job 跨部署由 recover_pending 重投，
  resume 语义两版互通（item_states 契约不变）
- 观测：job 墙钟对比（同规模批次），stage/progress 新表示法在 logs 面板核对

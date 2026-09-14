//! inflation watch 去噪 / dedup 计账端到端集成测试（Task 6 断言清单 1-7）。
//! 复用 merge_ingest_test.rs 的 t8_ 脚手架（stub chat 服务器 + fixture 项目 +
//! 直插 ingest_jobs + 直调 run_ingest_job——编排铁律 C-3：绝不 enqueue 进 live Redis）。
//!
//! 断言清单落点（brief task-6）：
//! 1. inflation >100% 且 >20KB → warnings + merge_stats；<20KB → 只进 merge_stats
//!    （80-100% 桶已由 ingest_pipeline.rs 纯单测 inflation_80_to_100pct_stats_only 覆盖）。
//! 2. dedup 跳过 → dedup_skipped 计账、无逐源 warning（t8_dedup_skip_partial_no_summary）。
//! 3. 零页源 → zero_page_sources + 恰 1 条 warning（t8_zero_page_source_one_warning）。
//! 4. 全跳过 job → 恰 1 条 G3 汇总 warning；部分跳过 → 无汇总、计账完整（多源 job 变体）。
//! 5. mixed prior_done + dedup-skip resume → 不触发 G3（零误报锚，done=2 > dedup=1）。
//! 6. merge_stats JSON 形状（path/merged_len/combined_len 三键、实跑数值）钉在实跑 job 上。
//! 7. 旧 job 行 result 无新键 → serde default 反序列化 + JobResponse 透传不炸。
//!
//! 跑法同 t8 批：`cargo test --test integration t8_ -- --ignored --test-threads=1`。
//!
//! 多源 job 的 stub 消费序说明：source 并发（buffered(n)）下多源同时打 LLM 会乱序——
//! 本文件的混合形态均保证「被 dedup 跳过 / 被 prior-done 滤除的源零 LLM 调用」，
//! 实际消费 stub 的源至多一个，脚本序天然确定。

use llm_wiki_server::services::ingest_queue::IngestJobResult;

// merge_ingest_test.rs 的 pub(crate) 脚手架（同 crate 测试二进制内可见）。
use crate::merge_ingest_test::{
    t8_file_block, t8_insert_and_run, t8_prepare, t8_step1_json, t8_write_source, StubResp, T8Env,
};

// ── 多源 job 变体（brief 断言 4：t8_insert_and_run 是单源 ARRAY[$3]，须加多源）──

/// 直插 + 直跑公共尾段：读回 job 行 → run_ingest_job → 落终态（succeeded/failed）。
/// 失败 panic（Err 全文含 warnings 便于诊断）。模式逐字对齐 t8_insert_and_run。
async fn run_job_row(env: &T8Env, job_id: uuid::Uuid) -> IngestJobResult {
    let job: llm_wiki_server::services::ingest_queue::IngestJob =
        sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&env.state.db)
            .await
            .expect("回读 IngestJob");
    match llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job).await {
        Ok(res) => {
            sqlx::query("UPDATE ingest_jobs SET status='succeeded', finished_at=NOW() WHERE id=$1")
                .bind(job_id)
                .execute(&env.state.db)
                .await
                .expect("落 succeeded 终态");
            res
        }
        Err(e) => {
            sqlx::query(
                "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
            )
            .bind(e.to_string())
            .bind(job_id)
            .execute(&env.state.db)
            .await
            .expect("落 failed 终态");
            panic!("run_ingest_job 应返回 Ok: {e}");
        }
    }
}

/// 多源 job：source_paths = $3 直绑 Vec<String>（text[]），返回 job_id 供重试场景复用行。
async fn t8_insert_and_run_multi(env: &T8Env, sources: &[&str]) -> (uuid::Uuid, IngestJobResult) {
    let job_id = uuid::Uuid::new_v4();
    let srcs: Vec<String> = sources.iter().map(|s| s.to_string()).collect();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, $3, 'running')",
    )
    .bind(job_id)
    .bind(env.pid)
    .bind(srcs)
    .execute(&env.state.db)
    .await
    .expect("insert 多源 ingest_jobs 行");
    let res = run_job_row(env, job_id).await;
    (job_id, res)
}

/// 收尾：SWEEPS 清理 + 收 stub。
async fn finish(env: &T8Env) {
    crate::teardown_test_data(&env.state).await;
    env.stub.abort();
}

// ── 断言 1 + 6：inflation 阈值分流 + merge_stats JSON 形状（实跑 job）──

/// >20KB 用例的 merge 输出 fixture（brief 断言 6：~35KB stub，注明体量）：
/// 「融合膨胀正文段 [run-x] 」≈ 41 字节/段 × 900 段 ≈ 36.9KB——必须 >20_000 字节
/// 才能跨过 F-B 阈值；不含 `[[`（防 merge 口红链降级查库分支改写内容长度）。
fn t8_big_merged(run: &str) -> String {
    format!("融合膨胀正文段 [run-{run}] ").repeat(900)
}

/// 断言 1（>100% 且 >20KB → 仍在 warnings）+ 断言 6（merge_stats 形状钉在实跑 job）。
/// job1/j2 撞 page1：A/B 正文均小（combined ~百余字节），merge 输出 ~37KB →
/// merged_len > combined（超 100%）且 > 20KB → inflation warning + merge_stats 双落。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_inflation_over_20kb_still_warns_and_records_stats() {
    let ch1 = "raw/sources/t8-infl/Ch01.md";
    let ch2 = "raw/sources/t8-infl/Ch02.md";
    let page1 = "concepts/t8-infl1.md";
    let a_body = format!("A 版短正文（视频课视角）[run-infl-a]");
    let b_body = format!("B 版短正文（文字稿视角）[run-infl-b]");
    let env = t8_prepare(|_run| {
        vec![
            // job1（Ch01 建页）：step1 + step2
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page1, "A", &[ch1], &a_body)),
            // job2（Ch02 撞入）：step1 + step2 + merge（大输出 ~37KB）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page1, "B", &[ch2], &b_body)),
            StubResp::Text(t8_big_merged("big")),
        ]
    })
    .await;
    t8_write_source(&env, ch1, &format!("Ch01 原文 [run-{}]", env.run)).await;
    t8_write_source(&env, ch2, &format!("Ch02 原文 [run-{}]", env.run)).await;

    t8_insert_and_run(&env, ch1).await;
    let r2 = t8_insert_and_run(&env, ch2).await;

    // 断言 1（告警面）：>100% 且 >20KB → 仍在 warnings
    let infl = r2
        .warnings
        .iter()
        .filter(|w| w.contains("inflation watch"))
        .count();
    assert_eq!(infl, 1, "应恰 1 条 inflation warning: {:?}", r2.warnings);
    assert!(
        r2.warnings.iter().any(|w| w.contains("inflation watch") && w.contains(page1)),
        "warning 应带页路径: {:?}",
        r2.warnings
    );

    // 断言 6（形状面）：merge_stats 每项恰 path/merged_len/combined_len 三键，
    // 数值来自实跑（merged_len == merge stub 输出字节长；combined == 存量+incoming
    // 落库内容字节长，parse 落库恰为 body+"\n"——case2 断言同款事实）。
    assert_eq!(r2.merge_stats.len(), 1, "job2 恰一次 merge: {:?}", r2.merge_stats);
    let entry = &r2.merge_stats[0];
    let mut keys: Vec<&str> = entry.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["combined_len", "merged_len", "path"], "三键且仅三键: {entry}");
    assert_eq!(entry["path"].as_str(), Some(page1));
    // merged_len 钉在落库终态上（端到端实值，非手写字面量）：SSE delta 解析会吃掉
    // stub 文本末尾一个换行，故不与 t8_big_merged().len() 逐字节相等——与 DB 落库
    // content 字节长相等才是真锚（update_merged_page 原样写 merged_content）。
    let (db_content, _s, _c, _u) = crate::merge_ingest_test::t8_fetch_page(&env, page1).await;
    let expected_merged = db_content.len() as u64;
    let expected_combined = (a_body.len() + 1 + b_body.len() + 1) as u64;
    assert_eq!(entry["merged_len"].as_u64(), Some(expected_merged), "merged_len == 落库 content 字节长");
    assert_eq!(entry["combined_len"].as_u64(), Some(expected_combined));
    assert!(expected_merged > 20_000, "fixture 前置自检：merge 输出须 >20KB");
    assert!(expected_merged > expected_combined, "fixture 前置自检：须超 100%");
    // 告警文案内数字与 merge_stats 同源一致（同一对 merged/combined 值）
    assert!(
        r2.warnings.iter().any(|w| w.contains(&format!("({} > {} bytes", expected_merged, expected_combined))),
        "warning 数字应与 merge_stats 一致: {:?}",
        r2.warnings
    );

    finish(&env).await;
}

/// 断言 1（<20KB → 只进 merge_stats，无 warning）：job3/j4 撞 page2，
/// merge 输出略长于 combined（超 100%）但远 <20KB → stats-only。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_inflation_under_20kb_stats_only() {
    let ch3 = "raw/sources/t8-infl/Ch03.md";
    let ch4 = "raw/sources/t8-infl/Ch04.md";
    let page2 = "concepts/t8-infl2.md";
    let c_body = format!("C 版短正文（第三版基线）[run-{}-c]", "infl");
    let d_body = format!("D 版短正文（第四版增量）[run-{}-d]", "infl");
    let small_merged = format!("C+D 融合短正文（两版要点合并，长度略超两版之和但不越 20KB 阈值）[run-infl-small]");
    let env = t8_prepare(|_run| {
        vec![
            // job3（Ch03 建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page2, "C", &[ch3], &c_body)),
            // job4（Ch04 撞入）：step1 + step2 + merge（小输出）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page2, "D", &[ch4], &d_body)),
            StubResp::Text(small_merged.clone()),
        ]
    })
    .await;
    t8_write_source(&env, ch3, &format!("Ch03 原文 [run-{}]", env.run)).await;
    t8_write_source(&env, ch4, &format!("Ch04 原文 [run-{}]", env.run)).await;

    t8_insert_and_run(&env, ch3).await;
    let r4 = t8_insert_and_run(&env, ch4).await;

    assert_eq!(r4.merge_stats.len(), 1, "stats 照记: {:?}", r4.merge_stats);
    let entry = &r4.merge_stats[0];
    assert_eq!(entry["path"].as_str(), Some(page2));
    assert_eq!(entry["merged_len"].as_u64(), Some(small_merged.len() as u64));
    assert_eq!(
        entry["combined_len"].as_u64(),
        Some((c_body.len() + 1 + d_body.len() + 1) as u64)
    );
    assert!(
        r4.warnings.iter().all(|w| !w.contains("inflation watch")),
        "<20KB 超限不应发 warning: {:?}",
        r4.warnings
    );

    finish(&env).await;
}

// ── 断言 2 + 4（部分跳过形态）：dedup 跳过只计账、无逐源 warning、无 G3 汇总 ──

/// job1 单源 A 正常摄入（A 进 ingested_files）→ job2 多源 [A, B]：A 内容未变走
/// dedup 跳过（job2 item_states 空、非 prior-done），B 正常建页。
/// stub 序确定性：A 零 LLM 调用（hash 命中在 step1 前 return），仅 B 消费 2 响应。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_dedup_skip_partial_no_summary() {
    let src_a = "raw/sources/t8-mix/A.md";
    let src_b = "raw/sources/t8-mix/B.md";
    let page = "concepts/t8-mix.md";
    let b_body = format!("B 版正文（混合批新增源）[run-{}]", "mix");
    let env = t8_prepare(|_run| {
        vec![
            // job1（单源 A 建页）：step1 + step2
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[src_a], "A 版正文（首批源）[run-mix-a]")),
            // job2（[A,B]）：A dedup 跳过零调用；仅 B 消费 step1 + step2
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "B2", &[src_b], &b_body)),
        ]
    })
    .await;
    t8_write_source(&env, src_a, &format!("A 原文 [run-{}]", env.run)).await;
    t8_write_source(&env, src_b, &format!("B 原文 [run-{}]", env.run)).await;

    t8_insert_and_run(&env, src_a).await; // job1：A 摄入
    let (_j2, r2) = t8_insert_and_run_multi(&env, &[src_a, src_b]).await; // job2：混合

    // 断言 2：dedup 跳过 → 计账、无逐源 warning（G3 汇总是唯一例外，此处亦无）
    assert_eq!(r2.dedup_skipped.len(), 1, "恰 A 被跳过: {:?}", r2.dedup_skipped);
    assert!(r2.dedup_skipped.contains(&src_a.to_string()));
    assert!(
        r2.warnings.iter().all(|w| !w.contains("dedup-skipped")),
        "部分跳过不得有 dedup 相关 warning: {:?}",
        r2.warnings
    );
    // 断言 4（部分跳过形态）：无 G3 汇总、B 计账完整（new_pages 落页、零页空）
    assert!(r2.new_pages.iter().any(|p| p == page), "B 建页应落 new_pages: {:?}", r2.new_pages);
    assert!(r2.zero_page_sources.is_empty());
    assert!(r2.merge_stats.is_empty(), "B 建新页无 merge");

    finish(&env).await;
}

// ── 断言 3：零页源 → zero_page_sources + 恰 1 条 warning ──

/// job1 单源 E：step2 输出无 FILE 块（非空纯文本）→ processed Some 但 pages 空 →
/// G2 计账 + 恰 1 条 actionable warning。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_zero_page_source_one_warning() {
    let src_e = "raw/sources/t8-zero/E.md";
    let env = t8_prepare(|_run| {
        vec![
            StubResp::Text(t8_step1_json()),
            // step2 输出非空但零 FILE 块（结构性异常形态——bigmodel thinking 类故障）
            StubResp::Text("分析结论：本源无需建页，仅作背景参考。[run-zero]".to_string()),
        ]
    })
    .await;
    t8_write_source(&env, src_e, &format!("E 原文（将被静默零页）[run-{}]", env.run)).await;

    let (_jid, r1) = t8_insert_and_run_multi(&env, &[src_e]).await;

    assert_eq!(r1.zero_page_sources, vec![src_e.to_string()], "G2 计账");
    let zp = r1
        .warnings
        .iter()
        .filter(|w| w.contains("produced 0 pages"))
        .count();
    assert_eq!(zp, 1, "恰 1 条零页 warning: {:?}", r1.warnings);
    assert!(
        r1.warnings.iter().any(|w| w.contains("produced 0 pages") && w.contains(src_e)),
        "warning 应带源路径: {:?}",
        r1.warnings
    );
    assert!(r1.new_pages.is_empty() && r1.merged_pages.is_empty());
    // 零页不算 dedup 跳过 / 不触发 G3（dedup 空）
    assert!(r1.dedup_skipped.is_empty());
    assert!(r1.warnings.iter().all(|w| !w.contains("dedup-skipped")));

    finish(&env).await;
}

// ── 断言 4（全跳过形态）：恰 1 条 G3 汇总 warning ──

/// job1/job1b 分别单源摄入 F、F2 → job2 多源 [F, F2] 内容均未变 → 全 dedup 跳过 →
/// G3 五条件成立（total=2, written=0, failed=0, dedup=2, done=2）→ 恰 1 条汇总。
/// stub 序确定性：job2 零 LLM 调用（双源均 hash 命中）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_all_dedup_skipped_one_summary_warning() {
    let src_f = "raw/sources/t8-all/F.md";
    let src_f2 = "raw/sources/t8-all/F2.md";
    let page = "concepts/t8-all.md";
    let env = t8_prepare(|_run| {
        vec![
            // job1（F 建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "F", &[src_f], "F 版正文（全跳过批源一）[run-all-f]")),
            // job1b（F2 建另一页，避免同 job 内两源撞页引入 merge）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block("concepts/t8-all2.md", "F2", &[src_f2], "F2 版正文（全跳过批源二）[run-all-f2]")),
            // job2（[F,F2]）：零 LLM 调用——双源均 dedup 跳过
        ]
    })
    .await;
    t8_write_source(&env, src_f, &format!("F 原文 [run-{}]", env.run)).await;
    t8_write_source(&env, src_f2, &format!("F2 原文 [run-{}]", env.run)).await;

    t8_insert_and_run(&env, src_f).await;
    t8_insert_and_run(&env, src_f2).await;
    let (_j2, r2) = t8_insert_and_run_multi(&env, &[src_f, src_f2]).await;

    assert_eq!(r2.dedup_skipped.len(), 2, "双源全跳过: {:?}", r2.dedup_skipped);
    assert!(r2.dedup_skipped.contains(&src_f.to_string()));
    assert!(r2.dedup_skipped.contains(&src_f2.to_string()));
    let sum = r2
        .warnings
        .iter()
        .filter(|w| w.contains("dedup-skipped"))
        .count();
    assert_eq!(sum, 1, "恰 1 条 G3 汇总 warning: {:?}", r2.warnings);
    assert!(
        r2.warnings.iter().any(|w| w.contains("all 2 sources dedup-skipped")),
        "汇总文案带 N=2: {:?}",
        r2.warnings
    );
    assert!(r2.new_pages.is_empty() && r2.merged_pages.is_empty(), "零产出");

    finish(&env).await;
}

// ── 断言 5：mixed prior_done + dedup-skip resume → 不触发 G3（零误报锚）──

/// 场景（brief 断言 5 逐字落）：
/// 1) job1 单源 A 正常摄入（A 进 ingested_files）。
/// 2) job2 = 多源 [A, B]：首跑 A dedup 跳过（done）、B 正常摄入（done + ingested）。
/// 3) 模拟「B 的 mark_file_ingested 已落、update_item_state(B) 未落」的崩溃残留
///    （生产代码序：mark_file_ingested 先于 update_item_state，此残留态真实可达），
///    将 job2 的 item_states 裁成仅 A=done；再走重试语义（status→pending，
///    item_states 不清——对齐 mark_job_retry_pending/manual_retry；此处用直接
///    UPDATE 而非调函数，避免二者 LPUSH live Redis 被 launchd worker 抢跑，C-3）。
/// 4) 二跑：A 被 prior-done 滤除（done_this_run 起始 1），B 内容未变走 dedup 跳过
///    （done=2, dedup=1）——等值条件 done > dedup 不成立 → 无 G3 汇总（零误报锚）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_resume_mixed_prior_done_and_dedup_skip_no_summary() {
    let src_a = "raw/sources/t8-resume/A.md";
    let src_b = "raw/sources/t8-resume/B.md";
    let page = "concepts/t8-resume.md";
    let b_body = format!("B 版正文（resume 批源）[run-{}]", "resume");
    let env = t8_prepare(|_run| {
        vec![
            // job1（单源 A 建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[src_a], "A 版正文（resume 首源）[run-resume-a]")),
            // job2 首跑（[A,B]）：A dedup 跳过零调用；仅 B 消费 step1 + step2
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "B2", &[src_b], &b_body)),
            // job2 二跑：A prior-done 滤除、B dedup 跳过——零 LLM 调用
        ]
    })
    .await;
    t8_write_source(&env, src_a, &format!("A 原文 [run-{}]", env.run)).await;
    t8_write_source(&env, src_b, &format!("B 原文 [run-{}]", env.run)).await;

    t8_insert_and_run(&env, src_a).await; // 步 1
    let (j2, r2a) = t8_insert_and_run_multi(&env, &[src_a, src_b]).await; // 步 2（首跑）
    assert_eq!(r2a.dedup_skipped, vec![src_a.to_string()], "首跑：A 跳过、B 正常");
    assert!(r2a.new_pages.iter().any(|p| p == page));

    // 步 3：裁 item_states 至仅 A=done（崩溃残留态）+ 重试语义翻 pending
    sqlx::query("UPDATE ingest_jobs SET item_states=$2, status='pending', finished_at=NULL WHERE id=$1")
        .bind(j2)
        .bind(serde_json::json!([{ "path": src_a, "status": "done", "error": null }]))
        .execute(&env.state.db)
        .await
        .expect("裁 item_states + 翻 pending");

    let r2b = run_job_row(&env, j2).await; // 步 4：二跑

    // 零误报锚：done_this_run = prior_done(A)+1 = 2 > dedup_skipped.len() = 1 → 无 G3
    assert_eq!(r2b.dedup_skipped, vec![src_b.to_string()], "二跑：仅 B dedup 跳过");
    assert!(
        r2b.warnings.iter().all(|w| !w.contains("dedup-skipped")),
        "mixed resume 不得触发 G3 汇总: {:?}",
        r2b.warnings
    );
    assert!(r2b.new_pages.is_empty() && r2b.merged_pages.is_empty(), "二跑零产出");

    finish(&env).await;
}

// ── 断言 7：旧 job 行 result 无新键 → serde default + JobResponse 透传 ──

/// 直插一条 51a8d06b/67ba179b 之前的旧形状 result（无 merged_pages/merge_stats/
/// dedup_skipped/zero_page_sources 四键）行：
/// - IngestJob 行读回（生产同款 query_as）→ from_value::<IngestJobResult> 不炸、
///   新字段全 default 空、旧字段保真；
/// - job_status（JobResponse 透传口）返回原 result 原样、可序列化；
/// - 补键后序列化含四新键（向新前端透传面）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_old_result_json_backward_compat() {
    // 空脚本：本用例零 LLM 调用（仅借 t8_prepare 建 fixture 项目满足 FK）
    let env = t8_prepare(|_| vec![]).await;

    let job_id = uuid::Uuid::new_v4();
    let old_result: serde_json::Value = serde_json::json!({
        "new_pages": ["concepts/legacy-page.md"],
        "updated_reserved": [],
        "warnings": ["legacy warning"]
    });
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status, result) \
         VALUES ($1, $2, ARRAY[$3], 'succeeded', $4)",
    )
    .bind(job_id)
    .bind(env.pid)
    .bind("raw/sources/legacy.md")
    .bind(&old_result)
    .execute(&env.state.db)
    .await
    .expect("insert 旧形状 job 行");

    // 生产读回口：IngestJob（result 为 raw JSONB，不反序列化 IngestJobResult）
    let row: (serde_json::Value,) = sqlx::query_as("SELECT result FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("回读旧 job 行 result");
    assert_eq!(row.0, old_result, "JSONB 透传不改写");

    // serde default 反序列化：无新键不炸、新字段空、旧字段保真
    let parsed: IngestJobResult =
        serde_json::from_value(row.0.clone()).expect("旧形状 result 反序列化（serde default）");
    assert_eq!(parsed.new_pages, vec!["concepts/legacy-page.md".to_string()]);
    assert_eq!(parsed.warnings, vec!["legacy warning".to_string()]);
    assert!(parsed.merged_pages.is_empty());
    assert!(parsed.merge_stats.is_empty());
    assert!(parsed.dedup_skipped.is_empty());
    assert!(parsed.zero_page_sources.is_empty());

    // 补键后重序列化：四新键向消费方透传（向后兼容的双向面）
    let round = serde_json::to_value(&parsed).unwrap();
    for k in ["merged_pages", "merge_stats", "dedup_skipped", "zero_page_sources"] {
        assert!(round.get(k).is_some(), "重序列化应含新键 {k}");
    }

    // JobResponse 透传口（job_status → job_to_response）不炸且 result 原样
    let resp = llm_wiki_server::services::ingest_queue::job_status(&env.state, job_id)
        .await
        .expect("job_status 旧行透传");
    assert_eq!(resp.result, Some(old_result));
    let resp_json = serde_json::to_value(&resp).expect("JobResponse 可序列化");
    assert_eq!(resp_json["result"]["new_pages"][0], "concepts/legacy-page.md");

    // 自建自清：仅删本用例插入的行
    sqlx::query("DELETE FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .execute(&env.state.db)
        .await
        .expect("清理本用例 job 行");

    finish(&env).await;
}

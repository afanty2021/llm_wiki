//! 学习事件 → learning_items 状态投影（Task 8）。
//!
//! 设计约定（可测性）：全部函数取 `&mut sqlx::PgConnection`（事务连接）而非
//! `&DbPool` 或 `Transaction` 具体类型——调用方 `&mut *tx` 解引用传入即可；
//! 测试可 `pool.begin()` 后调用并按需 `rollback()`，全程不落库（本文件的
//! 语义就是「事件即事实，投影可重建」，回滚重放天然安全）。路由层一律
//! 在同一事务内调用：事件记账与状态转移原子提交，中途失败整体回滚。
//!
//! 单调性：items.status 格为 pending < viewed < completed，所有转移均带
//! WHERE 守卫单向推进（completed 永不回退、completed_at 不重置）；
//! `rebuild` 的集合式重放与按时间逐条重放收敛到同一不动点（格上取 max
//! 与顺序无关），故无需逐事件循环。

use serde::Serialize;
use sqlx::PgConnection;

use crate::AppError;

/// 记 complete 事件 + 单调完成投影。
///
/// - 事件即事实：每次调用都记 complete 事件（重复完成的审计/重放依据）；
/// - 投影守卫：`WHERE status <> 'completed'`——已完成项幂等重放 0 行，
///   completed_at 不被 NOW() 覆盖（测试锚点：二次 complete 后 completed_at 不变）；
/// - 归属（belt-and-braces）：UPDATE 仅作用于「所属 plan 属于 user_id」的行。
///   路由层已先行校验 item→plan→user 归属（不属 → 404），此处守卫防未来
///   新调用方绕过路由检查。
///
/// 返回受影响行数（0 = 已完成态的幂等重放，1 = pending/viewed → completed）。
pub async fn complete_item(
    tx: &mut PgConnection,
    item_id: i32,
    user_id: i32,
) -> Result<u64, AppError> {
    sqlx::query(
        "INSERT INTO learning_events (user_id, item_id, event_type, payload) \
         VALUES ($1, $2, 'complete', '{}')",
    )
    .bind(user_id)
    .bind(item_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;

    let n = sqlx::query(
        "UPDATE learning_items i \
         SET status = 'completed', completed_at = NOW() \
         WHERE i.id = $1 AND i.status <> 'completed' \
           AND EXISTS (SELECT 1 FROM learning_plans p WHERE p.id = i.plan_id AND p.user_id = $2)",
    )
    .bind(item_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    Ok(n)
}

/// 记 seen 事件；item 级同时做 viewed 单向投影，页面级仅事件。
///
/// - `item_id = Some(id)`（item 级，/t/ 页打开单条）：pending → viewed 单向
///   （WHERE status='pending' 守卫：viewed 幂等、completed 永不回退）；
/// - `item_id = None`（页面级，/t/ 页整体打开）：仅记事件（payload 携带
///   plan_id 供审计），不触碰任何投影——页面打开≠看过具体条目。
///
/// item 级归属守卫与 complete_item 同款（plan 属 user + item 属该 plan）。
pub async fn apply_seen(
    tx: &mut PgConnection,
    plan_id: i32,
    item_id: Option<i32>,
    user_id: i32,
) -> Result<(), AppError> {
    match item_id {
        Some(item_id) => {
            sqlx::query(
                "INSERT INTO learning_events (user_id, item_id, event_type, payload) \
                 VALUES ($1, $2, 'seen', '{}')",
            )
            .bind(user_id)
            .bind(item_id)
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;
            sqlx::query(
                "UPDATE learning_items i \
                 SET status = 'viewed' \
                 WHERE i.id = $1 AND i.plan_id = $2 AND i.status = 'pending' \
                   AND EXISTS (SELECT 1 FROM learning_plans p WHERE p.id = i.plan_id AND p.user_id = $3)",
            )
            .bind(item_id)
            .bind(plan_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO learning_events (user_id, item_id, event_type, payload) \
                 VALUES ($1, NULL, 'seen', $2)",
            )
            .bind(user_id)
            .bind(serde_json::json!({ "plan_id": plan_id }))
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;
        }
    }
    Ok(())
}

/// rebuild 统计（调试端点响应 + 测试断言用）。
#[derive(Debug, Serialize)]
pub struct RebuildStats {
    pub cleared: u64,
    pub viewed: u64,
    pub completed: u64,
}

/// 重建本人全部 items 投影：清零（pending + completed_at=NULL）后按
/// **item 级**事件重放（页面级 seen 的 item_id 为 NULL，天然不参与）。
///
/// 三步集合式 SQL（见模块注释：格上单向转移，集合重放 = 逐条重放的不动点）：
/// 1. 清零：user 名下所有 items → pending（含无事件支撑的脏 completed——
///    回正为 pending，这正是 rebuild 的存在意义）；
/// 2. 重放 seen：存在 item 级 seen 事件的 pending 项 → viewed；
/// 3. 重放 complete：存在 complete 事件的项 → completed，
///    completed_at 取该 item **首个** complete 事件时间（MIN(created_at)，
///    与在线路径「首次完成时刻」语义一致）。
///
/// 事件筛选双重归属：e.user_id = 本人 且 item 所属 plan 属本人。
pub async fn rebuild(tx: &mut PgConnection, user_id: i32) -> Result<RebuildStats, AppError> {
    let cleared = sqlx::query(
        "UPDATE learning_items i \
         SET status = 'pending', completed_at = NULL \
         WHERE i.plan_id IN (SELECT id FROM learning_plans WHERE user_id = $1)",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let viewed = sqlx::query(
        "UPDATE learning_items i \
         SET status = 'viewed' \
         WHERE i.status = 'pending' \
           AND i.plan_id IN (SELECT id FROM learning_plans WHERE user_id = $1) \
           AND EXISTS (SELECT 1 FROM learning_events e \
                       WHERE e.item_id = i.id AND e.user_id = $1 AND e.event_type = 'seen')",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let completed = sqlx::query(
        "UPDATE learning_items i \
         SET status = 'completed', \
             completed_at = (SELECT MIN(e.created_at) FROM learning_events e \
                             WHERE e.item_id = i.id AND e.user_id = $1 AND e.event_type = 'complete') \
         WHERE i.status <> 'completed' \
           AND i.plan_id IN (SELECT id FROM learning_plans WHERE user_id = $1) \
           AND EXISTS (SELECT 1 FROM learning_events e \
                       WHERE e.item_id = i.id AND e.user_id = $1 AND e.event_type = 'complete')",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    Ok(RebuildStats { cleared, viewed, completed })
}

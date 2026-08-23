//! token_cleanup 集成测试：过期/超龄吊销行删除、活跃与未满观测窗的吊销行保留。
//! 数据卫生：t9_ 前缀族（users 级联清 refresh_tokens），走 mod.rs SWEEPS 稳态。

#[cfg(test)]
mod tests {
    use llm_wiki_server::services::token_cleanup::cleanup_once;

    /// 直插一行 refresh_tokens（token_hash 唯一即可，无需真实 JWT——cleanup 不验内容）。
    async fn insert_token(
        state: &llm_wiki_server::AppState,
        user_id: i32,
        suffix: &str,
        expires_offset_secs: i64,
        revoked_offset_secs: Option<i64>,
    ) {
        let sql = match revoked_offset_secs {
            Some(rv) => {
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) \
                 VALUES ($1, $2, NOW() + make_interval(secs => $3), NOW() + make_interval(secs => $4))"
            }
            None => {
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) \
                 VALUES ($1, $2, NOW() + make_interval(secs => $3))"
            }
        };
        let mut q = sqlx::query(sql)
            .bind(user_id)
            .bind(format!("t9-tokclean-{suffix}-{}", std::process::id()))
            .bind(expires_offset_secs);
        if let Some(rv) = revoked_offset_secs {
            q = q.bind(rv);
        }
        q.execute(&state.db).await.expect("insert refresh_token");
    }

    async fn count_tokens(state: &llm_wiki_server::AppState, user_id: i32) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .expect("count refresh_tokens")
    }

    #[tokio::test]
    async fn token_cleanup_removes_expired_and_aged_revoked_only() {
        let (_app, state) = crate::setup_test_app().await;

        let uid = format!("t9_tokclean_{}", std::process::id());
        let user_id: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, full_name) \
             VALUES ($1, $2, 'x', 'tokclean') RETURNING id",
        )
        .bind(&uid)
        .bind(format!("{uid}@t9.com"))
        .fetch_one(&state.db)
        .await
        .expect("insert test user");

        // 三类行：① 已过期（应删）② 吊销超 7 天（应删）③ 活跃（应保留）
        // ④ 吊销 1 天前、未过期（观测窗内，应保留）
        insert_token(&state, user_id, "expired", -3600, None).await;
        insert_token(&state, user_id, "aged-revoked", 86400, Some(-(8 * 86400))).await;
        insert_token(&state, user_id, "active", 604800, None).await;
        insert_token(&state, user_id, "recent-revoked", 86400, Some(-86400)).await;

        let removed = cleanup_once(&state).await.expect("cleanup_once");
        assert!(removed >= 2, "至少删掉本测试的 2 行，实际 {removed}");

        let left = count_tokens(&state, user_id).await;
        assert_eq!(left, 2, "活跃行与观测窗内吊销行必须保留");

        // 断言留下的确实是那两行
        let survivors: Vec<String> = sqlx::query_scalar(
            "SELECT token_hash FROM refresh_tokens WHERE user_id = $1 ORDER BY token_hash",
        )
        .bind(user_id)
        .fetch_all(&state.db)
        .await
        .expect("fetch survivors");
        let joined = survivors.join(",");
        assert!(joined.contains("active"), "active 须存活: {joined}");
        assert!(joined.contains("recent-revoked"), "观测窗内吊销行须存活: {joined}");

        crate::teardown_test_data(&state).await;
    }
}

mod health;
mod auth;
mod logs;
mod users;
mod teams;
mod projects;
mod files;
mod search;
mod chat;
mod graph;
mod pages;
mod ingest;
mod llm_providers;
mod search_providers;
pub mod chat_sessions;
pub mod reviews;
pub mod research;
pub mod training;
pub mod media;
pub mod t_page;

pub use pages::WikiPage;

use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::{from_fn, Next},
    response::Response,
    Router, routing::get,
};
use tower::Layer;
use tower_http::services::{ServeDir, ServeFile};
use crate::AppState;

/// SPA HTML 禁缓存：部署后 Safari 等浏览器须重验证 index.html（其引用带哈希 assets）；
/// /assets/* 内容哈希寻址、按哈希不可变，保持默认可缓存不受影响。
/// 实测事故：dist 重部署后 Safari 重启数日仍持旧 index 引用已删除的旧 JS（Chrome 正常重验证）。
async fn spa_html_no_cache(req: Request, next: Next) -> Response {
    let resp = next.run(req).await;
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v.contains("text/html"));
    if !is_html {
        return resp;
    }
    let mut resp = resp;
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    resp
}

pub fn create_router(state: AppState) -> Router {
    // Layer 5：ServeDir 同源托管前端 dist（SPA history mode fallback）。
    // API 路由在 Router::new() 内显式声明，优先于 fallback_service。
    // 开发期 dist 可能不存在（未 npm run build）→ 前端路由 404 属正常；web 适配靠 build:web/CI 产出 dist。
    // 注意：tower 0.4 无 LayerExt（service.layer(...) 不可用），Layer::layer 参数序为 (layer, service)。
    let dist_dir = state.config.dist_dir().to_string();
    let index_html = state.config.index_html().to_string();
    let spa = from_fn(spa_html_no_cache)
        .layer(ServeDir::new(&dist_dir).fallback(ServeFile::new(&index_html)));

    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .nest("/api/v1/users", users::user_routes())
        .nest("/api/v1/teams", teams::team_routes())
        .nest("/api/v1/projects", projects::project_routes())
        .nest("/api/v1/files", files::file_routes())
        .nest("/api/v1/search", search::search_routes())
        .nest("/api/v1/chat", chat::chat_routes())
        .nest("/api/v1/graph", graph::graph_routes())
        .nest("/api/v1/logs", logs::logs_routes())
        .nest("/api/v1/training", training::training_routes())
        .merge(ingest::global_ingest_routes())
        .merge(research::global_research_routes())
        .merge(llm_providers::llm_provider_routes())
        .merge(search_providers::search_provider_routes())
        .merge(media::media_routes())
        // /t/ 落地页（Task 9）：必须在 SPA fallback（fallback_service）前 merge——
        // 否则 /t/:token 会被 ServeDir fallback 吃掉返回 index.html
        .merge(t_page::t_routes())
        .fallback_service(spa)
        .with_state(state)
}

#[cfg(test)]
mod spa_cache_tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, response::IntoResponse};
    use tower::ServiceExt; // oneshot

    async fn serve(content_type: &'static str) -> Response {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            "x",
        )
            .into_response()
    }

    fn app() -> Router {
        // 与生产一致的挂载方式：from_fn(spa_html_no_cache) 层包裹下游服务
        Router::new()
            .route("/index.html", get(|| serve("text/html; charset=utf-8")))
            .route("/asset.js", get(|| serve("application/javascript")))
            .layer(from_fn(spa_html_no_cache))
    }

    // 命名避开 axum::routing::get（经 use super::* 引入），否则 route() 内的 get 会被本函数遮蔽
    async fn send(path: &str) -> Response {
        app()
            .oneshot(
                Request::get(path)
                    .body(Body::empty())
                    .expect("request built"),
            )
            .await
            .expect("infallible")
    }

    #[tokio::test]
    async fn html_response_gets_no_cache() {
        let resp = send("/index.html").await;
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache",
            "text/html 响应（index.html / SPA fallback）必须 no-cache"
        );
    }

    #[tokio::test]
    async fn hashed_asset_passes_through_untouched() {
        let resp = send("/asset.js").await;
        assert!(
            resp.headers().get(header::CACHE_CONTROL).is_none(),
            "非 HTML（带哈希 assets 等）不得注入 Cache-Control"
        );
    }

    #[tokio::test]
    async fn header_overwritten_when_already_html() {
        // 生产中 ServeDir 不会预置 Cache-Control，此处验证 insert 覆盖语义
        async fn preset() -> Response {
            let mut r = serve("text/html").await;
            r.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("max-age=31536000"),
            );
            r
        }
        let app = Router::new()
            .route("/", get(preset))
            .layer(from_fn(spa_html_no_cache));
        let resp = app
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
    }
}

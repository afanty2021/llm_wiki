use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
    response::IntoResponse,
    Router,
};
use sqlx::Row;
use uuid::Uuid;
use crate::{
    middleware::require_auth, AppError, AppState,
    models::{
        CreateProjectRequest, ListProjectsQuery, Project, ProjectResponse,
        UpdateProjectRequest,
    },
};
use super::pages;

// --- Cursor helpers ---

/// Encode (id, created_at) as a hex cursor string.
fn encode_cursor(id: i32, created_at: &str) -> String {
    hex::encode(format!("{}:{}", id, created_at))
}

/// Decode a hex cursor string back to (id, created_at).
fn decode_cursor(cursor: &str) -> Result<(i32, String), AppError> {
    let bytes =
        hex::decode(cursor).map_err(|_| AppError::BadRequest("Invalid cursor".to_string()))?;
    let s = String::from_utf8(bytes)
        .map_err(|_| AppError::BadRequest("Invalid cursor encoding".to_string()))?;
    let (id_part, ts_part) = s
        .split_once(':')
        .ok_or_else(|| AppError::BadRequest("Invalid cursor format".to_string()))?;
    let id: i32 = id_part
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid cursor id".to_string()))?;
    Ok((id, ts_part.to_string()))
}

// --- Public router ---

pub fn project_routes() -> Router<AppState> {
    Router::new()
        .route("/", axum::routing::post(create_project))
        .route("/", axum::routing::get(list_projects))
        .route("/{id}", axum::routing::get(get_project))
        .route("/{id}", axum::routing::put(update_project))
        .route("/{id}", axum::routing::delete(delete_project))
        .merge(pages::pages_routes())
}

// --- Permission helpers ---

/// Check that the user is a member of the team and return their role.
async fn check_team_membership(
    state: &AppState,
    team_id: i32,
    user_id: i32,
) -> Result<String, AppError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    role.ok_or_else(|| AppError::ResourceNotFound("Team not found or you are not a member".to_string()))
}

// --- Handlers ---

/// POST /projects — Create a new project
///
/// Requires `team_id` in the request body. Generates a storage_path from
/// `{config_storage_path}/{team_id}/{uuid}`, creates the directory on disk,
/// and returns a ProjectResponse with file_count = 0.
async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    if req.name.trim().is_empty() {
        return Err(AppError::ValidationError("Project name is required".to_string()));
    }

    let team_id = req
        .team_id
        .ok_or_else(|| AppError::ValidationError("team_id is required".to_string()))?;

    // Verify user is a member of the team
    check_team_membership(&state, team_id, user_id).await?;

    // Generate storage path: {config_storage_path}/{team_id}/{uuid}
    let project_uuid = Uuid::new_v4();
    let storage_path = format!(
        "{}/{}/{}",
        state.config.storage_path().trim_end_matches('/'),
        team_id,
        project_uuid
    );

    // Create directory on disk
    std::fs::create_dir_all(&storage_path).map_err(|e| {
        AppError::InternalError(format!("Failed to create project directory: {}", e))
    })?;

    // Insert project into database
    let row = sqlx::query(
        "INSERT INTO projects (team_id, name, storage_path, created_by) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, team_id, name, storage_path, created_by, created_at",
    )
    .bind(team_id)
    .bind(req.name.trim())
    .bind(&storage_path)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let project_response = ProjectResponse {
        id: row.get("id"),
        team_id: row.get("team_id"),
        name: row.get("name"),
        storage_path: row.get("storage_path"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        file_count: 0,
    };

    Ok((StatusCode::CREATED, Json(project_response)))
}

/// GET /projects — List projects with cursor-based pagination
///
/// If `team_id` query param is provided, only lists projects for that team
/// (after checking membership). Otherwise lists projects across all teams
/// the user belongs to.
async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListProjectsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let limit = (q.limit.unwrap_or(20).min(100)) as i64;

    if let Some(team_id) = q.team_id {
        // Check membership for the specific team
        check_team_membership(&state, team_id, user_id).await?;

        let projects: Vec<ProjectResponse> = if let Some(ref cursor) = q.cursor {
            let (cursor_id, cursor_ts) = decode_cursor(cursor)?;
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT id, team_id, name, storage_path, created_by, created_at, 0 as file_count \
                 FROM projects \
                 WHERE team_id = $1 \
                   AND (created_at, id) < ($2::timestamptz, $3) \
                 ORDER BY created_at DESC, id DESC \
                 LIMIT $4",
            )
            .bind(team_id)
            .bind(&cursor_ts)
            .bind(cursor_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT id, team_id, name, storage_path, created_by, created_at, 0 as file_count \
                 FROM projects \
                 WHERE team_id = $1 \
                 ORDER BY created_at DESC, id DESC \
                 LIMIT $2",
            )
            .bind(team_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        };

        let next_cursor = projects
            .last()
            .map(|p| encode_cursor(p.id, &p.created_at.to_rfc3339()));
        let has_more = projects.len() as i64 >= limit;

        Ok(Json(serde_json::json!({
            "items": projects,
            "next_cursor": next_cursor,
            "has_more": has_more,
        })))
    } else {
        // List projects across all user's teams
        let projects: Vec<ProjectResponse> = if let Some(ref cursor) = q.cursor {
            let (cursor_id, cursor_ts) = decode_cursor(cursor)?;
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count \
                 FROM projects p \
                 INNER JOIN team_members tm ON p.team_id = tm.team_id \
                 WHERE tm.user_id = $1 \
                   AND (p.created_at, p.id) < ($2::timestamptz, $3) \
                 ORDER BY p.created_at DESC, p.id DESC \
                 LIMIT $4",
            )
            .bind(user_id)
            .bind(&cursor_ts)
            .bind(cursor_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count \
                 FROM projects p \
                 INNER JOIN team_members tm ON p.team_id = tm.team_id \
                 WHERE tm.user_id = $1 \
                 ORDER BY p.created_at DESC, p.id DESC \
                 LIMIT $2",
            )
            .bind(user_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        };

        let next_cursor = projects
            .last()
            .map(|p| encode_cursor(p.id, &p.created_at.to_rfc3339()));
        let has_more = projects.len() as i64 >= limit;

        Ok(Json(serde_json::json!({
            "items": projects,
            "next_cursor": next_cursor,
            "has_more": has_more,
        })))
    }
}

/// GET /projects/:id — Get a single project
///
/// Verifies the user has access to the project through team membership.
async fn get_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Verify team membership via JOIN
    let project = sqlx::query_as::<_, ProjectResponse>(
        "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count \
         FROM projects p \
         INNER JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Project not found".to_string()))?;

    Ok(Json(project))
}

/// PUT /projects/:id — Update a project (name only)
///
/// Verifies team membership before allowing the update.
/// Only the `name` field can be updated.
async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<i32>,
    Json(req): Json<UpdateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Fetch the project and verify team membership in one query
    let project = sqlx::query_as::<_, Project>(
        "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at \
         FROM projects p \
         INNER JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Project not found".to_string()))?;

    // Only update if name is provided, otherwise keep current
    let new_name = match &req.name {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => project.name,
    };

    let row = sqlx::query(
        "UPDATE projects SET name = $1 WHERE id = $2 \
         RETURNING id, team_id, name, storage_path, created_by, created_at",
    )
    .bind(&new_name)
    .bind(project_id)
    .fetch_one(&state.db)
    .await?;

    let project_response = ProjectResponse {
        id: row.get("id"),
        team_id: row.get("team_id"),
        name: row.get("name"),
        storage_path: row.get("storage_path"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        file_count: 0,
    };

    Ok(Json(project_response))
}

/// DELETE /projects/:id — Delete a project
///
/// Verifies team membership. Uses a database transaction to clean up related
/// data (project record, wiki pages, etc.).
async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Fetch project and verify team membership
    let _project = sqlx::query_as::<_, Project>(
        "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at \
         FROM projects p \
         INNER JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Project not found".to_string()))?;

    // Use a database transaction to clean up related data
    let mut tx = state.db.begin().await?;

    // Delete wiki pages associated with this project
    sqlx::query("DELETE FROM wiki_pages WHERE project_id = $1")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;

    // Delete ingested files associated with this project
    sqlx::query("DELETE FROM ingested_files WHERE project_id = $1")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;

    // Delete the project record
    let result = sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("Project not found".to_string()));
    }

    tx.commit().await?;

    Ok(Json(serde_json::json!({"message": "Project deleted successfully"})))
}

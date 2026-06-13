use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Router,
};
use serde::Deserialize;
use sqlx::Row;
use crate::{
    middleware::require_auth, AppError, AppState,
    models::{
        AddMemberRequest, CreateTeamRequest, Team, TeamMemberResponse,
        TeamResponse, UpdateTeamRequest,
    },
};

/// --- Query structs ---

#[derive(Debug, Deserialize)]
struct ListTeamsQuery {
    cursor: Option<String>,
    limit: Option<i32>,
}

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

pub fn team_routes() -> Router<AppState> {
    Router::new()
        .route("/", post(create_team))
        .route("/", get(list_teams))
        .route("/{id}", get(get_team))
        .route("/{id}", put(update_team))
        .route("/{id}", delete(delete_team))
        .route("/{id}/members", post(add_member))
        .route("/{id}/members", get(get_team_members))
        .route("/{id}/members/{user_id}", delete(remove_member))
}

// --- Permission helpers ---

/// Check that the user is a member of the team and return their role.
async fn check_membership(
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

/// Ensure the role is 'owner'.
fn require_owner(role: &str) -> Result<(), AppError> {
    if role != "owner" {
        return Err(AppError::PermissionDenied);
    }
    Ok(())
}

/// Ensure the role is 'owner' or 'admin'.
fn require_owner_or_admin(role: &str) -> Result<(), AppError> {
    if role != "owner" && role != "admin" {
        return Err(AppError::PermissionDenied);
    }
    Ok(())
}

// --- Handlers ---

/// POST /teams — Create a new team
async fn create_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTeamRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    if req.name.trim().is_empty() {
        return Err(AppError::ValidationError("Team name is required".to_string()));
    }

    // Insert the team
    let row = sqlx::query(
        "INSERT INTO teams (name, description, created_by) VALUES ($1, $2, $3) RETURNING id, name, description, created_by, created_at",
    )
    .bind(req.name.trim())
    .bind(&req.description)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let team_id: i32 = row.get("id");

    // Auto-add the creator as 'owner'
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(team_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    let team_response = TeamResponse {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        member_count: 1,
    };

    Ok((StatusCode::CREATED, Json(team_response)))
}

/// GET /teams — List teams (cursor-based pagination, only teams the user belongs to)
async fn list_teams(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListTeamsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let limit = q.limit.unwrap_or(20).min(100);

    let teams: Vec<TeamResponse> = if let Some(ref cursor) = q.cursor {
        let (cursor_id, cursor_ts) = decode_cursor(cursor)?;
        sqlx::query_as::<_, TeamResponse>(
            "SELECT t.id, t.name, t.description, t.created_by, t.created_at, \
             CAST(COUNT(tm.user_id) AS BIGINT) as member_count \
             FROM teams t \
             INNER JOIN team_members tm ON t.id = tm.team_id \
             WHERE t.id IN (SELECT team_id FROM team_members WHERE user_id = $1) \
               AND (t.created_at, t.id) < ($2::timestamptz, $3) \
             GROUP BY t.id \
             ORDER BY t.created_at DESC, t.id DESC \
             LIMIT $4",
        )
        .bind(user_id)
        .bind(&cursor_ts)
        .bind(cursor_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, TeamResponse>(
            "SELECT t.id, t.name, t.description, t.created_by, t.created_at, \
             CAST(COUNT(tm.user_id) AS BIGINT) as member_count \
             FROM teams t \
             INNER JOIN team_members tm ON t.id = tm.team_id \
             WHERE t.id IN (SELECT team_id FROM team_members WHERE user_id = $1) \
             GROUP BY t.id \
             ORDER BY t.created_at DESC, t.id DESC \
             LIMIT $2",
        )
        .bind(user_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };

    // Build next cursor from last item
    let next_cursor = teams.last().map(|t| encode_cursor(t.id, &t.created_at.to_rfc3339()));

    let body = serde_json::json!({
        "data": teams,
        "next_cursor": next_cursor,
    });

    Ok(Json(body))
}

/// GET /teams/:id — Get a single team (member access check)
async fn get_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Verify membership
    check_membership(&state, team_id, user_id).await?;

    let row = sqlx::query(
        "SELECT t.id, t.name, t.description, t.created_by, t.created_at, \
         CAST(COUNT(tm.user_id) AS BIGINT) as member_count \
         FROM teams t \
         LEFT JOIN team_members tm ON t.id = tm.team_id \
         WHERE t.id = $1 \
         GROUP BY t.id",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Team not found".to_string()))?;

    let team_response = TeamResponse {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        member_count: row.get("member_count"),
    };

    Ok(Json(team_response))
}

/// PUT /teams/:id — Update a team (owner/admin only)
async fn update_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<i32>,
    Json(req): Json<UpdateTeamRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Must be owner or admin
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;

    // Fetch current values to merge
    let current = sqlx::query_as::<_, Team>(
        "SELECT id, name, description, created_by, created_at FROM teams WHERE id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Team not found".to_string()))?;

    let new_name = req.name.unwrap_or(current.name);
    let new_description = req.description.or(current.description);

    // Per task description, description can be set/updated from the request.
    // If the request explicitly provides `null` for description, we should handle that.
    // Since UpdateTeamRequest.description is Option<Option<String>> would let us detect
    // "not provided" vs "set to null", but the model uses Option<String>.
    // We'll use a simple approach: the req provides Some(value) to update, None to keep.
    let row = sqlx::query(
        "UPDATE teams SET name = $1, description = $2 WHERE id = $3 \
         RETURNING id, name, description, created_by, created_at",
    )
    .bind(new_name.trim())
    .bind(&new_description)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Team not found".to_string()))?;

    // Get member count
    let member_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM team_members WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;

    let team_response = TeamResponse {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        member_count,
    };

    Ok(Json(team_response))
}

/// DELETE /teams/:id — Delete a team (owner only)
async fn delete_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Must be owner
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner(&role)?;

    let result = sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(team_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("Team not found".to_string()));
    }

    Ok(Json(serde_json::json!({"message": "Team deleted successfully"})))
}

/// POST /teams/:id/members — Add a member (owner/admin only)
async fn add_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<i32>,
    Json(req): Json<AddMemberRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Must be owner or admin
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;

    // Validate role against DB CHECK constraint
    if req.role != "owner" && req.role != "admin" && req.role != "member" {
        return Err(AppError::ValidationError(
            "Role must be 'owner', 'admin', or 'member'".to_string(),
        ));
    }

    // Check that the target user exists
    let user_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)",
    )
    .bind(req.user_id)
    .fetch_one(&state.db)
    .await?;

    if !user_exists {
        return Err(AppError::ResourceNotFound("User not found".to_string()));
    }

    // Insert (upsert to handle duplicate gracefully — use ON CONFLICT DO NOTHING)
    let result = sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(team_id)
    .bind(req.user_id)
    .bind(&req.role)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::BadRequest("Failed to add member".to_string()));
    }

    // Return the member info
    let member = sqlx::query_as::<_, TeamMemberResponse>(
        "SELECT tm.team_id, tm.user_id, u.username, tm.role, tm.joined_at \
         FROM team_members tm \
         JOIN users u ON u.id = tm.user_id \
         WHERE tm.team_id = $1 AND tm.user_id = $2",
    )
    .bind(team_id)
    .bind(req.user_id)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(member)))
}

/// DELETE /teams/:id/members/:user_id — Remove a member (owner/admin only)
async fn remove_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((team_id, target_user_id)): Path<(i32, i32)>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Must be owner or admin
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;

    // Cannot remove self
    if target_user_id == user_id {
        return Err(AppError::BadRequest("You cannot remove yourself from the team".to_string()));
    }

    // Check target is a member
    let target_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&state.db)
    .await?;

    let target_role = target_role
        .ok_or_else(|| AppError::ResourceNotFound("Member not found in team".to_string()))?;

    // Cannot remove the owner
    if target_role == "owner" {
        return Err(AppError::BadRequest("Cannot remove the team owner".to_string()));
    }

    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_user_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({"message": "Member removed successfully"})))
}

/// GET /teams/:id/members — List team members
async fn get_team_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // Verify membership
    check_membership(&state, team_id, user_id).await?;

    let members = sqlx::query_as::<_, TeamMemberResponse>(
        "SELECT tm.team_id, tm.user_id, u.username, tm.role, tm.joined_at \
         FROM team_members tm \
         JOIN users u ON u.id = tm.user_id \
         WHERE tm.team_id = $1 \
         ORDER BY tm.joined_at ASC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(members))
}

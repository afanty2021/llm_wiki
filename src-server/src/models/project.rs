use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: i32,
    pub team_id: i32,
    pub name: String,
    pub storage_path: String,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProjectResponse {
    pub id: i32,
    pub team_id: i32,
    pub name: String,
    pub storage_path: String,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub file_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub team_id: Option<i32>,
    pub storage_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListProjectsQuery {
    pub team_id: Option<i32>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

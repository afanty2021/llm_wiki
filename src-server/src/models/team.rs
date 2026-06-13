use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Team {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TeamResponse {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub member_count: i64,
}

impl From<Team> for TeamResponse {
    fn from(team: Team) -> Self {
        TeamResponse {
            id: team.id,
            name: team.name,
            description: team.description,
            created_by: team.created_by,
            created_at: team.created_at,
            member_count: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateTeamRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListTeamsQuery {
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: i32,
    pub role: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TeamMemberResponse {
    pub team_id: i32,
    pub user_id: i32,
    pub username: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

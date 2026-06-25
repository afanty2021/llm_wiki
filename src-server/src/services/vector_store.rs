use async_trait::async_trait;
use sqlx::PgPool;
use crate::AppError;
use crate::services::embedding::VectorSearchResult;

/// 向量存储后端抽象。Phase 1：PgVectorStore 原样收拢 embedding.rs 的 3 段 SQL，
/// 语义不变（仍 ON CONFLICT (project_id, wiki_page_id)，旧约束未变）。Phase 2 才改 chunk 级。
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert_vectors(
        &self,
        project_id: i32,
        pages: &[(String, Vec<f32>)],
    ) -> Result<usize, AppError>;
    async fn delete_page(&self, project_id: i32, path: &str) -> Result<(), AppError>;
    async fn search(
        &self,
        project_id: i32,
        query_embedding: Vec<f32>,
        limit: i32,
    ) -> Result<Vec<VectorSearchResult>, AppError>;
}

/// pgvector 实现。持 PgPool（= Pool<Postgres>，内部已 Arc，Clone 廉价，无需外层 Arc）。
pub struct PgVectorStore {
    pool: PgPool,
}

impl PgVectorStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl VectorStore for PgVectorStore {
    async fn upsert_vectors(
        &self,
        project_id: i32,
        pages: &[(String, Vec<f32>)],
    ) -> Result<usize, AppError> {
        if pages.is_empty() {
            return Ok(0);
        }
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO embeddings (project_id, wiki_page_id, content) VALUES ",
        );
        for (i, (path, vec)) in pages.iter().enumerate() {
            if i > 0 {
                qb.push(",");
            }
            qb.push("(")
                .push_bind(project_id)
                .push(", ")
                .push_bind(path.clone())
                .push(", ")
                .push_bind(pgvector::Vector::from(vec.clone()))
                .push(")");
        }
        // ⚠️ Phase 1 保留原 ON CONFLICT（旧约束 uniq_embeddings_page 仍在）。
        // Phase 2 改 DELETE+INSERT（见 spec §5.3 ON CONFLICT 失效警告）。
        qb.push(" ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content");
        let rows = qb.build().execute(&self.pool).await?.rows_affected();
        Ok(rows as usize)
    }

    async fn delete_page(&self, project_id: i32, path: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(path)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn search(
        &self,
        project_id: i32,
        query_embedding: Vec<f32>,
        limit: i32,
    ) -> Result<Vec<VectorSearchResult>, AppError> {
        let embedding = pgvector::Vector::from(query_embedding);
        let results = sqlx::query_as::<_, VectorSearchResult>(
            "SELECT
                wp.path,
                wp.title,
                COALESCE(substring(COALESCE(wp.content, '') FROM 1 FOR 200), '') as snippet,
                1.0 - (e.content <=> $1) as score
            FROM embeddings e
            JOIN wiki_pages wp ON e.wiki_page_id = wp.path AND e.project_id = wp.project_id
            WHERE e.project_id = $2
            ORDER BY e.content <=> $1
            LIMIT $3",
        )
        .bind(embedding)
        .bind(project_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::DatabaseError)?;
        Ok(results)
    }
}

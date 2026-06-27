use async_trait::async_trait;
use sqlx::PgPool;
use crate::AppError;

/// 向量存储后端抽象（chunk 级）。Phase 2：每 page 多 chunk，DELETE+INSERT 写入，
/// 检索按 §5.4 三层聚合（chunk 去重取最高分 → page top-N）。
#[async_trait]
pub trait VectorStore: Send + Sync {
    /// 写入一个 page 的全部 chunk（先 DELETE 该 page 旧 chunk，再 INSERT 新 chunk）。
    /// page_id = wiki_page.path。空 chunks → 仅 DELETE（清空该页向量）。
    async fn upsert_page_chunks(
        &self,
        project_id: i32,
        page_id: &str,
        chunks: Vec<PageChunk>,
    ) -> Result<(), AppError>;
    /// 删除一个 page 的全部 chunk。
    async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(), AppError>;
    /// chunk 级检索 + 按 page 聚合：top_k_chunks 拉宽候选，去重取每 page 最高分，外层按相关度取 top_n_pages。
    async fn search_chunks(
        &self,
        project_id: i32,
        query_vec: Vec<f32>,
        top_k_chunks: usize,
        top_n_pages: usize,
    ) -> Result<Vec<ChunkHit>, AppError>;
    /// HNSW ef_search（事务内 set_config 生效）。
    fn ef_search(&self) -> usize;
}

pub struct PageChunk {
    pub chunk_index: i32,
    pub chunk_text: String,
    pub heading_path: Option<String>,
    pub vector: Vec<f32>,
}

/// 一个命中 page 的代表 chunk（最高分），含 rerank 输入文本。
/// sqlx::FromRow：search_chunks 用 query_as::<_, ChunkHit>（列别名 page_id/title/snippet/rerank_text/score 对齐）。
#[derive(sqlx::FromRow)]
pub struct ChunkHit {
    pub page_id: String,
    pub title: String,
    pub snippet: String,
    pub rerank_text: String,
    pub score: f64,
}

/// pgvector 实现。持 PgPool（= Pool<Postgres>，内部已 Arc，Clone 廉价，无需外层 Arc）。
pub struct PgVectorStore {
    pool: PgPool,
    ef_search: usize,
}

impl PgVectorStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool, ef_search: 80 }
    }
    pub fn with_ef_search(pool: PgPool, ef_search: usize) -> Self {
        Self { pool, ef_search }
    }
}

#[async_trait]
impl VectorStore for PgVectorStore {
    async fn upsert_page_chunks(
        &self,
        project_id: i32,
        page_id: &str,
        chunks: Vec<PageChunk>,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        // 先删旧 chunk（清空该 page 向量，规避 ON CONFLICT 失效——见 spec §5.3）
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(page_id)
            .execute(&mut *tx)
            .await?;
        if !chunks.is_empty() {
            for ch in chunks {
                sqlx::query(
                    "INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, heading_path, content)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(project_id)
                .bind(page_id)
                .bind(ch.chunk_index)
                .bind(&ch.chunk_text)
                .bind(ch.heading_path.as_deref())
                .bind(pgvector::Vector::from(ch.vector))
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(page_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn search_chunks(
        &self,
        project_id: i32,
        query_vec: Vec<f32>,
        top_k_chunks: usize,
        top_n_pages: usize,
    ) -> Result<Vec<ChunkHit>, AppError> {
        // 事务内 SET LOCAL hnsw.ef_search（自动提交模式下单独 SET 对检索静默无效）。
        // set_config 第三参 true = 事务级；参数化防注入。
        let embedding = pgvector::Vector::from(query_vec);
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT set_config('hnsw.ef_search', $1, true)")
            .bind(self.ef_search.to_string())
            .execute(&mut *tx)
            .await?;
        let hits = sqlx::query_as::<_, ChunkHit>(
            // §5.4 三层：①内层 chunk 余弦 top_k；②中层 DISTINCT ON (wiki_page_id) 取每 page 最高分代表 chunk
            //（要求 ORDER BY 最左前缀=wiki_page_id）；③外层按 score 取 page top-N（非 page_id 字典序）。
            // snippet/rerank_text 用 COALESCE(chunk_text, wp.content) 兜底存量 NULL。
            "SELECT page_id, title, snippet, rerank_text, score FROM (
                SELECT DISTINCT ON (c.wiki_page_id)
                       c.wiki_page_id AS page_id,
                       wp.title,
                       substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 200) AS snippet,
                       COALESCE(c.chunk_text, wp.content) AS rerank_text,
                       c.score
                FROM (
                    SELECT e.wiki_page_id, e.chunk_text,
                           1.0 - (e.content <=> $1) AS score
                    FROM embeddings e
                    WHERE e.project_id = $2
                    ORDER BY e.content <=> $1
                    LIMIT $3
                ) c
                JOIN wiki_pages wp ON c.wiki_page_id = wp.path AND wp.project_id = $2
                ORDER BY c.wiki_page_id, c.score DESC
            ) t
            ORDER BY t.score DESC
            LIMIT $4",
        )
        .bind(embedding)
        .bind(project_id)
        .bind(top_k_chunks as i64)
        .bind(top_n_pages as i64)
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::DatabaseError)?;
        tx.commit().await?;
        Ok(hits)
    }

    fn ef_search(&self) -> usize {
        self.ef_search
    }
}
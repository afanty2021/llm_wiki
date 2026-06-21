-- 005: embedding 表(bge-m3 1024 维) + 幂等 upsert 约束 + HNSW 索引
-- 该表此前从未在本 DB 落地（001 的 embeddings/extension 部分未生效），故从零创建。
-- 列定义对齐 001_initial_schema.sql 的原始 embeddings 定义（VARCHAR(255) + FK ON DELETE CASCADE），
-- 仅 content 维度改为 1024（bge-m3），ivfflat 换 HNSW，新增幂等 UNIQUE(project_id, wiki_page_id)。

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    wiki_page_id VARCHAR(255) NOT NULL,
    content VECTOR(1024) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 幂等：同 (project_id, wiki_page_id) 唯一，供 ingest/CRUD ON CONFLICT upsert
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uniq_embeddings_page'
    ) THEN
        ALTER TABLE embeddings ADD CONSTRAINT uniq_embeddings_page
            UNIQUE (project_id, wiki_page_id);
    END IF;
END $$;

-- project_id 强制 NOT NULL：embedding 必属于某 project；NULL 在 SQL 标准里不参与
-- UNIQUE 比较，会破坏 (project_id, wiki_page_id) 的 ON CONFLICT upsert 语义。
-- SET NOT NULL 幂等（已是 NOT NULL 时为 no-op）；表已存在时 CREATE TABLE 的 NOT NULL 不会回填。
ALTER TABLE embeddings ALTER COLUMN project_id SET NOT NULL;

DROP INDEX IF EXISTS idx_embeddings_content;
-- HNSW 参数用默认值(m=16, ef_construction=64)；规模增长后可调 WITH (m=16, ef_construction=128)
CREATE INDEX IF NOT EXISTS idx_embeddings_content
    ON embeddings USING hnsw (content vector_cosine_ops);

-- 辅助查询索引（按 project 过滤）
CREATE INDEX IF NOT EXISTS idx_embeddings_project
    ON embeddings (project_id);

COMMIT;

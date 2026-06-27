-- 011: chunk 级向量（扩展 embeddings 单表）— spec §5.1 修订版（加维度统一）
-- 修正事实：生产库 embeddings 是 vector(1536)（001 建，005 未 ALTER），与 config/bge-m3 1024 冲突。
-- 本 migration 统一到 1024。
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_text TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS heading_path VARCHAR(512);

-- 维度统一：1536 → 1024（跟 config bge-m3）。主库 embeddings 0 条数据，无损失。
-- pgvector ALTER 维度：HNSW 索引会自动随列重建保留（实测确认）。
ALTER TABLE embeddings ALTER COLUMN content TYPE VECTOR(1024);

-- 删除 005 的每页唯一约束（真实约束名 uniq_embeddings_page）
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS uniq_embeddings_page;

-- DO $$ 守卫保证幂等
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_unique_chunk') THEN
        ALTER TABLE embeddings ADD CONSTRAINT embeddings_unique_chunk
            UNIQUE (project_id, wiki_page_id, chunk_index);
    END IF;
END $$;

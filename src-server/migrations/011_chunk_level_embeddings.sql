-- 011: chunk 级向量（扩展 embeddings 单表）+ 维度收敛到 1024
-- 维度：005 注释称从零建 content VECTOR(1024)（001 的 embeddings 部分未生效），故多数跑过 005 的库
-- 应已是 1024；若某环境 001 先建了 1536 表则 005 skip。下方 ALTER TYPE VECTOR(1024) 行为：
--   - 列已 1024 或表为空 → 成功（no-op）。
--   - 表中有 1536 维数据行 → **报错中止**（pgvector 无 1536→1024 维度截断 cast，错误
--     `expected 1024 dimensions, not 1536`）。这种库须先 `TRUNCATE embeddings` 再迁移，
--     之后重新 ingest 生成 1024 维向量（spec §5.1：主库 0 条数据，无损失）。
-- HNSW 索引随列自动保留（pgvector 实测）。实施前 psql 核实实际维度与行数。

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_text TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS heading_path VARCHAR(512);

-- 维度收敛到 1024（跟 config bge-m3）。已是 1024/空表 → no-op；有 1536 行 → 报错（见上，须先清空）
ALTER TABLE embeddings ALTER COLUMN content TYPE VECTOR(1024);

-- 删除 005 的每页唯一约束（真实约束名 uniq_embeddings_page，见 005:24）
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS uniq_embeddings_page;

-- 新约束：(project_id, wiki_page_id, chunk_index) —— 同一 page 多 chunk
-- DO $$ 守卫保证幂等（ADD CONSTRAINT 无 IF NOT EXISTS 语法）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_unique_chunk') THEN
        ALTER TABLE embeddings ADD CONSTRAINT embeddings_unique_chunk
            UNIQUE (project_id, wiki_page_id, chunk_index);
    END IF;
END $$;

-- 为 wiki_pages 表添加缺失的列，支持知识图谱和搜索功能
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS page_type VARCHAR(50) DEFAULT 'concept';
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]';
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_wiki_pages_page_type ON wiki_pages(project_id, page_type);

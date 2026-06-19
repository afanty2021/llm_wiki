-- ingest_jobs: 源文档摄取队列的真相源（PG 持久化）
CREATE TABLE ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_paths TEXT[] NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | running | succeeded | failed
    stage VARCHAR(40),                               -- parsing | analyzing | generating | building_index
    progress INTEGER DEFAULT 0,                      -- 0-100
    error TEXT,                                      -- mark_job_failed 写
    result JSONB,                                    -- IngestJobResult 序列化（mark_job_succeeded 写）
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX idx_ingest_jobs_project ON ingest_jobs(project_id);
CREATE INDEX idx_ingest_jobs_status  ON ingest_jobs(status) WHERE status IN ('pending', 'running');

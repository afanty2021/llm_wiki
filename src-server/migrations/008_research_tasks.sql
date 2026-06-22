-- 008_research_tasks.sql — Layer 3 Phase C: Deep Research 任务（项目级团队共享）
CREATE TABLE research_tasks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    topic          TEXT NOT NULL,
    search_queries TEXT[],
    status         VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued|searching|synthesizing|saving|done|error
    stage          VARCHAR(40),                             -- searching|synthesizing|saving(终态保留最后值)
    web_results    JSONB,
    synthesis      TEXT,
    saved_path     TEXT,
    source_kind    VARCHAR(20) NOT NULL DEFAULT 'manual',  -- manual|review
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_research_status ON research_tasks(project_id, status, created_at);
CREATE INDEX idx_research_running ON research_tasks(status) WHERE status IN ('queued','searching','synthesizing','saving');

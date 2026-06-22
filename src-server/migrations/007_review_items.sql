-- 007_review_items.sql — Layer 3 Phase B: 审核队列（项目级团队共享）
CREATE TABLE review_items (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_path     TEXT,
    review_type     TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    affected_pages  TEXT[],
    search_queries  TEXT[],
    options         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    resolved_action TEXT,
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_review_open ON review_items(project_id, status, created_at);

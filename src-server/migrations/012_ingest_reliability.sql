-- 012: ingest 队列可靠性字段（取消/重试/部分失败/SSE）
-- 004 定义 status VARCHAR(20)，放不下 succeeded_with_warnings(23)。
ALTER TABLE ingest_jobs ALTER COLUMN status TYPE VARCHAR(40);
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS retry_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS max_retries      INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;  -- 多 worker 占位，单 worker 不用
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS item_states      JSONB NOT NULL DEFAULT '[]'::jsonb;
-- item_states: [{ "path": "raw/x.md", "status": "done|failed|skipped", "error": null }]

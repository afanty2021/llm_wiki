-- 014_learning.sql — M2：learning 三表（plans/items/events + period_key 部分唯一索引，spec §4.1）
CREATE TABLE learning_plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  reason TEXT,
  origin VARCHAR(10) NOT NULL CHECK (origin IN ('chat','weekly')),
  period_key VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_plans_period ON learning_plans(user_id, origin, period_key) WHERE period_key IS NOT NULL;

CREATE TABLE learning_items (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('wiki_page','media')),
  target_ref TEXT NOT NULL,
  timecode_start_s INTEGER, timecode_end_s INTEGER,
  label VARCHAR(200) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','completed')),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_items_plan ON learning_items(plan_id);

CREATE TABLE learning_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES learning_items(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('view','seen','complete','ask','plan_created')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_user_time ON learning_events(user_id, created_at DESC);
CREATE INDEX idx_events_item ON learning_events(item_id) WHERE item_id IS NOT NULL;

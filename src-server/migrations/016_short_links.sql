-- 016_short_links.sql — Task 9b：/s/ 短链（结构性根治 LLM 截断 /t/ 长链接问题）。
-- GET /s/:code → 303 → 现签 /t/<token>（7d）。code 为 10 字符 url-safe
-- [a-zA-Z0-9]（生成侧保证，列宽 16 留余量）；code 本身不设过期（M2 capability
-- URL——与 /t/ token 同信任模型，plan 存活期间点击即现签新 token，链接永不失效；
-- 撤销 = 删行或删 plan，两者均 ON DELETE CASCADE）。
CREATE TABLE short_links (
  code VARCHAR(16) PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_short_links_plan ON short_links(plan_id);

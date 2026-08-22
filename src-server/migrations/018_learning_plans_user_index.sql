-- 018_learning_plans_user_index.sql — 遗留债（分支终审 M4 排期项）
-- 014 的 idx_plans_period 是 partial（WHERE period_key IS NOT NULL）：查询面
-- WHERE p.user_id = $1（计划列表 training.rs）与 GROUP BY p.user_id（overview
-- 聚合）不隐含该谓词 → 优化器不可用，全表扫。补普通 btree。
CREATE INDEX IF NOT EXISTS idx_learning_plans_user ON learning_plans(user_id);

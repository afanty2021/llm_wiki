-- 019_teacher_profiles_wecom_userid_lower_idx.sql — Wendy/wendy 双档案事故根修
-- 企微回调的 userid 大小写不保证稳定（同账号先后送出 wendy/Wendy 两形态），
-- bind 的精确匹配撞出第二个空档案（2026-09-09 实锺）。bind 查找/锁已改 lower
-- 归一（training.rs）；本索引为库级兜底：同账号任何大小写形态只允许一行，
-- 并让归一化查找走索引。前置：存量大小写重复已人工合并（Wendy→10704）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_profiles_wecom_userid_lower
    ON teacher_profiles (lower(wecom_userid));

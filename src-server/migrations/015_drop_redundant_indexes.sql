-- 015_drop_redundant_indexes.sql — M2 前置：清理 013 遗留的冗余索引
-- media_assets.slug / teacher_profiles.wecom_userid 均为 UNIQUE NOT NULL，
-- 唯一约束已自带索引，二级索引纯写放大（INSERT 双倍索引维护），查询计划不走。
DROP INDEX IF EXISTS idx_media_assets_slug;
DROP INDEX IF EXISTS idx_teacher_profiles_wecom;

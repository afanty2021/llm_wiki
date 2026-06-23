-- 010_llm_providers_team_scope.sql — Layer 4: llm_providers 升 team 维度
ALTER TABLE llm_providers ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE;
UPDATE llm_providers lp SET team_id = (SELECT team_id FROM projects WHERE id = lp.project_id);
-- create_project 强制 team_id,正常数据均非 NULL;orphan(NULL)属异常,清理
DELETE FROM llm_providers WHERE team_id IS NULL;
ALTER TABLE llm_providers ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE llm_providers DROP COLUMN project_id;
DROP INDEX IF EXISTS idx_llm_providers_project;
DROP INDEX IF EXISTS idx_llm_providers_type;
DROP INDEX IF EXISTS idx_llm_providers_enabled;
-- 迁移前 project 维度,同 team 多 project 可能各配同 provider_type;现状无 DELETE 路由,
-- disabled 行累积。升 team + UNIQUE 前去重:优先保留 enabled(is_enabled DESC),同状态取 id 最小。
-- 否则 MIN(id) 可能留 disabled 行、删 enabled 行,使 team 解析到无可用 provider,且 DELETE 不可逆。
DELETE FROM llm_providers lp
WHERE lp.id NOT IN (
    SELECT DISTINCT ON (team_id, provider_type) id
    FROM llm_providers
    ORDER BY team_id, provider_type, is_enabled DESC, id
);
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_team_type_unique UNIQUE(team_id, provider_type);
CREATE INDEX idx_llm_providers_team_enabled ON llm_providers(team_id) WHERE is_enabled = TRUE;

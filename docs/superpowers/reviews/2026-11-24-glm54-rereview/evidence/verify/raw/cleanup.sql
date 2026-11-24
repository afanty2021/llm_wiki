\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE del_p AS SELECT id FROM projects WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00' AND name LIKE 'LT项目\_t%\_%';
CREATE TEMP TABLE del_u AS SELECT id FROM users WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00' AND (username LIKE 't3\_%' OR username LIKE 't6\_%' OR username LIKE 't7\_%' OR username LIKE 't9\_%' OR username LIKE 't8\_%' OR username LIKE 't10\_%' OR username LIKE 't6gate\_%' OR username LIKE 'wecom\_t%\_%');
CREATE TEMP TABLE del_m AS SELECT id FROM media_assets WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00';
DO $$ DECLARE np int; nu int; nm int;
BEGIN
  SELECT count(*) INTO np FROM del_p; SELECT count(*) INTO nu FROM del_u; SELECT count(*) INTO nm FROM del_m;
  IF np <> 52 OR nu <> 151 OR nm <> 26 THEN RAISE EXCEPTION 'count mismatch: projects % users % media %', np, nu, nm; END IF;
  -- 防线：待删项目/用户/媒体不得被窗口外的行经无级联外键引用
  IF EXISTS (SELECT 1 FROM wiki_pages WHERE project_id IN (SELECT id FROM del_p) AND created_at < '2026-11-23 23:37:02+00') THEN RAISE EXCEPTION 'pre-window page under a target project'; END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE created_by IN (SELECT id FROM del_u) AND id NOT IN (SELECT id FROM del_p)) THEN RAISE EXCEPTION 'target user owns a non-target project'; END IF;
END $$;
DELETE FROM projects WHERE id IN (SELECT id FROM del_p);
DELETE FROM users WHERE id IN (SELECT id FROM del_u);
DELETE FROM media_assets WHERE id IN (SELECT id FROM del_m);
COMMIT;

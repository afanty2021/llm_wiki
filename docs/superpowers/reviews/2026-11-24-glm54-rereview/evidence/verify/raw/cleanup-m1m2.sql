\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE del_p AS SELECT id FROM projects WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00';
CREATE TEMP TABLE del_u AS SELECT id FROM users WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00' AND username NOT LIKE 'wecom\_%';
DO $$ DECLARE np int; nu int;
BEGIN
  SELECT count(*) INTO np FROM del_p; SELECT count(*) INTO nu FROM del_u;
  IF np <> 65 OR nu <> 88 THEN RAISE EXCEPTION 'count mismatch: projects % users %', np, nu; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE created_at >= '2026-11-23 23:37:02+00' AND created_at < '2026-11-23 23:38:00+00' AND id NOT IN (SELECT id FROM del_u)) THEN RAISE EXCEPTION 'in-window user excluded from targets'; END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE created_by IN (SELECT id FROM del_u) AND id NOT IN (SELECT id FROM del_p)) THEN RAISE EXCEPTION 'target user owns a non-target project'; END IF;
  IF EXISTS (SELECT 1 FROM ingest_jobs WHERE project_id NOT IN (SELECT id FROM del_p) AND status NOT IN ('succeeded','succeeded_with_warnings','failed','cancelled')) THEN RAISE EXCEPTION 'non-terminal ingest job outside targets'; END IF;
  IF EXISTS (SELECT 1 FROM research_tasks WHERE project_id NOT IN (SELECT id FROM del_p) AND status NOT IN ('done','error','cancelled')) THEN RAISE EXCEPTION 'non-terminal research task outside targets'; END IF;
END $$;
DELETE FROM projects WHERE id IN (SELECT id FROM del_p);
DELETE FROM users WHERE id IN (SELECT id FROM del_u);
COMMIT;

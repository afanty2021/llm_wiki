#!/usr/bin/env python3
"""P2 存量 embed 回填（2026-09-09 立项）：对 project 614 现缺 embeddings 的页强制 PUT
（内容=备份原文，frontmatter 走服务端现值回落），借 PUT /page 的 re-embed 副作用补向量。
清单每轮现取（自然续跑：已嵌页不再出现在缺向量集）；--limit N 干跑。
写入形态与 611 页先行批（已 Approve）一致：唯一变更=updated_at bump + embeddings 行新增。

纪律：执行前全量备份（~/kb-dumps/20260909-embed-backfill-p2/pre_pages.csv，
path/title/content/frontmatter/updated_at 五列）→ 干跑 --limit 10 → 全量。
"""
import csv, importlib.util, io, json, os, sys, time

spec = importlib.util.spec_from_file_location("wc", "/Users/berton/Github/kb-obsidian/llm_wiki/tools/wiki-cleanup.py")
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)

BACKUP = os.path.expanduser("~/kb-dumps/20260909-embed-backfill-p2/pre_pages.csv")
limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None

csv.field_size_limit(sys.maxsize)
backup = {r["path"]: r["content"] for r in csv.DictReader(open(BACKUP, encoding="utf-8"))}

# 现取缺向量清单（created_at DESC——170 批页面检索受损最重，优先补）
sql = ("COPY (SELECT path, title, updated_at FROM wiki_pages wp WHERE wp.project_id=614 "
       "AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.project_id=wp.project_id "
       "AND e.wiki_page_id = wp.path) ORDER BY wp.created_at DESC) TO STDOUT WITH (FORMAT csv, HEADER true)")
raw = os.popen('docker exec -i src-server-postgres-1 psql -U llmwiki -d llmwiki -c "%s"' % sql).read()
rows = list(csv.DictReader(io.StringIO(raw)))
if limit:
    rows = rows[:limit]
print(f"[backfill] 目标 {len(rows)} 页（现取时点，created_at DESC；备份 {len(backup)} 页）", flush=True)

token = os.environ.get("WIKI_TOKEN") or wc.login_default()
ok = fail = skip = 0
t0 = time.time()
for i, r in enumerate(rows, 1):
    p = r["path"]
    if p not in backup:
        skip += 1
        continue
    try:
        wc.put_page(token, p, backup[p], None, skip_if_same=False)
        ok += 1
    except Exception as e:
        fail += 1
        print(f"  FAIL {p}: {e}", flush=True)
    if i % 100 == 0:
        rate = i / (time.time() - t0)
        print(f"  进度 {i}/{len(rows)} ok={ok} fail={fail} skip={skip} ({rate:.1f} 页/s)", flush=True)
    time.sleep(0.15)
print(f"[backfill] 完成: ok={ok} fail={fail} skip={skip}", flush=True)

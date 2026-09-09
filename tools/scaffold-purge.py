#!/usr/bin/env python3
"""存量脚手架泄漏清理（2026-09-09）：489 页正文混入 step2 管线工件——
`---END FILE---` 分隔行（容差修复前旧码落库）与 `---REVIEW: …` 段。
剥离语义逐行镜像 src-server flush_block（fence 感知 / ASCII 大小写无关
---END REVIEW--- 闭段 / 未闭合段剥到尾）。备份→干跑--limit N→全量；
内容变化页 PUT（If-Match + frontmatter 现值回落）借路由自动 re-embed。"""
import csv, importlib.util, io, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)
csv.field_size_limit(sys.maxsize)

END_RE = re.compile(r"(?i)^\s*-{2,}\s*END\s+FILE\s*(?:-{2,})?\s*$")
limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
BACKUP = os.path.expanduser("~/kb-dumps/20260909-scaffold-purge/pre_pages.csv")

def clean(content):
    """镜像 flush_block：返回 (新内容, 剥离件数)。fence 内行不参与判定。"""
    out, in_review, in_fence, n = [], False, False, 0
    for ln in content.split("\n"):
        t = ln.strip()
        if t.startswith("```"):
            in_fence = not in_fence
            out.append(ln); continue
        if in_fence:
            out.append(ln); continue
        if in_review:
            if t.upper() == "---END REVIEW---":
                in_review = False; n += 1
            continue
        if t.startswith("---REVIEW:"):
            in_review = True; continue
        if END_RE.match(t):
            n += 1; continue
        out.append(ln)
    if in_review:
        n += 1
    if n == 0:
        return content, 0
    return "\n".join(out).strip("\n"), n

# 现取受影响页（END 行 OR REVIEW 段）
sql = ("COPY (SELECT path, content FROM wiki_pages WHERE project_id=614 "
       "AND (content ~* '---+[[:space:]]*END[[:space:]]+FILE' OR content LIKE '%---REVIEW:%')) "
       "TO STDOUT WITH (FORMAT csv)")
raw = subprocess.run(["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-c", sql],
                     capture_output=True, text=True, check=True).stdout
rows = list(csv.reader(io.StringIO(raw)))
rows = [r for r in rows if len(r) >= 2 and r[0].strip()]
if limit:
    rows = rows[:limit]
print(f"[scaffold-purge] 受影响页 {len(rows)}", flush=True)

token = os.environ.get("WIKI_TOKEN") or wc.login_default()
ok = fail = noop = empty = 0
t0 = time.time()
for i, (path, content) in enumerate(rows, 1):
    new, n = clean(content)
    if n == 0 or new == content:
        noop += 1; continue
    if not new.strip():
        empty += 1
        print(f"  [SKIP-EMPTY] {path}（剥后为空，须人工复核）", flush=True)
        continue
    try:
        wc.put_page(token, path, new, None, skip_if_same=False)
        ok += 1
    except Exception as e:
        fail += 1
        print(f"  FAIL {path}: {e}", flush=True)
    if i % 100 == 0:
        print(f"  进度 {i}/{len(rows)} ok={ok} fail={fail} noop={noop} empty={empty} ({i/(time.time()-t0):.1f} 页/s)", flush=True)
    time.sleep(0.15)
print(f"[scaffold-purge] 完成: 写 {ok} 失败 {fail} 无工件 {noop} 空保护 {empty}", flush=True)

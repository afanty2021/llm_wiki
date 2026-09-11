#!/usr/bin/env python3
"""resolve-unresolved-window.py — 791 未决页的人工批辅助解析（出生窗口约束）。

归因原理：坏值页出生于某个 ingest job 的处理过程，该 job 的 source_paths 就是
其真实来源的候选集（结构性证据，强于全局内容匹配）。
  窗口 = [job.created_at-60s, COALESCE(finished_at, created_at+40min)] 覆盖页 created_at。
裁定类：
  STRUCTURAL-SINGLE  窗口内唯一源        → 直接归因（构造性真值）
  PROBE-RESOLVED     多候选，探针分出     → 候选集内 line→latin 两级，best≥0.3 且领先≥0.1
  AMBIGUOUS          多候选探针分不出     → 人工
  NO-WINDOW          无作业覆盖           → 人工（含 enriched 底稿全局 best 参考）
只产 proposal.csv（只读分析）；执行走 --execute（带备份手工 SQL 同 I7 渠道）。
"""
import argparse, csv, json, re, subprocess
from datetime import timedelta
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def norm(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    s = re.sub(r"[\[\]#>*`]|---", " ", s)
    return re.sub(r"\s+", "", s).lower()

def latin_tokens(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    toks = re.findall(r"[A-Za-z][A-Za-z'’\-]{3,}", s)
    out = []
    stop = set("the and that with this from they their have will your what when about which there these those into more also some them then than each other where while being were students student lesson teachers look think unit word picture practice read write say talk play class school story english book".split())
    for w in toks:
        b = w.lower().strip("'’").replace("'s", "")
        b = b[:-1] if b.endswith("s") and len(b) > 4 else b
        if b not in stop and len(b) >= 4:
            out.append(b)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    # ① 作业表（json_agg 出规范 JSON；test-proj 探针作业按路径过滤）
    jobs = []
    blob = psql("SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT id::text id, created_at::text ca, "
                "started_at::text sa, finished_at::text fa, to_jsonb(source_paths) sp "
                "FROM ingest_jobs WHERE source_paths::text LIKE '%sources/transcripts/%' "
                "OR source_paths::text LIKE '%raw/sources/%') t")
    for j in json.loads(blob):
        paths = [x for x in j["sp"] if isinstance(x, str)
                 and (x.startswith("sources/transcripts/") or x.startswith("raw/sources/"))]
        if paths:
            jobs.append({"id": j["id"], "created": j["ca"], "started": j["sa"],
                         "finished": j["fa"], "paths": paths})
    # ② 未决页（当前 DB 实时坏值集 = 791）
    pages = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, created_at::text ca, content "
        "FROM wiki_pages WHERE project_id=614 AND NOT path LIKE 'wiki/%' "
        "AND (sources IS NULL OR sources='[]'::jsonb OR sources::text LIKE '%\"source.md\"%')) t"))
    print("jobs:", len(jobs), "broken pages:", len(pages))
    # ③ 窗口候选
    from datetime import datetime
    def dt(s):
        return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))
    parsed = []
    for j in jobs:
        start = dt(j["started"] or j["created"])
        end = dt(j["finished"]) if j["finished"] not in (None, "", "NULL") else start + timedelta(minutes=40)
        parsed.append((start - timedelta(seconds=60), end, set(j["paths"]), j["id"]))
    proposal = []
    stats = {"STRUCTURAL-SINGLE": 0, "PROBE-RESOLVED": 0, "AMBIGUOUS": 0, "NO-WINDOW": 0}
    for pg in pages:
        t = dt(pg["ca"])
        cands = set()
        wjobs = []
        for lo, hi, paths, jid in parsed:
            if lo <= t <= hi:
                cands |= {c for c in paths if c.endswith(".md")}
                wjobs.append(jid[:8])
        cands = sorted(cands)
        if not cands:
            stats["NO-WINDOW"] += 1
            proposal.append({"path": pg["path"], "class": "NO-WINDOW", "candidates": len(cands),
                             "chosen": "", "score": "", "window_jobs": ",".join(wjobs)})
            continue
        probes = sorted({norm(l) for l in pg["content"].split("\n") if len(norm(l)) >= 24},
                        key=len, reverse=True)[:12]
        toks = set(latin_tokens(pg["content"]))
        scores = {}
        for c in cands:
            f = ROOT / c
            if not f.exists():
                continue
            raw = f.read_text(encoding="utf-8", errors="replace")
            joined = "\n".join(normed := [norm(l) for l in raw.split("\n") if len(norm(l)) >= 24])
            hit = sum(len(p) for p in probes if p in joined)
            probe_chars = sum(len(p) for p in probes) or 1
            s_line = hit / probe_chars
            lat = set(latin_tokens(raw))
            s_tok = (len(toks & lat) / len(toks)) if toks else 0.0
            scores[c] = max(s_line, s_tok)
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        if len(cands) == 1:
            cls, chosen, sc = "STRUCTURAL-SINGLE", cands[0], scores.get(cands[0], 0)
        elif ranked and ranked[0][1] >= 0.3 and (len(ranked) == 1 or ranked[0][1] - ranked[1][1] >= 0.1):
            cls, chosen, sc = "PROBE-RESOLVED", ranked[0][0], ranked[0][1]
        else:
            cls, chosen, sc = "AMBIGUOUS", (ranked[0][0] if ranked else ""), (ranked[0][1] if ranked else 0)
        stats[cls] += 1
        proposal.append({"path": pg["path"], "class": cls, "candidates": len(cands),
                         "chosen": chosen, "score": round(sc, 3), "window_jobs": ",".join(wjobs)})
    with open(OUT / "proposal-v3.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "class", "candidates", "chosen", "score", "window_jobs"])
        w.writeheader()
        w.writerows(proposal)
    print("stats:", stats, "| proposal-v3.csv 落", OUT)
    if args.execute:
        mp = OUT / "proposal-v3.csv"
        rows = [r for r in csv.DictReader(open(mp)) if r["class"] in ("STRUCTURAL-SINGLE", "PROBE-RESOLVED")]
        with open(OUT / "c1-window-backup.csv", "w") as f:
            for i in range(0, len(rows), 200):
                a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows[i:i+200])
                f.write(psql(f"COPY (SELECT path,title,page_type,frontmatter,sources,content FROM wiki_pages "
                             f"WHERE project_id=614 AND path IN ({a})) TO STDOUT WITH CSV"))
        done = 0
        for r in rows:
            newj = json.dumps([r["chosen"]], ensure_ascii=False).replace("'", "''")
            q = (f"UPDATE wiki_pages SET sources='{newj}'::jsonb, "
                 f"frontmatter=jsonb_set(CASE WHEN jsonb_typeof(coalesce(frontmatter,'{{}}'::jsonb))='object' "
                 f"THEN coalesce(frontmatter,'{{}}'::jsonb) ELSE '{{}}'::jsonb END, "
                 f"'{{sources}}','{newj}'::jsonb) "
                 f"WHERE project_id=614 AND path='{r['path'].replace(chr(39), chr(39)*2)}'")
            psql(q)
            done += 1
        print("executed:", done)

if __name__ == "__main__":
    main()

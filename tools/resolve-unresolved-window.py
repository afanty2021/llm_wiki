#!/usr/bin/env python3
"""resolve-unresolved-window.py — 未决坏值页的出生窗口约束解析（v2）。

归因原理：坏值页出生于某个 ingest job 的处理过程，该 job 的 source_paths 就是
其真实来源的候选集（结构性证据，强于全局内容匹配）。
  窗口 = [job.created_at-60s, COALESCE(finished_at, created_at+40min)] 覆盖页 created_at。

v2（2026-09-11 补修评审 §四 后重写，修的是第一轮实测暴露的缺陷）：
  1. 评分器换 CJK 感知（复用 tools/recheck-window-attribution.py 的 scorer）——
     纯拉丁词元探针对中文改写页零命中，小词元集单词元满分（第一轮 ≥19 例错归因根因）。
  2. --execute <冻结csv> 只消费显式传入的已评审冻结件（I1c），缺失即拒执行；
     不再消费 dry-run 本次重算的产物（覆写=审计证据丢失）。
  3. 备份批间补 \n（psql strip 尾换行 + 直写相接 = 记录熔接，第一轮 I-1 复发过）。
  4. 写入改 union 语义：old 有效条目 ∪ chosen，整体 SET replace 会丢前态真实多源
     （第一轮 C-1：41 页 58 条真实源被丢弃——与陷阱 25 同类）。
  5. ingest_jobs 按 project_id 过滤（M-1，latent 防御）。
  6. proposal 增列（I-4）：candidates 清单/runner-up/margin/created_at/ntok/四信号分项。

用法：
  python3 resolve-unresolved-window.py --dry-run          # 产 proposal-v4.csv（只读）
  python3 resolve-unresolved-window.py --execute <冻结csv> # 备份+union 写入已评审行
"""
import argparse, csv, json, subprocess, sys
from datetime import timedelta
from pathlib import Path

import importlib.util
_spec = importlib.util.spec_from_file_location(
    "recheck_window_attribution",
    Path(__file__).resolve().parent / "recheck-window-attribution.py")
_rwa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rwa)

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"
PROPOSAL = OUT / "proposal-v4.csv"

norm = _rwa.norm
latin_tokens = _rwa.latin_tokens
bigrams = _rwa.bigrams
page_terms = _rwa.page_terms

def psql(q):
    r = subprocess.run(_rwa.PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def load_jobs():
    return _rwa.load_jobs()

def window_candidates(created_at, parsed_jobs):
    return _rwa.window_candidates(created_at, parsed_jobs)

def dt(s):
    from datetime import datetime
    return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))

def score_page(pg, cands, cache):
    """CJK 感知评分（与 recheck-window-attribution 同一实现）。

    返回 [(file, s_line, s_tok, s_big, s_term)]，及 rank_key 函数。"""
    title, content = pg["title"] or "", pg["content"] or ""
    terms = page_terms(content, title)
    wsum = sum(terms.values()) or 1
    pbg = bigrams(content)
    toks = set(latin_tokens(content))
    ntok = len(toks)
    probes = sorted({norm(l) for l in content.split("\n") if len(norm(l)) >= 24},
                    key=len, reverse=True)[:12]
    probe_chars = sum(len(x) for x in probes) or 1
    scored = []
    for c in cands:
        if c not in cache:
            f = ROOT / c
            if not f.exists():
                cache[c] = None
            else:
                raw = f.read_text(encoding="utf-8", errors="replace")
                joined = "\n".join(norm(l) for l in raw.split("\n") if len(norm(l)) >= 24)
                cache[c] = (raw, joined, set(latin_tokens(raw)), bigrams(raw))
        st = cache[c]
        if not st:
            continue
        raw, joined, lat, bg = st
        import math
        s_line = sum(len(x) for x in probes if x in joined) / probe_chars
        s_tok = (len(toks & lat) / len(toks)) if toks else 0.0
        s_big = (len(pbg & bg) / len(pbg)) if pbg else 0.0
        num = sum(w * min(1 + math.log10(raw.count(t)), 3)
                  for t, w in terms.items() if raw.count(t))
        s_term = num / (wsum * 3)
        scored.append((c, round(s_line, 3), round(s_tok, 3), round(s_big, 3), round(s_term, 3)))
    cjk_page = len(pbg) >= 20
    cjk_best = max((max(x[3], x[4]) for x in scored), default=0.0)
    use_latin = cjk_page and cjk_best < 0.05
    def rank_key(x):
        if use_latin:
            return max(x[1], x[2]) if ntok >= 8 else 0.0
        return max(x[3], x[4]) if cjk_page else max(x[1], x[2])
    scored.sort(key=lambda x: -rank_key(x))
    return scored, rank_key, ntok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", metavar="冻结CSV",
                    help="只消费显式传入的已评审冻结件（I1c）；缺失即拒执行")
    args = ap.parse_args()
    if not args.dry_run and not args.execute:
        sys.exit("refusing: 必须显式 --dry-run 或 --execute <冻结csv>（默认 no-op 防误触）")

    if args.execute:
        frozen = Path(args.execute)
        if not frozen.exists():
            sys.exit(f"refusing: 冻结件不存在 {frozen}——先 dry-run 并完成人工评审，再以该文件路径执行")
        rows = [r for r in csv.DictReader(open(frozen))
                if r.get("class") in ("STRUCTURAL-SINGLE", "PROBE-RESOLVED") and r.get("chosen")]
        print(f"consumed frozen {frozen.name}: {len(rows)} rows")
        # ③ 备份（批间补 \n——I-1 熔接防线）
        with open(OUT / "window-backup.csv", "w") as f:
            for i in range(0, len(rows), 200):
                a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows[i:i+200])
                f.write(psql(f"COPY (SELECT path,title,page_type,frontmatter,sources,content FROM wiki_pages "
                             f"WHERE project_id=614 AND path IN ({a})) TO STDOUT WITH CSV"))
                f.write("\n")
        # ④ union 写入：从备份读前态，old 有效条目 ∪ chosen
        backup = list(csv.reader(open(OUT / "window-backup.csv", newline="")))
        assert all(len(r) == 6 for r in backup), "备份含非 6 列记录（熔接回归？）"
        old_map = {r[0]: json.loads(r[4]) for r in backup}
        done = 0
        for r in rows:
            old = old_map.get(r["path"])
            if old is None:
                print(f"skip(备份缺行): {r['path']}"); continue
            new = [e for e in old if e and e != "source.md"]
            if r["chosen"] not in new:
                new.append(r["chosen"])
            newj = json.dumps(new, ensure_ascii=False).replace("'", "''")
            q = (f"UPDATE wiki_pages SET sources='{newj}'::jsonb, "
                 f"frontmatter=jsonb_set("
                 f"CASE WHEN jsonb_typeof(coalesce(frontmatter,'{{}}'::jsonb))='object' "
                 f"THEN coalesce(frontmatter,'{{}}'::jsonb) ELSE '{{}}'::jsonb END, "
                 f"'{{sources}}','{newj}'::jsonb) "
                 f"WHERE project_id=614 AND path='{r['path'].replace(chr(39), chr(39)*2)}'")
            psql(q)
            done += 1
        print("executed(union):", done)
        return

    # —— dry-run：proposal-v4（CJK 感知 + 增列；不触碰 v3 冻结件）——
    jobs = load_jobs()
    pages = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, title, created_at::text ca, content "
        "FROM wiki_pages WHERE project_id=614 AND NOT path LIKE 'wiki/%' "
        "AND (sources IS NULL OR sources='[]'::jsonb OR sources::text LIKE '%\"source.md\"%')) t"))
    print("jobs:", len(jobs), "broken pages:", len(pages))
    cache = {}
    proposal = []
    stats = {"STRUCTURAL-SINGLE": 0, "PROBE-RESOLVED": 0, "WEAK": 0,
             "AMBIGUOUS": 0, "NO-WINDOW": 0}
    for pg in pages:
        t = dt(pg["ca"])
        cands = window_candidates(t, jobs)
        row = {"path": pg["path"], "class": "NO-WINDOW", "candidates": 0, "candidates_list": "",
               "chosen": "", "score": "", "runner_up": "", "runner_score": "", "margin": "",
               "ntok": "", "s_line": "", "s_tok": "", "s_big": "", "s_term": "",
               "verdict": "", "created_at": pg["ca"], "window_jobs": ""}
        if not cands:
            stats["NO-WINDOW"] += 1
            proposal.append(row)
            continue
        scored, rank_key, ntok = score_page(pg, cands, cache)
        row.update({"candidates": len(cands), "candidates_list": ";".join(cands), "ntok": ntok,
                    "created_at": pg["ca"]})
        if len(cands) == 1 and scored:
            cls, chosen, sc = "STRUCTURAL-SINGLE", scored[0][0], rank_key(scored[0])
        elif scored and rank_key(scored[0]) >= 0.3 and (len(scored) == 1 or
                rank_key(scored[0]) - rank_key(scored[1]) >= 0.1):
            cls, chosen, sc = "PROBE-RESOLVED", scored[0][0], rank_key(scored[0])
        elif scored and rank_key(scored[0]) >= 0.3:
            cls, chosen, sc = "AMBIGUOUS", scored[0][0], rank_key(scored[0])
        else:
            cls, chosen, sc = "WEAK", (scored[0][0] if scored else ""), (rank_key(scored[0]) if scored else 0)
        stats[cls] += 1
        runner = scored[1] if len(scored) > 1 else None
        row.update({"class": cls, "chosen": chosen, "score": round(sc, 3),
                    "runner_up": runner[0] if runner else "",
                    "runner_score": round(rank_key(runner), 3) if runner else "",
                    "margin": round(sc - (rank_key(runner) if runner else 0), 3),
                    "s_line": scored[0][1] if scored else "", "s_tok": scored[0][2] if scored else "",
                    "s_big": scored[0][3] if scored else "", "s_term": scored[0][4] if scored else "",
                    "verdict": cls})
        proposal.append(row)
    with open(PROPOSAL, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(proposal[0].keys()))
        w.writeheader()
        w.writerows(proposal)
    print("stats:", stats, "| proposal-v4.csv 落", OUT)

if __name__ == "__main__":
    main()

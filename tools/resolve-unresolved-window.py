#!/usr/bin/env python3
"""resolve-unresolved-window.py — 未决坏值页的出生窗口约束解析（v2）。

归因原理：坏值页出生于某个 ingest job 的处理过程，该 job 的 source_paths 就是
其真实来源的候选集（结构性证据，强于全局内容匹配）。
  窗口 = [job.created_at-60s, COALESCE(finished_at, created_at+40min)] 覆盖页 created_at。

v2（2026-09-11 补修评审 §四 后重写，§五 I-2 再收敛）：
  1. 评分器复用 tools/recheck-window-attribution.py 的单一副本（score_page/
     load_jobs/window_candidates/有名常量经 importlib 共享）——公式与门限不二写，
     防止「已发生过一次评分器整体更换」的迭代节奏下两份实现分叉。
  2. --execute <冻结csv> 只消费显式传入的已评审冻结件（I1c），缺失即拒执行。
  3. 备份批间补 \n + 读回六列断言（I-1 熔接双防线）。
  4. 写入 union 语义：old 有效条目 ∪ chosen（§四 C-1：整体 SET 丢前态真实多源）；
     old 非列表形态（jsonb 标量）isinstance 守卫——逐字符迭代是真实损坏路径（§5.2 M-1）。
  5. proposal 增列（I-4）：candidates 清单/runner-up/margin/created_at/ntok/四信号分项；
     window_jobs 回填（§5.2：v4 全空已修）。WEAK 类 chosen 置空（零分排序无意义，
     字母序是噪声）。

用法：
  python3 resolve-unresolved-window.py --dry-run          # 产 proposal-v4.csv（只读）
  python3 resolve-unresolved-window.py --execute <冻结csv> # 备份+union 写入已评审行
"""
import argparse, csv, json, subprocess, sys
from pathlib import Path

import importlib.util
_spec = importlib.util.spec_from_file_location(
    "recheck_window_attribution",
    Path(__file__).resolve().parent / "recheck-window-attribution.py")
_rwa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rwa)

ROOT = _rwa.ROOT
OUT = _rwa.OUT
PROPOSAL = OUT / "proposal-v4.csv"

def psql(q):
    r = subprocess.run(_rwa.PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def dt(s):
    from datetime import datetime
    return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))

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
        old_map = {}
        for r in backup:
            try:
                old = json.loads(r[4])
            except Exception:
                old = None
            # M-1（§5.2）：jsonb 标量/畸形形态下 iter(str) 是逐字符迭代=真实
            # 损坏路径；非列表一律视同空态（union 只加 chosen）
            old_map[r[0]] = old if isinstance(old, list) else []
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

    # —— dry-run：proposal-v4（评分器复用单一副本；不触碰 v3 冻结件）——
    jobs = _rwa.load_jobs()
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
        cands, wjobs = _rwa.window_candidates(t, jobs)
        row = {"path": pg["path"], "class": "NO-WINDOW", "candidates": 0, "candidates_list": "",
               "chosen": "", "score": "", "runner_up": "", "runner_score": "", "margin": "",
               "ntok": "", "s_line": "", "s_tok": "", "s_big": "", "s_term": "",
               "verdict": "", "created_at": pg["ca"], "window_jobs": wjobs}
        if not cands:
            stats["NO-WINDOW"] += 1
            proposal.append(row)
            continue
        sc = _rwa.score_page(pg["content"], pg["title"], cands, cache)
        scored, rank_key, ntok = sc["scored"], sc["rank_key"], sc["ntok"]
        row.update({"candidates": len(cands), "candidates_list": ";".join(cands), "ntok": ntok,
                    "created_at": pg["ca"]})
        if len(cands) == 1 and scored:
            cls, chosen, sc_val = "STRUCTURAL-SINGLE", scored[0][0], rank_key(scored[0])
        elif scored and rank_key(scored[0]) >= _rwa.ATTR_FLOOR and (len(scored) == 1 or
                rank_key(scored[0]) - rank_key(scored[1]) >= _rwa.ATTR_MARGIN):
            cls, chosen, sc_val = "PROBE-RESOLVED", scored[0][0], rank_key(scored[0])
        elif scored and rank_key(scored[0]) >= _rwa.ATTR_FLOOR:
            cls, chosen, sc_val = "AMBIGUOUS", scored[0][0], rank_key(scored[0])
        else:
            # WEAK：全候选低于判定线——chosen 置空（零分排序无意义，字母序是噪声；
            # §5.2 Minor）。class 保留供人看 runner-up 诊断列。
            cls, chosen, sc_val = "WEAK", "", (rank_key(scored[0]) if scored else 0)
        stats[cls] += 1
        runner = scored[1] if len(scored) > 1 else None
        row.update({"class": cls, "chosen": chosen, "score": round(sc_val, 3),
                    "runner_up": runner[0] if runner else "",
                    "runner_score": round(rank_key(runner), 3) if runner else "",
                    "margin": round(sc_val - (rank_key(runner) if runner else 0), 3),
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

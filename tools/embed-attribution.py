#!/usr/bin/env python3
"""embed-attribution.py — 未决页归因的 embedding 抓手（第三轮执行器）。

原理：页向量已在 embeddings 表（bge-m3 1024 维）；候选源文件无向量——现算。
sim(page,file) = max(页 chunk × 文件 chunk) 余弦（max-pooling 对归因最稳）。
分块对齐服务端默认（chunk_size=384 / overlap=64）；每文件均匀采样 ≤40 块
（归因要覆盖度不要穷举）。文件向量落磁盘缓存（JSONL），中断续跑。

密钥：运行时从 launchd plist 读 EMBEDDING__API_KEY（继承 src-server 落点），
不落盘、不打印。

用法：
  python3 embed-attribution.py --prepare   # 候选文件+标定文件现算向量入缓存
  python3 embed-attribution.py --score     # 页×候选 cosine 排序 + 标定表
  python3 embed-attribution.py --recheck-weak  # §五 I-1：NEAR-TIE 53 页（已写库
                               # 弱证据滞留）embedding 复裁决 -> embed-neartie.csv
输出：embed-proposal.csv / embed-neartie.csv / embed-calibration.csv
      （均在 ~/kb-dumps/20260911-sources-backfill/）
"""
import argparse, csv, json, math, subprocess, sys, time
from pathlib import Path

import numpy as np

HOME = Path.home()
OUT = HOME / "kb-dumps/20260911-sources-backfill"
CACHE = OUT / "embed-file-cache.jsonl"
ROOT = HOME / "kb-storage/teams/916/projects/614"
PLIST = HOME / "Library/LaunchAgents/wiki.src-server.plist"
BASE_URL = "http://localhost:8001/v1/embeddings"
MODEL = "bge-m3-mlx-fp16"
CHUNK, OVERLAP, MAX_CHUNKS, BATCH = 384, 64, 40, 32
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def embed_key():
    import plistlib
    p = plistlib.load(open(PLIST, "rb"))
    key = (p.get("EnvironmentVariables") or {}).get("EMBEDDING__API_KEY", "")
    if not key:
        sys.exit("EMBEDDING__API_KEY 未在 plist 找到")
    return key

def embed_batch(texts, key, tries=3):
    import urllib.request
    body = json.dumps({"model": MODEL, "input": texts}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE_URL, data=body,
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": f"Bearer {key}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)["data"]
            return [d["embedding"] for d in sorted(data, key=lambda x: x["index"])]
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))

def chunks_of(text):
    step = CHUNK - OVERLAP
    raw = [text[i:i + CHUNK] for i in range(0, max(len(text), 1), step)]
    raw = [c for c in raw if len(c.strip()) >= 20] or [text[:CHUNK]]
    if len(raw) > MAX_CHUNKS:
        idx = np.linspace(0, len(raw) - 1, MAX_CHUNKS).round().astype(int)
        raw = [raw[i] for i in dict.fromkeys(idx)]
    return raw

def load_cache():
    cache = {}
    if CACHE.exists():
        for line in open(CACHE):
            line = line.strip()
            if line:
                o = json.loads(line)
                cache[o["rel"]] = o["vecs"]
    return cache

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prepare", action="store_true")
    ap.add_argument("--score", action="store_true")
    ap.add_argument("--recheck-weak", action="store_true",
                    help="§五 I-1：对 recheck NEAR-TIE 桶（已写库弱证据页）做 embedding 复裁决")
    args = ap.parse_args()
    if not args.prepare and not args.score and not args.recheck_weak:
        sys.exit("refusing: 需显式 --prepare / --score / --recheck-weak")

    def dt(s):
        from datetime import datetime
        return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))

    broken = {r["path"] for r in json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path FROM wiki_pages "
        "WHERE project_id=614 AND NOT path LIKE 'wiki/%' "
        "AND (sources IS NULL OR sources='[]'::jsonb OR sources::text LIKE '%\"source.md\"%')) t"))}
    if args.recheck_weak:
        # §五 I-1：NEAR-TIE 桶=已写库的弱证据滞留种群，embedding 复裁决
        targets = {r["path"]: r for r in csv.DictReader(open(OUT / "recheck-executed.csv"))
                   if r["verdict"] == "NEAR-TIE"}
        import importlib.util
        _spec = importlib.util.spec_from_file_location(
            "rwa", Path(__file__).resolve().parent / "recheck-window-attribution.py")
        _rwa = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_rwa)
        jobs = _rwa.load_jobs()
        cand_of = {}
        for p in targets:
            ca = psql("SELECT created_at::text FROM wiki_pages WHERE project_id=614 "
                      "AND path='%s'" % p.replace("'", "''"))
            cands, _ = _rwa.window_candidates(dt(ca), jobs)
            cand_of[p] = cands
    else:
        v4 = {r["path"]: r for r in csv.DictReader(open(OUT / "proposal-v4.csv"))
              if r["class"] in ("PROBE-RESOLVED", "WEAK", "AMBIGUOUS")}
        targets = {p: r for p, r in v4.items() if p in broken and r["candidates_list"]}
        cand_of = {p: [x for x in r["candidates_list"].split(";") if x] for p, r in targets.items()}
    print(f"targets: {len(targets)} (broken={len(broken)})")

    # 标定文件：历史改正批的 add/remove + 信任 chosen（执行 429 未被改正者）
    calib_files = set()
    pairs = []  # (path, rel, label)  label: true/wrong
    for bak, addcol_note in (("c2-attribution-fixes-before.csv", "c2"), ("specialist-fixes-before.csv", "sp")):
        # 改正前备份的第 5 列 sources=含 wrong chosen 的前态；add 从本轮报告不重算——
        # 直接用「改正后现值 ∩ 候选/盘上」当 true，改正前唯一主源当 wrong
        before = {r[0]: json.loads(r[4]) for r in csv.reader(open(OUT / bak, newline="")) if len(r) == 6}
        now = {r["path"]: r["sources"] for r in json.loads(psql(
            "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, sources FROM wiki_pages "
            "WHERE project_id=614 AND path IN (%s)) t" % ",".join("'%s'" % p.replace("'", "''") for p in before)))}
        for p, old in before.items():
            new = now.get(p) or []
            added = [e for e in new if e not in old and (e.startswith("sources/") or e.startswith("raw/"))]
            removed = [e for e in old if e not in new and (e.startswith("sources/") or e.startswith("raw/"))]
            for e in added:
                pairs.append((p, e, "true")); calib_files.add(e)
            for e in removed:
                pairs.append((p, e, "wrong")); calib_files.add(e)

    files = set(calib_files)
    for p, cl in cand_of.items():
        files.update(cl)
    files = {f for f in files if (ROOT / f).exists()}
    print("files to embed:", len(files))

    cache = load_cache()
    todo = sorted(f for f in files if f not in cache)
    print("cached:", len(files) - len(todo), "to embed:", len(todo))
    if args.prepare:
        key = embed_key()
        with open(CACHE, "a") as cf:
            done = 0
            for rel in todo:
                text = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
                cs = chunks_of(text)
                vecs = []
                for i in range(0, len(cs), BATCH):
                    vecs.extend(embed_batch(cs[i:i + BATCH], key))
                cache[rel] = vecs
                cf.write(json.dumps({"rel": rel, "vecs": vecs}) + "\n")
                done += 1
                if done % 50 == 0:
                    print(f"  {done}/{len(todo)} files")
        print("prepare done")

    if not args.score and not args.recheck_weak:
        return

    # 页向量
    pages = sorted(targets)
    pagevecs = {}
    for i in range(0, len(pages), 100):
        a = ",".join("'%s'" % p.replace("'", "''") for p in pages[i:i+100])
        for r in json.loads(psql(
                "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT wiki_page_id p, content::text v "
                f"FROM embeddings WHERE project_id=614 AND wiki_page_id IN ({a})) t")):
            pagevecs.setdefault(r["p"], []).append(np.array(json.loads(r["v"]), dtype=np.float32))
    print("pages with vectors:", len(pagevecs))

    def mat(rel):
        v = cache.get(rel)
        if not v:
            return None
        m = np.array(v, dtype=np.float32)
        return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)

    rows, cal = [], []
    for p in pages:
        pv = pagevecs.get(p)
        if not pv:
            continue
        P = np.vstack(pv)
        P /= (np.linalg.norm(P, axis=1, keepdims=True) + 1e-9)
        sims = {}
        for rel in cand_of.get(p, []):
            M = mat(rel)
            if M is not None:
                sims[rel] = float((P @ M.T).max())
        if not sims:
            continue
        rank = sorted(sims.items(), key=lambda x: -x[1])
        top, r2 = rank[0], (rank[1] if len(rank) > 1 else (None, 0.0))
        trow = targets[p]
        if args.recheck_weak:
            # NEAR-TIE 复裁决：chosen=当前写库值；SWAP 门与主轮同（margin≥0.10 & sim≥0.70）
            rows.append({"path": p, "title": trow.get("title", ""), "chosen": trow["chosen"],
                         "chosen_comb": trow["chosen_comb"],
                         "embed_rank1": top[0], "embed_sim": round(top[1], 4),
                         "runner": r2[0] or "", "runner_sim": round(r2[1], 4),
                         "margin": round(top[1] - r2[1], 4),
                         "verdict": ("KEEP-EMBED" if top[0] == trow["chosen"]
                                     else ("SWAP-PROPOSE" if top[1] >= 0.70 and top[1] - r2[1] >= 0.10
                                           else "STILL-TIED"))})
            continue
        rows.append({"path": p, "class": trow["class"], "v4_chosen": trow["chosen"],
                     "v4_score": trow["score"],
                     "embed_rank1": top[0], "embed_sim": round(top[1], 4),
                     "embed_sim3": round(float(np.mean(sorted(sims.values(), reverse=True)[:3])), 4),
                     "runner": r2[0] or "", "runner_sim": round(r2[1], 4),
                     "margin": round(top[1] - r2[1], 4), "agree_v4": int(top[0] == trow["chosen"])})
    fout = OUT / ("embed-neartie.csv" if args.recheck_weak else "embed-proposal.csv")
    with open(fout, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    if args.recheck_weak:
        from collections import Counter
        print("verdicts:", dict(Counter(r["verdict"] for r in rows)))
        print("->", fout)
        return

    # 标定表
    for p, rel, label in pairs:
        pv = pagevecs.get(p)
        if not pv:
            # 标定页不在 targets（已修复非坏值）——按需拉向量
            v = json.loads(psql("SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT content::text v "
                                "FROM embeddings WHERE project_id=614 AND wiki_page_id='%s') t" % p.replace("'", "''")))
            pv = [np.array(json.loads(x["v"]), dtype=np.float32) for x in v]
            if pv:
                pagevecs[p] = pv
        if not pv:
            continue
        P = np.vstack(pv)
        P /= (np.linalg.norm(P, axis=1, keepdims=True) + 1e-9)
        M = mat(rel)
        if M is None:
            continue
        cal.append({"path": p, "label": label, "file": rel,
                    "sim": round(float((P @ M.T).max()), 4)})
    with open(OUT / "embed-calibration.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "label", "file", "sim"])
        w.writeheader()
        w.writerows(cal)
    if cal:
        tr = [c["sim"] for c in cal if c["label"] == "true"]
        wr = [c["sim"] for c in cal if c["label"] == "wrong"]
        print(f"calibration: true n={len(tr)} mean={np.mean(tr):.3f} p10={np.percentile(tr,10):.3f}" if tr else "calibration: no true")
        print(f"             wrong n={len(wr)} mean={np.mean(wr):.3f} p90={np.percentile(wr,90):.3f}" if wr else "             no wrong")
    print(f"embed-proposal.csv: {len(rows)} rows | calibration: {len(cal)} pairs")

if __name__ == "__main__":
    main()

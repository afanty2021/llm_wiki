#!/usr/bin/env python3
# tools/touch-guard.py — 触达守卫通用化（触达误报三连复发的根修：P0「37 计划外」/Tier-1 首版 37/孪生轮 17）
# 从战役工件自动构造预期触达集，对锚点差集做归因——杜绝逐轮手搓漏面的整类错误。
# 预期触达集 = merge keeps ∪ 改写幸存页（由 pre 内容 loser 形链接现场推导，含同形守卫语义：
#   同形链接不产生 PUT） ∪ p15 apply items ∪ p15/tier2 参见页 ∪ tier2 appends ∪ 归一页账。
# 用法：python3 tools/touch-guard.py --prerun <~/kb-dumps/xx-prerun 目录>
import argparse, csv, json, os, sys, importlib.util
from collections import defaultdict

csv.field_size_limit(32 * 1024 * 1024)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("rla", os.path.join(HERE, "redlink-audit.py"))
rla = importlib.util.module_from_spec(spec); spec.loader.exec_module(rla)


def load_rows(path):
    rows = []
    with open(path, newline="") as f:
        for r in csv.reader(f):
            rows.append({"path": r[0], "title": r[1], "updated_at": r[4], "content": r[3]})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prerun", required=True, help="含 merge-plan.json/pages-pre.csv/baseline.json 的前像目录")
    ap.add_argument("--campaign", default=os.path.normpath(os.path.join(HERE, "..", ".superpowers",
                                                                       "concept-merge-cleanup")))
    ap.add_argument("--post", help="post dump CSV（缺省 /tmp/.curate_pages_dump.csv，需先 fresh_dump）")
    args = ap.parse_args()
    D = args.prerun
    base = json.load(open(os.path.join(D, "baseline.json")))
    anchor = base["anchor_max_updated_at"]
    pre_rows = load_rows(os.path.join(D, "pages-pre.csv"))
    pre_ua = {p["path"]: p["updated_at"] for p in pre_rows}

    expected = set()
    breakdown = {}
    # 1) merge 组：keeps + 改写幸存页（镜像 wiki-cleanup repl 的同形守卫语义——
    #    token=keep 的裸 stem（cmd_merge keep_token），文本==token 不产生 PUT）
    fp = os.path.join(D, "merge-plan.json")
    rewrite_surv = set()
    if os.path.exists(fp):
        plan = json.load(open(fp))
        losers = {lp for g in plan["groups"] for lp in g["losers"]}
        keeps = {g["keep_path"] for g in plan["groups"]}
        expected |= keeps
        breakdown["merge_keeps"] = len(keeps)
        forms = {}
        pre = {p["path"]: p for p in pre_rows}
        from collections import Counter
        surv = [p for p in pre_rows if p["path"] not in losers]
        stem_count = Counter(rla.norm_server(rla.stem_of(p["path"])) for p in surv)
        keep_token = {}
        for kp in keeps:
            if kp not in pre:
                continue
            s = rla.norm_server(rla.stem_of(kp))
            t = (pre[kp]["title"] or "").strip()
            titled = {rla.norm_server(q["title"] or "") for q in surv if (q["title"] or "").strip()}
            keep_token[kp] = t if (stem_count.get(s, 0) > 1 and t and rla.norm_server(t) in titled) \
                else rla.stem_of(kp)
        for g in plan["groups"]:
            for lp in g["losers"]:
                tok = keep_token.get(g["keep_path"], rla.stem_of(g["keep_path"]))
                forms[rla.norm_server(rla.stem_of(lp))] = tok
                lt = (pre.get(lp, {}).get("title") or "").strip()
                if lt:
                    forms[rla.norm_server(lt)] = tok
        for p in pre_rows:
            if p["path"] in losers:
                continue
            hit = False
            for m in rla.RE_SERVER.finditer(p["content"]):
                k = rla.norm_server(m.group(1))
                if k in forms and forms[k] != m.group(1).strip():
                    hit = True  # 同形守卫：文本==token 不产生 PUT
                    break
            if hit:
                rewrite_surv.add(p["path"])
        expected |= rewrite_surv
        breakdown["rewrite_survivors"] = len(rewrite_surv)
    # 2) p15 apply items
    fp = os.path.join(args.campaign, "p15-apply-plan.json")
    if os.path.exists(fp):
        s = {i["path"] for i in json.load(open(fp))["items"]}
        expected |= s; breakdown["p15_items"] = len(s)
        s2 = {x["path"] for x in json.load(open(fp)).get("seealso", [])}
        expected |= s2; breakdown["p15_seealso"] = len(s2)
    # 3) tier2 appends
    fp = os.path.join(args.campaign, "tier2-seealso-plan.json")
    if os.path.exists(fp):
        s = {i["path"] for i in json.load(open(fp))["appends"]}
        expected |= s; breakdown["tier2_appends"] = len(s)
    # 4) 归一页账（twins/s5t1/s5 各代）
    for name in ("twins-type-normalization.json", "s5t1-type-normalization.json", "s5-type-normalization.json"):
        fp = os.path.join(args.campaign, name)
        if os.path.exists(fp):
            s = {x["path"] for x in json.load(open(fp))["pages"]}
            expected |= s; breakdown[f"normalize:{name.split('-')[0]}"] = len(s - expected)

    post_path = args.post or "/tmp/.curate_pages_dump.csv"
    post_ua = {r[0]: r[4] for r in csv.reader(open(post_path))}
    changed = {p for p, ua in post_ua.items() if ua > anchor and p in pre_ua}
    added = sorted(set(post_ua) - set(pre_ua))
    deleted = sorted(set(pre_ua) - set(post_ua))
    outside = sorted(changed - expected)
    report = {"anchor": anchor, "expected_pool": len(expected), "breakdown": breakdown,
              "changed": len(changed), "outside_count": len(outside), "outside": outside,
              "added_pages": added, "deleted_pages": deleted,
              "note": "outside=0 即守卫通过；非零页须逐页归因（并发会话/未入册工件）后方可收账"}
    out = os.path.join(args.campaign, "touch-guard-report.json")
    json.dump(report, open(out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "outside"}, ensure_ascii=False, indent=1))
    if outside:
        print("outside 页：", outside[:10])
    print(f"touch-guard: {'PASS ✓' if not outside else 'FAIL ✗'} -> {out}")
    sys.exit(0 if not outside else 1)


if __name__ == "__main__":
    main()

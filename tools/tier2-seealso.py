#!/usr/bin/env python3
# tools/tier2-seealso.py — Tier-2 See-Also 批：同基名异题对互加「## 参见」条目（charter §五 Tier-2 政策落地）
# 写入方为本批新建（charter §2.3：Tier-2 See-Also 无写入方）。纪律：plan 只读干跑；apply 需 --execute；
# 写侧全走 wiki-cleanup.put_page 统一出口（E2 全量 fm 补全）；写前备份沿用 backup()。
# 幂等：一侧已链接另一侧（norm 命中任一链接）即跳过；重跑 0 变更。
# 用法：
#   python3 tools/tier2-seealso.py plan     # 校验 108 对 + 生成追加计划（只读）
#   python3 tools/tier2-seealso.py apply --execute
import json, os, sys, time, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)
rla = wc.rla

F_PAIRS = os.path.join(OUT := os.path.normpath(os.path.join(HERE, "..", ".superpowers",
                                                            "concept-merge-cleanup")), "s2-tier2-seealso.json")
F_PLAN = os.path.join(OUT, "tier2-seealso-plan.json")
NOTE = "同基名异题页"


def load_fresh():
    wc.fresh_dump()
    return {p["path"]: p for p in wc.load_pages()}


def plan():
    pairs = json.load(open(F_PAIRS))["pairs"]
    pages = load_fresh()
    plans, skips = [], []
    for pr in pairs:
        c, e = pr["concept"]["path"], pr["entity"]["path"]
        if c not in pages or e not in pages:
            skips.append({"pair": pr["stem"], "reason": "页不存在（Tier-1 已删或漂移）", "paths": [c, e]})
            continue
        tc = (pages[c]["title"] or "").strip().lower()
        te = (pages[e]["title"] or "").strip().lower()
        if tc and te and tc == te:
            skips.append({"pair": pr["stem"], "reason": "title 已全同（应走合并甄别，不入 See-Also）", "paths": [c, e]})
            continue
        for a, b in ((c, e), (e, c)):
            linked = any(rla.norm_server(x) == rla.norm_server(rla.stem_of(b))
                         for x in rla.extract_links_server(pages[a]["content"]))
            if linked:
                continue  # 幂等：已链接
            other_title = (pages[b]["title"] or "").strip() or rla.stem_of(b)
            bullet = f"- [[{rla.stem_of(b)}|{other_title}]]：{NOTE}"
            content = pages[a]["content"]
            if "## 参见" in content:
                head = content.index("## 参见")
                seg = content[head:]
                lines = seg.split("\n")
                last = 0
                for i, ln in enumerate(lines):
                    if ln.lstrip().startswith("- "):
                        last = i
                if last:
                    new_seg = "\n".join(lines[:last + 1] + [bullet] + lines[last + 1:])
                    new_content = content[:head] + new_seg
                else:  # 参见标题下无条目：标题行后插
                    ins = head + len(lines[0]) + 1
                    new_content = content[:ins] + bullet + "\n" + content[ins:]
            else:
                base = content.rstrip("\n")
                new_content = base + "\n\n## 参见\n\n" + bullet + "\n"
            plans.append({"pair": pr["stem"], "path": a, "link_to": b,
                          "bullet": bullet, "chars_before": len(content), "chars_after": len(new_content),
                          "content": new_content})
    json.dump({"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "pairs_in": len(pairs),
               "appends": [{k: v for k, v in p.items() if k != "content"} for p in plans],
               "skips": skips}, open(F_PLAN, "w"), ensure_ascii=False, indent=1)
    print(f"输入对 {len(pairs)}：计划追加 {len(plans)} 条（{len(set(p['pair'] for p in plans))} 对），跳过 {len(skips)}")
    for s in skips:
        print(f"  [SKIP] {s['pair']}: {s['reason']}")
    print(f"plan -> {F_PLAN}（apply 需 --execute）")
    return plans


def apply(execute):
    plans = plan()
    if not execute:
        print("DRY-RUN：未写库")
        return
    token = wc.login_default()
    done = fail = 0
    for p in plans:
        try:
            wc.put_page(token, p["path"], p["content"], None)  # fm=None → GET 现值，E2 出口补全
            done += 1
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {p['path']}: {e}")
    print(f"Tier-2 See-Also 完成：追加 {done} 页（{fail} 失败；失败页可重跑补齐）")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan")
    a = sub.add_parser("apply")
    a.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    {"plan": lambda: plan(), "apply": lambda: apply(args.execute)}[args.cmd]()


if __name__ == "__main__":
    main()

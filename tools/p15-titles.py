#!/usr/bin/env python3
# tools/p15-titles.py — P1.5 空 title 页定题批（charter §二 D）：机械提案 + 碰撞门 + 人工门后应用
# 提案规则（零 LLM）：①正文 fm 块含 title（含缺开头 --- 的畸形块）→ 用之并按需修块；
#   ②正文首个 H1 → 用之；③（预留）LLM。碰撞门：提案 lower+trim 撞任何现有 title 键（含跨 ns 孪生）
#   → flag COLLISION 需人工；提案间互撞 → flag。
# 纪律：propose 只读；apply 按人审定稿 apply-plan.json 执行，写侧走 put_page 统一出口（E2 补全）。
# 用法：
#   python3 tools/p15-titles.py propose
#   python3 tools/p15-titles.py apply --plan .superpowers/concept-merge-cleanup/p15-apply-plan.json --execute
import json, os, re, sys, time, importlib.util, urllib.parse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)
rla = wc.rla

OUT = os.path.normpath(os.path.join(HERE, "..", ".superpowers", "concept-merge-cleanup"))
F_PROPOSALS = os.path.join(OUT, "p15-proposals.json")
F_TABLE = os.path.join(OUT, "p15-judgment-table.md")

FM_RE = re.compile(r"\A(?!---)(title:\s*[^\n]*\n(?:[a-z_]+:[^\n]*\n)*)---\n")  # 缺开头 --- 的畸形块


def parse_content_fm(content):
    """正文内嵌 fm（含缺开头 --- 畸形）：返回 (title or None, malformed: bool)"""
    m = FM_RE.match(content)
    if m:
        t = re.search(r"title:\s*(.+)", m.group(1))
        return (t.group(1).strip().strip('"') if t else None), True
    if content.startswith("---\n"):
        m2 = re.match(r"\A---\n(.*?)\n---\n", content, re.S)
        if m2:
            t = re.search(r"^title:\s*(.+)$", m2.group(1), re.M)
            return (t.group(1).strip().strip('"') if t else None), False
    return None, False


def h1_of(content):
    m = re.search(r"^#\s+(\S.+)$", content, re.M)
    return m.group(1).strip() if m else None


def propose():
    wc.fresh_dump()
    rows = wc.load_pages()
    pages = {p["path"]: p for p in rows}
    existing = {}
    for p in rows:
        t = (p["title"] or "").strip().lower()
        if t:
            existing[t] = existing.get(t, 0) + 1
    empty = [p for p in rows if not (p["title"] or "").strip() and not p["path"].startswith("query")]
    props = []
    for p in empty:
        cfm, malformed = parse_content_fm(p["content"])
        h1 = h1_of(p["content"])
        content = p["content"]
        if content.startswith("---\n") and content.count("---") == 1:
            # 摄入截断残骸：fm 块无收尾 ---，sources 值未闭合，正文全无——不入定题批，
            # 另案（按 sources 前缀重建或删除）；title 仍可读出供参考
            t = re.search(r"^title:\s*(.+)$", content, re.M)
            props.append({"path": p["path"], "proposed": t.group(1).strip() if t else None,
                          "source": "truncated-fm（摄入截断残骸：重建或删除，另案）",
                          "key": "", "collision_with_existing": False,
                          "content_chars": len(p["content"]), "fm_malformed": True,
                          "decision": "另案"})
            continue
        if cfm:
            title, src = cfm, "content-fm" + ("（畸形块，apply 时顺修 ---）" if malformed else "")
        elif h1:
            title, src = h1, "h1"
        else:
            title, src = None, "llm"
        key = (title or "").strip().lower()
        collision = bool(key) and key in existing
        props.append({"path": p["path"], "proposed": title, "source": src,
                      "key": key, "collision_with_existing": collision,
                      "content_chars": len(p["content"]), "fm_malformed": malformed,
                      "decision": "待审"})
    # 提案间互撞
    cnt = Counter(x["key"] for x in props if x["key"])
    for x in props:
        if x["key"] and cnt[x["key"]] > 1:
            x["collision_with_existing"] = True
            x["source"] += "（提案间互撞）"
    json.dump({"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "empty_total": len(empty),
               "proposals": props}, open(F_PROPOSALS, "w"), ensure_ascii=False, indent=1)
    L = [f"# P1.5 空页定题判定表（{time.strftime('%Y-%m-%dT%H:%M:%S')}）\n",
         f"空 title {len(empty)} 页；提案来源：content-fm {sum(1 for x in props if x['source'].startswith('content-fm'))} / "
         f"h1 {sum(1 for x in props if x['source']=='h1')} / LLM {sum(1 for x in props if x['source']=='llm')}。"
         f"碰撞门（撞现有 title 键或提案互撞） flagged 页须人工改题。\n"]
    for x in props:
        flag = "⚠碰撞" if x["collision_with_existing"] else "OK"
        L.append(f"- `{x['path']}` → 「{x['proposed']}」（{x['source']}） [{flag}]")
    open(F_TABLE, "w").write("\n".join(L))
    n_coll = sum(1 for x in props if x["collision_with_existing"])
    print(f"空 title {len(empty)} 页：提案 {sum(1 for x in props if x['proposed'])}，无解 {sum(1 for x in props if not x['proposed'])}，"
          f"碰撞门 flagged {n_coll}")
    for x in props:
        if x["collision_with_existing"]:
            print(f"  [碰撞] {x['path']} → 「{x['proposed']}」")
    print(f"proposals -> {F_PROPOSALS}\n判定表 -> {F_TABLE}")
    return props


def apply(args):
    plan = json.load(open(args.plan))
    token = wc.login_default()
    done = fail = 0
    for item in plan["items"]:
        path, title = item["path"], item["title"]
        try:
            q = f"/page?path={urllib.parse.quote(path, safe='')}"
            st, cur = wc.api(token, "GET", q)
            assert st == 200, (path, st)
            fm = cur.get("frontmatter") or {}
            if isinstance(fm, str):
                fm = json.loads(fm) if fm else {}
            fm["title"] = title
            content = cur["content"]
            if item.get("fix_fm_block"):
                content = "---\n" + content if not content.startswith("---") else content
            wc.put_page(token, path, content, fm, skip_if_same=False)  # 内容多半未变，fm 变更强制写
            done += 1
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {path}: {e}")
    print(f"P1.5 定题完成：{done} 页（{fail} 失败）")


def main():
    import argparse
    import urllib.parse
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("propose")
    a = sub.add_parser("apply")
    a.add_argument("--plan", required=True)
    a.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    if args.cmd == "propose":
        propose()
    else:
        if not args.execute:
            print("DRY-RUN：加 --execute 才写")
            return
        apply(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# tools/adjudicate-merge.py — 概念合并清理专项：LLM 逐对语义甄别（charter r2.1 工具面三修版，2026-09-12）
# S1 候选网：entities/concepts 双命名空间内同 title（lower+trim）分组、类型无关——
#   旧版按 page_type=='entity' 过筛只过 19/26 组（评审 §三.1 实锺），废弃。
# prompt 双面（§三.2）：entities 组沿用「同一现实世界实体」判据；concepts 组用「同一知识主题」。
# 产物落 .superpowers/concept-merge-cleanup/（§三.3 禁 /tmp；psql 导出 CSV 仅为可再生缓存）：
#   s1-census.json / s1-results.json / s1-run-meta.json / s1-judgment-table.md /
#   s1-pages/*.md / s1-merge-plan*.json
# plan-builder（§三.2 桥）：plan 子命令把平铺 results（可加人工覆写 overrides.json）转成
#   {"groups":[{key,keep_path,losers}]}，供 wiki-cleanup.py merge --plan 消费（S4 干跑输入）。
# S2（P1 Tier-1）：s2-census/s2-judge/s2-plan 三子命令——B 口径=slug 同基名严格 1:1（大小写敏感）
#   × title 全同（lower+trim）=Tier-1；其余=Tier-2 See-Also 清单（落地另批）。全对 same_topic
#   prompt、keep=富侧、UbD 置顶（G11 自愈门）、overrides 走 overrides-s2.json。
# 本脚本只读库 + 调 LLM + 写产物目录，不写库。LLM 预算 ≤2 调用/对、90s 超时（§六）。
import argparse, json, os, re, sys, time, importlib.util, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)
rla = wc.rla

API = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
MODEL = "glm-5.3-flash"
TRUNC = 1600
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", ".superpowers", "concept-merge-cleanup"))
PAGES_DIR = os.path.join(OUT_DIR, "s1-pages")
F_RESULTS = os.path.join(OUT_DIR, "s1-results.json")
F_CENSUS = os.path.join(OUT_DIR, "s1-census.json")
F_TABLE = os.path.join(OUT_DIR, "s1-judgment-table.md")
F_PLAN_TENT = os.path.join(OUT_DIR, "s1-merge-plan-tentative.json")
F_PLAN = os.path.join(OUT_DIR, "s1-merge-plan.json")
F_OVERRIDES = os.path.join(OUT_DIR, "overrides.json")
F_META = os.path.join(OUT_DIR, "s1-run-meta.json")
# ---- S2（P1 Tier-1 跨命名空间 same-topic 甄别）产物 ----
F2_PAIRS = os.path.join(OUT_DIR, "s2-pairs.json")
F2_TIER2 = os.path.join(OUT_DIR, "s2-tier2-seealso.json")
F2_RESULTS = os.path.join(OUT_DIR, "s2-results.json")
F2_META = os.path.join(OUT_DIR, "s2-run-meta.json")
F2_TABLE = os.path.join(OUT_DIR, "s2-judgment-table.md")
F2_PAGES = os.path.join(OUT_DIR, "s2-pages")
F2_PLAN_TENT = os.path.join(OUT_DIR, "s2-merge-plan-tentative.json")
F2_PLAN = os.path.join(OUT_DIR, "s2-merge-plan.json")
F2_OVERRIDES = os.path.join(OUT_DIR, "overrides-s2.json")

JUDGE_NS = ("entities", "concepts")  # A 类 = 双命名空间内同 title（charter §二）


def zai_key():
    for ln in open(os.path.expanduser("~/.hermes/profiles/lt-tutor/.env")):
        if ln.startswith("ZAI_API_KEY="):
            return ln.split("=", 1)[1].strip().strip('"')
    raise SystemExit("ZAI_API_KEY 未找到")


def render(p):
    return f"[{p['path']}] title={ (p['title'] or '').strip() }\n{p['content'][:TRUNC]}"


PROMPT_ENTITY = """你是知识库实体管理员。判断两个实体页是否指向【同一个现实世界实体】。
判定标准（宁缺毋错，不确定就判不同）：
- 人物：同名且身份/角色/背景一致才算同一人；同名不同人是本知识库常见现象（多课例多教师）。
- 机构/地点/作品/平台/教材：同一具体指称才算同一实体；一个是概念一个指具体实例时不算。
- 若两页描述的是不同课例/不同视频中的不同对象，即使名字相同也不是同一实体。
- 若两页明显是同一实体的不同命名变体（拼写差异/别名/后缀差异），判同一实体。

页面 A：
{a}

页面 B：
{b}

只输出 JSON（无其他文字）：{{"same": true 或 false, "reason": "一句话中文理由"}}"""

PROMPT_TOPIC = """你是知识库内容管理员。判断两个概念页是否为【同一个知识主题的重复页面】（同一知识点被写了两遍，可以合并成一篇）。
判定标准（宁缺毋错，不确定就判不同）：
- 中英文双标题、别名、译名互指同一主题 → 算同一主题。
- 两页各讲该主题的不同侧面（一页重定义、另一页重课堂教学应用），主体内容高度重叠 → 算同一主题。
- 一页是上位概念、另一页是其下位具体方法或子项（包含关系）→ 不算。
- 标题相近但正文讲的是不同知识点 → 不算。

页面 A：
{a}

页面 B：
{b}

只输出 JSON（无其他文字）：{{"same": true 或 false, "reason": "一句话中文理由"}}"""


def llm_judge(key, kind, a, b):
    prompt = (PROMPT_ENTITY if kind == "same_entity" else PROMPT_TOPIC).format(
        a=render(a), b=render(b))
    body = json.dumps({
        "model": MODEL, "temperature": 0.1, "max_tokens": 1200,
        # d7378ed4 教训：bigmodel 不认 enable_thinking，reasoning 会烧爆 max_tokens
        # 致 JSON 截断——显式 disabled（src-server 同款参数形态）
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    text = (d["choices"][0]["message"].get("content") or "").strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None, f"unparseable: {text[:120]}"
    try:
        v = json.loads(m.group(0))
    except Exception:
        return None, f"unparseable: {text[:120]}"
    s = v.get("same")
    if not isinstance(s, bool):
        return None, f"unparseable: {text[:120]}"
    return s, str(v.get("reason", ""))[:200]


# ---------------- 归组（A 类口径：同命名空间 + title lower+trim） ----------------

def build_census(pages, icnt, ts):
    groups = defaultdict(list)
    for p in pages:
        if p["page_type"] == "query":  # 检索残影不参与合并
            continue
        t = (p["title"] or "").strip()
        if not t:
            continue  # 空 title 是 D 类（P1.5 另案）
        ns = p["path"].split("/", 1)[0]
        groups[(ns, t.lower())].append(p)
    cands, excluded = [], []
    for (ns, tkey), grp in sorted(groups.items()):
        if len(grp) < 2:
            continue
        members = []
        for p in sorted(grp, key=lambda x: wc._score(x, icnt), reverse=True):
            members.append({
                "path": p["path"], "title": (p["title"] or "").strip(),
                "page_type": p["page_type"], "chars": len(p["content"]),
                "inbound": _inbound_of(p, icnt),
                "fm_empty": (p.get("frontmatter") or "").strip() in ("", "{}", "null"),
            })
        entry = {"key": f"{ns}::{tkey}", "namespace": ns, "title": tkey, "members": members}
        (cands if ns in JUDGE_NS else excluded).append(entry)
    return {"generated_at": ts, "total_pages": len(pages),
            "candidates": cands, "excluded": excluded}


def load_fresh():
    wc.fresh_dump()
    pages = wc.load_pages()
    stems, titles, _ = wc.build_index(pages)
    icnt = wc.inbound_counts(pages, stems, titles)
    return pages, icnt


def _inbound_of(p, icnt):
    """stem 与 title 归一键相同（deci 型）时去重，否则入链双计（S1 评审 §3.4 展示项）。"""
    keys = {rla.norm_server(rla.stem_of(p["path"])),
            rla.norm_server((p["title"] or "").strip())}
    return sum(icnt.get(k, 0) for k in keys)


# ---------------- 甄别（judge） ----------------

def cmd_census(_):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    pages, icnt = load_fresh()
    census = build_census(pages, icnt, ts)
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(census, open(F_CENSUS, "w"), ensure_ascii=False, indent=1)
    n_pg = sum(len(g["members"]) for g in census["candidates"])
    print(f"候选组 {len(census['candidates'])}（{n_pg} 页）；排除组 {len(census['excluded'])}："
          f"{[g['key'] for g in census['excluded']][:8]}")
    for g in census["candidates"]:
        det = [(m["path"], m["title"], m["page_type"], m["chars"]) for m in g["members"]]
        print(f"  {g['key']}: {det}")
    print(f"census -> {F_CENSUS}")


def cmd_judge(args):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    pages, icnt = load_fresh()
    bypath = {p["path"]: p for p in pages}
    census = build_census(pages, icnt, ts)
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(PAGES_DIR, exist_ok=True)
    json.dump(census, open(F_CENSUS, "w"), ensure_ascii=False, indent=1)
    n_pg = sum(len(g["members"]) for g in census["candidates"])
    print(f"候选组 {len(census['candidates'])}（{n_pg} 页）；排除组（非 entities/concepts 命名空间，"
          f"C 类等另案）{len(census['excluded'])}："
          f"{[g['key'] for g in census['excluded']][:8]}")
    # 页面快照（人工复核可离线读，不依赖 DB）
    for g in census["candidates"]:
        for m in g["members"]:
            p = bypath[m["path"]]
            fn = os.path.join(PAGES_DIR, m["path"].replace("/", "--"))
            with open(fn, "w") as f:
                f.write(f"<!-- snapshot {ts} | title={m['title']} | type={m['page_type']} "
                        f"| chars={m['chars']} | inbound={m['inbound']} | fm_empty={m['fm_empty']} -->\n\n")
                f.write(p["content"])
    # 断点续跑：same 非 None 的对不重复调
    prev = {}
    if os.path.exists(F_RESULTS) and not args.fresh:
        for r in json.load(open(F_RESULTS)):
            if r["same"] is not None:
                prev[(r["anchor"], r["member"])] = r
    results = [] if args.fresh else [r for r in _load_prev(F_RESULTS) if r["same"] is not None]
    # 评审 §3.4：null 行不进 results（重判后追加新行），否则 resume 会重复判定并虚增未定计数
    key = zai_key()
    n_call = n_new = 0
    for g in census["candidates"]:
        if args.groups and g["key"] not in args.groups.split(","):
            continue
        members = g["members"]
        anchor_path = members[0]["path"]
        kind = "same_entity" if g["namespace"] == "entities" else "same_topic"
        for m in members[1:]:
            pair = (anchor_path, m["path"])
            if pair in prev:
                v = dict(prev[pair])
            else:
                a, b = bypath[anchor_path], bypath[m["path"]]
                calls = 1
                same, reason = llm_judge(key, kind, a, b)
                n_call += 1
                if same is None:  # 空响应/截断重试一次（≤2 调用/对）
                    calls = 2
                    same, reason = llm_judge(key, kind, a, b)
                    n_call += 1
                n_new += 1
                v = {"group": g["key"], "namespace": g["namespace"], "prompt": kind,
                     "anchor": anchor_path, "member": m["path"],
                     "same": same, "reason": reason, "model": MODEL, "calls": calls}
                results.append(v)
                json.dump(results, open(F_RESULTS, "w"), ensure_ascii=False, indent=1)
            mark = "同" if v["same"] else ("?" if v["same"] is None else "异")
            print(f"{mark} | {v['anchor']} <-> {v['member']} | {v['reason'][:80]}")
    json.dump(results, open(F_RESULTS, "w"), ensure_ascii=False, indent=1)
    n_same = sum(1 for r in results if r["same"] is True)
    n_none = sum(1 for r in results if r["same"] is None)
    # 调用计数落盘：retried_pairs = llm_calls - new_pairs 可从产物直接验证重试率
    json.dump({"finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": MODEL,
               "pairs": len(results), "new_pairs": n_new, "llm_calls": n_call,
               "retried_pairs": n_call - n_new,
               "same": n_same, "diff": len(results) - n_same - n_none,
               "undetermined": n_none},
              open(F_META, "w"), ensure_ascii=False, indent=1)
    write_table(census, results)
    plan = build_plan(census, results, None)
    json.dump(plan, open(F_PLAN_TENT, "w"), ensure_ascii=False, indent=1)
    print(f"\n完成：{len(results)} 对（本轮新调 {n_call} 次），同 {n_same} / 异 {len(results)-n_same-n_none} / 未定 {n_none}")
    print(f"判定表 {F_TABLE}\n暂定计划 {F_PLAN_TENT}（{len(plan['groups'])} 组待人工复核）")


def _load_prev(path):
    if os.path.exists(path):
        return json.load(open(path))
    return []


# ---------------- 判定表（S1 交付物） ----------------

def write_table(census, results):
    by_group = defaultdict(list)
    for r in results:
        by_group[r["group"]].append(r)
    L = [f"# S1 判定表 — P0 A 类同 title 组甄别（{census['generated_at']}，{MODEL}）\n"]
    L.append(f"口径：{census['total_pages']} 页全库导出，entities/concepts 命名空间内 title lower+trim 分组、"
             f"类型无关；LLM 逐对甄别（anchor=组内入链+字数最高分页）。宁缺毋错：不确定一律判异，人工复核可翻案。")
    L.append("人工覆写（S3 裁决用）：编辑 overrides.json——`{\"<组key>\": {\"keep_path\": \"…\", \"losers\": [\"…\"]}}` "
             "覆写该组合并方向；`{\"<组key>\": \"skip\"}` 撤销该组合并。存后跑 "
             "`python3 tools/adjudicate-merge.py plan` 生成 s1-merge-plan.json。\n")
    L.append(f"候选 {len(census['candidates'])} 组；排除（另案）{len(census['excluded'])} 组："
             + "、".join(g["key"] for g in census["excluded"]) + "\n")
    for g in census["candidates"]:
        L.append(f"## {g['key']}（{len(g['members'])} 页）\n")
        L.append("| path | title | type | 字数 | 入链 | fm空 |")
        L.append("|---|---|---|---|---|---|")
        for m in g["members"]:
            L.append(f"| {m['path']} | {m['title']} | {m['page_type']} | {m['chars']} "
                     f"| {m['inbound']} | {'是' if m['fm_empty'] else ''} |")
        for r in by_group.get(g["key"], []):
            mark = "同（可合并）" if r["same"] else ("? 未定" if r["same"] is None else "异（保留）")
            L.append(f"- 判定：`{r['anchor']}` <-> `{r['member']}` = **{mark}**（{r['prompt']}）｜{r['reason']}")
        rec = plan_one_group(g, by_group.get(g["key"], []))
        if rec:
            L.append(f"- **建议**：合并 keep=`{rec['keep_path']}`（富侧），del={rec['losers']}")
        else:
            L.append("- **建议**：整组保留（无同判定对）")
        L.append("")
    open(F_TABLE, "w").write("\n".join(L))


# ---------------- plan-builder（results → merge 计划；S3 人工覆写经 overrides.json） ----------------

def plan_one_group(g, pairs):
    """组内 union-find：same=True 的对连通；连通块 ≥2 即合并集，keep=富侧（字数，平手带入链）。"""
    stats = {m["path"]: m for m in g["members"]}
    parent = {m["path"]: m["path"] for m in g["members"]}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for r in pairs:
        if r["same"] is True and r["anchor"] in parent and r["member"] in parent:
            ra, rb = find(r["anchor"]), find(r["member"])
            if ra != rb:
                parent[ra] = rb
    comps = defaultdict(list)
    for p in parent:
        comps[find(p)].append(p)
    out = []
    for comp in comps.values():
        if len(comp) < 2:
            continue
        keep = max(comp, key=lambda p: (stats[p]["chars"], stats[p]["inbound"]))
        out.append({"key": g["key"], "keep_path": keep,
                    "losers": sorted(p for p in comp if p != keep)})
    return out[0] if len(out) == 1 else (None if not out else out[0])


def build_plan(census, results, overrides):
    by_group = defaultdict(list)
    for r in results:
        by_group[r["group"]].append(r)
    groups = []
    for g in census["candidates"]:
        recs = plan_one_group(g, by_group.get(g["key"], []))
        if recs:
            groups.append(recs)
    if overrides:
        for k, ov in overrides.items():
            if ov == "skip":
                groups = [g for g in groups if g["key"] != k]
            elif isinstance(ov, dict) and "keep_path" in ov:
                groups = [g for g in groups if g["key"] != k]
                groups.append({"key": k, "keep_path": ov["keep_path"],
                               "losers": ov.get("losers", [])})
    return {"source": "S1 adjudication (charter 2026-09-12)",
            "groups": sorted(groups, key=lambda g: g["key"])}


def _member_row(p, icnt):
    return {"path": p["path"], "title": (p["title"] or "").strip(),
            "page_type": p["page_type"], "chars": len(p["content"]),
            "inbound": _inbound_of(p, icnt),
            "fm_empty": (p.get("frontmatter") or "").strip() in ("", "{}", "null")}


# ---------------- S2：P1 跨命名空间同基名配对（charter §二 B 口径） ----------------

def build_b_pairs(pages, icnt):
    """slug 同基名严格 1:1（大小写敏感同值）：entities×concepts 各恰一页才成对。
    title 比较一律 lower+trim（charter §二口径基准）→ Tier-1=title 全同，其余=Tier-2。"""
    by = defaultdict(lambda: defaultdict(list))  # stem -> ns -> [pages]
    for p in pages:
        ns = p["path"].split("/", 1)[0]
        if ns in JUDGE_NS:
            by[rla.stem_of(p["path"])][ns].append(p)
    tier1, tier2, ambiguous = [], [], []
    for stem, nsmap in sorted(by.items()):
        cs, es = nsmap.get("concepts", []), nsmap.get("entities", [])
        if len(cs) == 1 and len(es) == 1:
            c, e = cs[0], es[0]
            tc = (c["title"] or "").strip().lower()
            te = (e["title"] or "").strip().lower()
            mc, me = _member_row(c, icnt), _member_row(e, icnt)
            pair = {"stem": stem, "key": f"xns::{stem}", "concept": mc, "entity": me,
                    "titles": {"concept": mc["title"], "entity": me["title"]},
                    "title_same": bool(tc) and bool(te) and tc == te,
                    "keep_rich": mc["path"] if (mc["chars"], mc["inbound"]) >= (me["chars"], me["inbound"]) else me["path"]}
            (tier1 if pair["title_same"] else tier2).append(pair)
        elif len(cs) + len(es) >= 2:  # 同基名但非严格 1:1 → B 口径外，如实列示
            ambiguous.append({"stem": stem,
                              "concepts": [p["path"] for p in cs], "entities": [p["path"] for p in es]})
    return tier1, tier2, ambiguous


def cmd_s2_census(_):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    pages, icnt = load_fresh()
    tier1, tier2, ambiguous = build_b_pairs(pages, icnt)
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(F2_PAGES, exist_ok=True)
    bypath = {p["path"]: p for p in pages}
    json.dump({"generated_at": ts, "total_pages": len(pages),
               "tier1": tier1, "tier2": tier2, "ambiguous": ambiguous},
              open(F2_PAIRS, "w"), ensure_ascii=False, indent=1)
    json.dump({"generated_at": ts,
               "note": "Tier-2 See-Also 清单（charter §五：落地另批/追加步骤，届时遵守全量 fm 写入规则）",
               "pairs": tier2},
              open(F2_TIER2, "w"), ensure_ascii=False, indent=1)
    # Tier-1 双侧页面快照（人工复核离线读）
    for pr in tier1:
        for m in (pr["concept"], pr["entity"]):
            fn = os.path.join(F2_PAGES, m["path"].replace("/", "--"))
            with open(fn, "w") as f:
                f.write(f"<!-- snapshot {ts} | title={m['title']} | type={m['page_type']} "
                        f"| chars={m['chars']} | inbound={m['inbound']} | fm_empty={m['fm_empty']} -->\n\n")
                f.write(bypath[m["path"]]["content"])
    print(f"B 口径配对：Tier-1（title 全同）{len(tier1)} 对 / Tier-2 {len(tier2)} 对 / 非 1:1 歧义 stem {len(ambiguous)}；"
          f"总页 {len(pages)}")
    for pr in tier1[:6]:
        print(f"  {pr['key']}: {pr['concept']['path']}({pr['concept']['chars']}) <-> "
              f"{pr['entity']['path']}({pr['entity']['chars']})")
    if len(tier1) > 6:
        print(f"  … 共 {len(tier1)} 对，明细 {F2_PAIRS}")
    print(f"pairs -> {F2_PAIRS}\nTier-2 清单 -> {F2_TIER2}")


def _pair_verdicts(census_t1, results):
    by_pair = {(r["concept"], r["entity"]): r for r in results}
    return by_pair


def write_s2_table(tier1, results):
    by_pair = _pair_verdicts(tier1, results)
    n_same = sum(1 for r in results if r["same"] is True)
    L = [f"# S2 判定表 — P1 Tier-1 跨命名空间 same-topic 甄别（{time.strftime('%Y-%m-%dT%H:%M:%S')}，{MODEL}）\n"]
    L.append(f"口径：slug 同基名严格 1:1（大小写敏感）× title 全同（lower+trim）；全对 same_topic prompt；"
             f"keep 方向=组内实测富侧（charter §五）。宁缺毋错：不确定判异，人工复核可翻案。")
    L.append(f"人工覆写（S3 裁决用）：编辑 overrides-s2.json——`{{\"xns::<stem>\": {{\"keep_path\": \"…\", \"losers\": [\"…\"]}}}}` "
             f"覆写合并方向；`{{\"xns::<stem>\": \"skip\"}}` 撤销该对。存后跑 "
             f"`python3 tools/adjudicate-merge.py s2-plan` 生成 s2-merge-plan.json。\n")
    L.append(f"共 {len(tier1)} 对；LLM 判同 {n_same} / 判异 {len(results)-n_same}。UbD 对置顶（G11 自愈门）。\n")
    for pr in tier1:
        r = by_pair.get((pr["concept"]["path"], pr["entity"]["path"]))
        L.append(f"## {pr['key']}（{'★G11' if pr['stem'] == 'understanding-by-design' else 'pair'}）")
        L.append(f"- concept 侧：`{pr['concept']['path']}` title={pr['titles']['concept']} "
                 f"（{pr['concept']['chars']} 字/入链 {pr['concept']['inbound']}{'/fm空' if pr['concept']['fm_empty'] else ''}）")
        L.append(f"- entity 侧：`{pr['entity']['path']}` title={pr['titles']['entity']} "
                 f"（{pr['entity']['chars']} 字/入链 {pr['entity']['inbound']}{'/fm空' if pr['entity']['fm_empty'] else ''}）")
        if r:
            mark = "同（可合并）" if r["same"] else ("? 未定" if r["same"] is None else "异（保留）")
            L.append(f"- 判定：**{mark}**｜{r['reason']}")
        else:
            L.append("- 判定：（未跑）")
        L.append(f"- **建议**：keep=`{pr['keep_rich']}`（富侧）" if r and r["same"] else f"- **建议**：{'保留双侧' if r and r['same'] is False else '待判定'}")
        L.append("")
    open(F2_TABLE, "w").write("\n".join(L))


def s2_plan_groups(tier1, results, overrides):
    by_pair = _pair_verdicts(tier1, results)
    groups = []
    for pr in tier1:
        r = by_pair.get((pr["concept"]["path"], pr["entity"]["path"]))
        if r and r["same"] is True:
            keep = pr["keep_rich"]
            loser = pr["entity"]["path"] if keep == pr["concept"]["path"] else pr["concept"]["path"]
            groups.append({"key": pr["key"], "keep_path": keep, "losers": [loser]})
    if overrides:
        for k, ov in overrides.items():
            if ov == "skip":
                groups = [g for g in groups if g["key"] != k]
            elif isinstance(ov, dict) and "keep_path" in ov:
                groups = [g for g in groups if g["key"] != k]
                groups.append({"key": k, "keep_path": ov["keep_path"], "losers": ov.get("losers", [])})
    return {"source": "S2 Tier-1 adjudication (charter 2026-09-12)",
            "groups": sorted(groups, key=lambda g: g["key"])}


def cmd_s2_judge(args):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    pages, icnt = load_fresh()
    tier1, tier2, ambiguous = build_b_pairs(pages, icnt)
    bypath = {p["path"]: p for p in pages}
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(F2_PAGES, exist_ok=True)
    for pr in tier1:
        for m in (pr["concept"], pr["entity"]):
            fn = os.path.join(F2_PAGES, m["path"].replace("/", "--"))
            with open(fn, "w") as f:
                f.write(f"<!-- snapshot {ts} | title={m['title']} | type={m['page_type']} "
                        f"| chars={m['chars']} | inbound={m['inbound']} | fm_empty={m['fm_empty']} -->\n\n")
                f.write(bypath[m["path"]]["content"])
    # UbD 对置顶（G11 自愈门），其余按 stem 稳定序
    tier1 = sorted(tier1, key=lambda pr: (pr["stem"] != "understanding-by-design", pr["stem"]))
    json.dump({"generated_at": ts, "total_pages": len(pages),
               "tier1": tier1, "tier2": tier2, "ambiguous": ambiguous},
              open(F2_PAIRS, "w"), ensure_ascii=False, indent=1)
    prev = {}
    if os.path.exists(F2_RESULTS) and not args.fresh:
        for r in json.load(open(F2_RESULTS)):
            if r["same"] is not None:
                prev[(r["concept"], r["entity"])] = r
    results = [] if args.fresh else [r for r in _load_prev(F2_RESULTS) if r["same"] is not None]
    key = zai_key()
    n_call = n_new = 0
    for pr in tier1:
        pair = (pr["concept"]["path"], pr["entity"]["path"])
        if pair in prev:
            v = dict(prev[pair])
        else:
            a, b = bypath[pr["concept"]["path"]], bypath[pr["entity"]["path"]]
            calls = 1
            same, reason = llm_judge(key, "same_topic", a, b)
            n_call += 1
            if same is None:
                calls = 2
                same, reason = llm_judge(key, "same_topic", a, b)
                n_call += 1
            n_new += 1
            v = {"key": pr["key"], "stem": pr["stem"], "prompt": "same_topic",
                 "concept": pr["concept"]["path"], "entity": pr["entity"]["path"],
                 "same": same, "reason": reason, "model": MODEL, "calls": calls}
            results.append(v)
            json.dump(results, open(F2_RESULTS, "w"), ensure_ascii=False, indent=1)
        mark = "同" if v["same"] else ("?" if v["same"] is None else "异")
        print(f"{mark} | {v['concept']} <-> {v['entity']} | {v['reason'][:80]}")
    json.dump(results, open(F2_RESULTS, "w"), ensure_ascii=False, indent=1)
    n_same = sum(1 for r in results if r["same"] is True)
    n_none = sum(1 for r in results if r["same"] is None)
    json.dump({"finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": MODEL,
               "pairs": len(results), "new_pairs": n_new, "llm_calls": n_call,
               "retried_pairs": n_call - n_new, "same": n_same,
               "diff": len(results) - n_same - n_none, "undetermined": n_none},
              open(F2_META, "w"), ensure_ascii=False, indent=1)
    write_s2_table(tier1, results)
    overrides = json.load(open(F2_OVERRIDES)) if os.path.exists(F2_OVERRIDES) else None
    plan = s2_plan_groups(tier1, results, overrides)
    json.dump(plan, open(F2_PLAN_TENT, "w"), ensure_ascii=False, indent=1)
    print(f"\n完成：{len(results)} 对（本轮新调 {n_call} 次），同 {n_same} / 异 {len(results)-n_same-n_none} / 未定 {n_none}")
    print(f"判定表 {F2_TABLE}\n暂定计划 {F2_PLAN_TENT}（{len(plan['groups'])} 对待人工复核）")


def cmd_s2_plan(args):
    data = json.load(open(F2_PAIRS))
    results = _load_prev(F2_RESULTS)
    overrides = json.load(open(args.overrides)) if args.overrides else (
        json.load(open(F2_OVERRIDES)) if os.path.exists(F2_OVERRIDES) else None)
    plan = s2_plan_groups(data["tier1"], results, overrides)
    out = args.out or F2_PLAN
    json.dump(plan, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"Tier-1 合并计划 {len(plan['groups'])} 对，删 {sum(len(g['losers']) for g in plan['groups'])} loser -> {out}"
          + ("（含人工覆写）" if overrides else "（暂定，未经人工复核）"))


def cmd_plan(args):
    census = json.load(open(F_CENSUS))
    results = _load_prev(F_RESULTS)
    overrides = json.load(open(args.overrides)) if args.overrides else (
        json.load(open(F_OVERRIDES)) if os.path.exists(F_OVERRIDES) else None)
    plan = build_plan(census, results, overrides)
    out = args.out or F_PLAN
    json.dump(plan, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"合并计划 {len(plan['groups'])} 组，删 {sum(len(g['losers']) for g in plan['groups'])} loser -> {out}"
          + ("（含人工覆写）" if overrides else "（暂定，未经人工复核）"))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("census", help="仅归组盘点，不调 LLM")
    j = sub.add_parser("judge", help="归组 + LLM 逐对甄别 + 判定表 + 暂定计划")
    j.add_argument("--groups", help="只跑指定组 key（逗号分隔），调试用")
    j.add_argument("--fresh", action="store_true", help="忽略断点续跑，全部重判")
    p = sub.add_parser("plan", help="results(+overrides.json) → merge 计划")
    p.add_argument("--overrides", help="人工覆写 JSON：{group: \"skip\" 或 {keep_path, losers}}")
    p.add_argument("--out", help="输出路径（默认 s1-merge-plan.json）")
    sub.add_parser("s2-census", help="S2：B 口径跨命名空间配对盘点（Tier-1/Tier-2/歧义），不调 LLM")
    j2 = sub.add_parser("s2-judge", help="S2：Tier-1 same_topic 逐对甄别 + 判定表 + 暂定计划（UbD 置顶）")
    j2.add_argument("--fresh", action="store_true", help="忽略断点续跑，全部重判")
    p2 = sub.add_parser("s2-plan", help="S2：results(+overrides-s2.json) → Tier-1 merge 计划")
    p2.add_argument("--overrides")
    p2.add_argument("--out")
    args = ap.parse_args()
    {"census": cmd_census, "judge": cmd_judge, "plan": cmd_plan,
     "s2-census": cmd_s2_census, "s2-judge": cmd_s2_judge, "s2-plan": cmd_s2_plan}[args.cmd](args)


if __name__ == "__main__":
    main()

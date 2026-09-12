#!/usr/bin/env python3
# tools/wiki-cleanup.py — 存量清理三批（2026-09-09，用户拍板依次执行）
#   backfill-links  批①：全库不可解析 [[链接]] 降级纯文本（处方 E 的存量回放，fence 感知）
#   plan-merge      批②干跑：实体分裂合并计划（canonical/入链量/证据）
#   merge           批②执行：入链改写→canonical 合并→删 loser
#   plan-mini       批③干跑：迷你残渣清单（严格判据）
#   purge           批③执行：删残渣页（随后用 backfill-links 清新悬空）
#
# 纪律：干跑默认（--execute 才写）；写前自动备份 ~/kb-dumps/<ts>-<phase>/；
# 写侧只走 API（PUT 自动重建向量），绝不直写 PG。测量/降级共用 redlink-audit.py
# 语义（服务端口径：stem first-wins + title 碰撞组整组排除），与验收工具同源。
#
# 用法：
#   python3 tools/wiki-cleanup.py backfill-links [--execute]
#   python3 tools/wiki-cleanup.py plan-merge
#   python3 tools/wiki-cleanup.py merge --plan /tmp/.merge_plan.json --execute
#   python3 tools/wiki-cleanup.py plan-mini
#   python3 tools/wiki-cleanup.py purge --list /tmp/.mini_purge.json --execute
import argparse, csv, hashlib, json, os, re, subprocess, sys, time
import importlib.util
import urllib.request
import urllib.error
from collections import defaultdict, Counter

HERE = os.path.dirname(os.path.abspath(__file__))
csv.field_size_limit(sys.maxsize)

# ---- redlink-audit.py 语义复用（服务端口径）----
spec = importlib.util.spec_from_file_location("rla", os.path.join(HERE, "redlink-audit.py"))
rla = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rla)

# RE_SERVER 的 label 是非捕获组；改写/降级需要捕获 label
RE_LINK = re.compile(r"\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]")

BASE = os.environ.get("WIKI_API", "http://127.0.0.1:8080")
PROJECT_ID = 614
BOOTSTRAP = os.path.join(HERE, "transcriber/out/bootstrap.env")
DUMP = "/tmp/.curate_pages_dump.csv"


def load_bootstrap(key):
    for ln in open(BOOTSTRAP, encoding="utf-8", errors="replace"):
        if ln.startswith(key + "="):
            return ln.split("=", 1)[1].strip().strip('"')
    return None


def api_login(username, password):
    req = urllib.request.Request(
        BASE + "/api/v1/auth/login",
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["access_token"]


def api(token, method, path, body=None, if_match=None):
    hdrs = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    if if_match:
        hdrs["if-match"] = if_match
    req = urllib.request.Request(
        f"{BASE}/api/v1/projects/{PROJECT_ID}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            return r.status, json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        return e.code, (e.read()[:200].decode("utf-8", "replace"))


def put_page(token, path, content, frontmatter, skip_if_same=True):
    """乐观锁 PUT：GET→sha 同跳过→PUT if-match；409 重试一轮。
    skip_if_same=False 时内容即使未变也写（用于 sources 并集等纯 frontmatter 变更
    ——复验 Minor：内容 sha 相同而只并 sources 时，整页 skip 会漏掉元数据）。
    I1（复验 #2 实锺）：body 的 frontmatter 必须用形参（合并后含并集 sources），
    形参 None 才回落服务端现值——此前写死 cur.get() 使并集从未落库。
    E2 补全上提（S1 评审 §3.4）：fm 键缺失/None 一律以 GET 现值补全（title/type/
    sources/images，单页 GET 已含全四字段）。denormalize（pages.rs:59）对缺键的
    回落是破坏性的：缺 title→列置 NULL、缺 type→page_type 静默重置 concept、
    缺 sources/images→置 []。统一出口补全后，fm 全空（skehan 事故面，5b6fabad
    只堵了一半）、部分缺键（存量 305 页）、调用方漏键三类全部封死。"""
    q = f"/page?path={urllib.request.quote(path, safe='')}"
    for _ in range(2):
        st, cur = api(token, "GET", q)
        if st != 200:
            raise RuntimeError(f"GET {path} -> {st}")
        new_hash = hashlib.sha256(content.encode()).hexdigest()
        if skip_if_same and hashlib.sha256((cur.get("content") or "").encode()).hexdigest() == new_hash:
            return "skipped"
        fm = frontmatter if frontmatter is not None else cur.get("frontmatter")
        if not isinstance(fm, dict):
            try:
                fm = json.loads(fm) if fm else {}
            except Exception:
                fm = {}
        for k, dflt in (("title", cur.get("title") or ""),
                        ("type", cur.get("page_type") or "concept"),
                        ("sources", cur.get("sources") or []),
                        ("images", cur.get("images") or [])):
            if fm.get(k) is None:
                fm[k] = dflt
        st, resp = api(token, "PUT", q,
                       {"path": path, "content": content, "frontmatter": fm},
                       if_match=cur.get("updated_at"))
        if st == 200:
            return "updated"
        if st != 409:
            raise RuntimeError(f"PUT {path} -> {st} {resp}")
    raise RuntimeError(f"PUT {path}: 409 持续冲突")


def delete_page(token, path):
    st, resp = api(token, "DELETE", f"/page?path={urllib.request.quote(path, safe='')}")
    if st in (204, 404):
        return st
    raise RuntimeError(f"DELETE {path} -> {st} {resp}")


def fresh_dump():
    """经 psql COPY 导出全量页（只读）。列序与 redlink-audit 一致 + frontmatter/updated_at。"""
    sql = ("\\copy (SELECT path, title, page_type, content, updated_at, sources, frontmatter "
           "FROM wiki_pages WHERE project_id=614) TO '/tmp/.curate_tmp.csv' WITH CSV")
    subprocess.run(["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki",
                    "-d", "llmwiki", "-c", sql], check=True,
                   stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "cp", "src-server-postgres-1:/tmp/.curate_tmp.csv", DUMP], check=True,
                   stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "exec", "src-server-postgres-1", "rm", "-f", "/tmp/.curate_tmp.csv"],
                   check=True, stdout=subprocess.DEVNULL)


def load_pages():
    rows = []
    with open(DUMP) as f:
        for r in csv.reader(f):
            rows.append({"path": r[0], "title": r[1], "page_type": r[2], "content": r[3],
                         "updated_at": r[4], "sources": r[5],
                         "frontmatter": r[6] if len(r) > 6 else ""})
    return rows


def build_index(pages):
    """服务端口径：stem first-wins + title 碰撞组整组排除。返回 (stems, titles, colliding)。"""
    uni = [p for p in pages if p["page_type"] != "query"]
    stems = {}
    for p in uni:
        stems.setdefault(rla.norm_server(rla.stem_of(p["path"])), p["path"])
    tg = defaultdict(list)
    for p in uni:
        t = (p["title"] or "").strip()
        if t:
            tg[rla.norm_server(t)].append(p["path"])
    titles = {k: v[0] for k, v in tg.items() if len(v) == 1}
    colliding = {k for k, v in tg.items() if len(v) > 1}
    return stems, titles, colliding


def resolves(stems, titles, raw):
    k = rla.norm_server(raw.strip())
    return k in stems or k in titles


def downgrade_links(md, stems, titles):
    """处方 E 的字符串级回放（M1 fence 感知）。返回 (新文本, 降级数)。"""
    if "[[" not in md:
        return md, 0
    out, n, fence = [], 0, False
    for line in md.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
            out.append(line)
            continue
        if fence:
            out.append(line)
            continue
        def repl(m):
            nonlocal n
            target = m.group(1).strip()
            if resolves(stems, titles, target):
                return m.group(0)
            n += 1
            return m.group(2) if m.group(2) is not None else target
        out.append(RE_LINK.sub(repl, line))
    return "\n".join(out), n


def backup(phase, rows, extra_note=""):
    ts = time.strftime("%Y%m%d-%H%M%S")
    d = os.path.expanduser(f"~/kb-dumps/{ts}-{phase}")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "backup.csv")
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        for r in rows:
            w.writerow([r["path"], r["title"], r["page_type"], r["content"],
                        r["updated_at"], r["sources"], r["frontmatter"]])
    if extra_note:
        open(os.path.join(d, "note.txt"), "w").write(extra_note)
    print(f"备份 {len(rows)} 行 -> {p}")
    return d


def login_default():
    pw = load_bootstrap("SVC_PASSWORD")
    return api_login("svc-transcriber", pw)


# ---------------- 批① ----------------
def cmd_backfill(args):
    fresh_dump()
    pages = load_pages()
    stems, titles, _ = build_index(pages)
    work = []
    for p in pages:
        new, n = downgrade_links(p["content"], stems, titles)
        if n:
            work.append((p, new, n))
    total = sum(n for _, _, n in work)
    print(f"[{'EXECUTE' if args.execute else 'DRY-RUN'}] 悬空链接 {total} 实例，分布 {len(work)} 页；"
          f"top: {[(p['path'], n) for p, _, n in sorted(work, key=lambda x: -x[2])[:10]]}")
    if not args.execute:
        return
    backup("redlink-backfill", [p for p, _, _ in work],
           f"共 {total} 实例降级；此备份为降级前原文")
    token = login_default()
    done = fail = 0
    for i, (p, new, _) in enumerate(work):
        try:
            put_page(token, p["path"], new, json.loads(p["frontmatter"]) if p["frontmatter"] else None)
            done += 1
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {p['path']}: {e}")
        if (i + 1) % 50 == 0:
            print(f"  进度 {i+1}/{len(work)}")
    print(f"批①完成：PUT {done} 页成功，{fail} 失败（失败页可安全重跑本命令补齐）")


# ---------------- 批② ----------------
SUFFIX_RE = re.compile(r"-(teacher|instructor)$")


def inbound_counts(pages, stems, titles):
    """每个可解析目标的入链实例数（按 raw 原文聚合）。"""
    cnt = defaultdict(int)
    for p in pages:
        if p["page_type"] == "query":
            continue
        for raw in rla.extract_links_server(p["content"]):
            k = rla.norm_server(raw)
            if k in stems or k in titles:
                cnt[k] += 1
    return cnt


def cmd_plan_merge(args):
    fresh_dump()
    pages = load_pages()
    stems, titles, _ = build_index(pages)
    ents = [p for p in pages if p["page_type"] == "entity"]
    bynorm = defaultdict(list)
    for p in ents:
        t = (p["title"] or "").strip()
        if t:
            bynorm[rla.norm_server(t)].append(p)
    dup = {k: sorted(v, key=lambda x: x["path"]) for k, v in bynorm.items() if len(v) > 1}
    fam = defaultdict(list)
    for p in ents:
        fam[SUFFIX_RE.sub("", rla.stem_of(p["path"]))].append(p)
    fam = {k: v for k, v in fam.items() if len({x["path"] for x in v}) > 1}
    icnt = inbound_counts(pages, stems, titles)
    print(f"同 title 实体组 {len(dup)}；-teacher/-instructor 家族 {len(fam)}")
    groups, seen_members = [], set()
    for k, grp in dup.items():
        if len({p["path"] for p in grp}) >= 2:
            groups.append(_plan_group(grp, icnt, f"title:{k}"))
            seen_members |= {p["path"] for p in grp}
    for k, grp in sorted(fam.items()):
        rest = [p for p in grp if p["path"] not in seen_members]
        if len(rest) >= 2:
            groups.append(_plan_group(rest, icnt, f"fam:{k}"))
    groups = [g for g in groups if g]
    strong = [g for g in groups if g["evidence"] == "strong"]
    weak = [g for g in groups if g["evidence"] != "strong"]
    print(f"\n强证据组（同 norm title，直接可并）: {len(strong)}")
    for g in strong:
        print(f"  {g['key']}: keep={g['keep_path']}  del={g['losers']}")
    print(f"\n弱证据组（title 不同，仅 -teacher 家族剩余；本批跳过留人工）: {len(weak)}")
    for g in weak:
        det = [(m["path"], (m["title"] or "").strip()) for m in g["members_detail"]]
        print(f"  {g['key']}: {det}")
    json.dump({"groups": strong}, open("/tmp/.merge_plan.json", "w"), ensure_ascii=False)
    print(f"\n强证据合并计划已写 /tmp/.merge_plan.json（{len(strong)} 组，"
          f"删 {sum(len(g['losers']) for g in strong)} loser）")


def _score(p, icnt):
    k = rla.norm_server(rla.stem_of(p["path"]))
    t = rla.norm_server((p["title"] or "").strip())
    return (icnt.get(k, 0) + icnt.get(t, 0), len(p["content"]), -len(p["path"]))


def _plan_group(grp, icnt, key):
    if len({p["path"] for p in grp}) < 2:
        return None
    grp = sorted(grp, key=lambda p: _score(p, icnt), reverse=True)
    return {"key": key, "keep_path": grp[0]["path"],
            "losers": [p["path"] for p in grp[1:]],
            "members_detail": grp,
            "evidence": "strong" if key.startswith("title:") else "weak"}


def cmd_merge(args):
    plan = json.load(open(args.plan))
    fresh_dump()
    pages = {p["path"]: p for p in load_pages()}
    # 删除后宇宙里 keep 的 stem 歧义检查：同 stem 多页（如 concepts/x + entities/x）
    # 时裸 stem 会 first-wins 指错页——改写 token 降级用 keep 的唯一 title 形。
    from collections import Counter
    all_losers = {lp for g in plan["groups"] for lp in g["losers"]}
    post = [p for p in pages.values() if p["path"] not in all_losers]
    _, titles_post, _ = build_index(post)
    stem_count = Counter(rla.norm_server(rla.stem_of(p["path"])) for p in post)
    keep_token = {}
    for g in plan["groups"]:
        kp = g["keep_path"]
        if kp not in pages:
            continue
        s = rla.norm_server(rla.stem_of(kp))
        if stem_count.get(s, 0) > 1:
            t = (pages[kp]["title"] or "").strip()
            if t and rla.norm_server(t) in titles_post:
                keep_token[kp] = t  # title 形可经 title 索引解析到本页
                continue
        keep_token[kp] = rla.stem_of(kp)  # 裸 stem
    # loser 各种可解析形式 → keep 的改写 token
    loser_forms = {}
    for g in plan["groups"]:
        kp = g["keep_path"]
        token = keep_token.get(kp)
        if not token:
            continue
        for lp in g["losers"]:
            lp_page = pages.get(lp)
            forms = {rla.norm_server(rla.stem_of(lp))}
            if lp_page:
                lt = (lp_page["title"] or "").strip()
                if lt:
                    forms.add(rla.norm_server(lt))
            for f in forms:
                loser_forms[f] = token
    # 1) 全库入链改写：[[loser 形|...]] / [[loser 形]] → [[canonical-stem|原文]]
    rewrites = []
    for p in pages.values():
        if p["page_type"] == "query" or "[[" not in p["content"]:
            continue
        n = [0]
        def repl(m):
            k = rla.norm_server(m.group(1))
            if k in loser_forms:
                n[0] += 1
                return f"[[{loser_forms[k]}|{m.group(1).strip()}]]"
            return m.group(0)
        new = RE_LINK.sub(repl, p["content"])
        if n[0]:
            rewrites.append((p, new, n[0]))
    rewrites_map = {p["path"]: nw for p, nw, _ in rewrites}
    # loser 正文改写闭包：canonical 追加 loser 正文前同样要过一遍 loser_forms——
    # 否则 loser 正文里指向本批其他 loser 的链接原样进 keep 页（2026-09-09
    # concepts 同 title 批实锺：刻意练习组 loser 被追加后留 1 条悬空链）
    def rewrite_loser_body(text):
        return RE_LINK.sub(repl, text)
    # 2) canonical 合并：内容追加 + sources 并集
    merges = []
    for g in plan["groups"]:
        kp = pages.get(g["keep_path"])
        if not kp:
            continue
        new_content = rewrites_map.get(g["keep_path"], kp["content"])
        parts = []
        try:
            fm = json.loads(kp["frontmatter"]) if kp["frontmatter"] else {}
        except Exception:
            fm = {}
        fm_sources = list(fm.get("sources") or [])
        for lp in g["losers"]:
            lp_page = pages.get(lp)
            if not lp_page:
                continue
            body = rewrite_loser_body(lp_page["content"]).strip()
            if body and body not in new_content:
                lt = (lp_page["title"] or "").strip() or rla.stem_of(lp)
                parts.append(f"\n\n## 合并自 {lt}\n\n{body}")
            try:
                lfm = json.loads(lp_page["frontmatter"]) if lp_page["frontmatter"] else {}
            except Exception:
                lfm = {}
            for s in (lfm.get("sources") or []):
                if s not in fm_sources:
                    fm_sources.append(s)
        merges.append((kp, new_content + "".join(parts), fm_sources, [lp for lp in g["losers"] if lp in pages]))
    losers_all = [lp for m in merges for lp in m[3]]
    print(f"入链改写 {len(rewrites)} 页（{sum(n for _, _, n in rewrites)} 链接）；"
          f"canonical 合并 {len(merges)} 页；删除 loser {len(losers_all)} 页")
    if not args.execute:
        for g in plan["groups"]:
            print(f"  {g['key']}: keep={g['keep_path']} del={g['losers']}")
        return
    backup("entity-merge",
           [pages[lp] for lp in losers_all if lp in pages]
           + [p for p, _, _ in rewrites] + [m[0] for m in merges],
           "losers 删除前原文 + 改写/合并页改前原文")
    # 复验 Minor：token 不走命令行（ps/历史泄漏面），改环境变量 WIKI_TOKEN
    token = os.environ.get("WIKI_TOKEN") or login_default()
    for i, (p, new, _) in enumerate(rewrites):
        put_page(token, p["path"], new, json.loads(p["frontmatter"]) if p["frontmatter"] else None)
        if (i + 1) % 50 == 0:
            print(f"  改写进度 {i+1}/{len(rewrites)}")
    for kp, new_content, fm_sources, _ in merges:
        fm = json.loads(kp["frontmatter"]) if kp["frontmatter"] else {}
        # E2 后 title/type/images 缺键补全统一在 put_page 出口（以服务端现值填）；
        # 幸存页 type 归一 concept 是执行显式步（charter §五），此处只保真。
        # 复验 Minor：sources 并集变了就必须写，即使内容未变
        fm_changed = sorted(fm.get("sources") or []) != sorted(fm_sources)
        fm["sources"] = fm_sources
        put_page(token, kp["path"], new_content, fm, skip_if_same=not fm_changed)
    ok = fail = 0
    for lp in losers_all:
        try:
            st = delete_page(token, lp)
            ok += 1 if st == 204 else 0
            if st == 404:
                print(f"  [404] {lp}（本就不存在）")
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {lp}: {e}")
    print(f"批②完成：改写 {len(rewrites)} 页、合并 {len(merges)} canonical、删除 {ok} loser（{fail} 失败）")


# ---------------- 批③ ----------------
FM_LEADING = re.compile(r"\A---\s*\n[\s\S]*?\n---\s*\n?")

def meaningful_chars(md):
    body = FM_LEADING.sub("", md)
    body = re.sub(r"^#{1,6}\s.*$", "", body, flags=re.M)      # 标题行
    body = re.sub(r"\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]", lambda m: m.group(2) or m.group(1), body)
    body = re.sub(r"[*_`>\-\|\[\]()#]", "", body)
    return len(re.sub(r"\s", "", body))

def cmd_plan_mini(args):
    fresh_dump()
    pages = load_pages()
    cands = []
    for p in pages:
        if p["page_type"] not in ("concept", "entity"):
            continue
        mc = meaningful_chars(p["content"])
        if len(p["content"]) < 300 and mc < 40:
            cands.append((p, mc))
    cands.sort(key=lambda x: x[1])
    print(f"迷你残渣候选 {len(cands)} 页（<300 字且有效正文 <40 字符）：")
    for p, mc in cands:
        print(f"  [{mc:3d}] {p['path']} | {p['content'][:60].replace(chr(10), ' / ')}")
    json.dump([p["path"] for p, _ in cands], open("/tmp/.mini_purge.json", "w"))
    print(f"清单已写 /tmp/.mini_purge.json（{'加 --execute 才删' if not args.execute else ''}）")


def cmd_purge(args):
    paths = json.load(open(args.list))
    fresh_dump()
    pages = {p["path"]: p for p in load_pages()}
    rows = [pages[p] for p in paths if p in pages]
    print(f"{'EXECUTE' if args.execute else 'DRY-RUN'}：将删除 {len(rows)} 页")
    if not args.execute:
        for p in rows:
            print(f"  {p['path']} | {p['content'][:60].replace(chr(10), ' / ')}")
        return
    backup("mini-purge", rows, "删除前原文；误删可依 frontmatter+content 经 API 重建")
    token = os.environ.get("WIKI_TOKEN") or login_default()
    ok = fail = 0
    for p in rows:
        try:
            delete_page(token, p["path"])
            ok += 1
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {p['path']}: {e}")
    print(f"批③删除完成：{ok} 成功，{fail} 失败。随后跑 backfill-links 清理入链新悬空。")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backfill-links"); b.add_argument("--execute", action="store_true")
    sub.add_parser("plan-merge")
    m = sub.add_parser("merge"); m.add_argument("--plan", required=True); m.add_argument("--execute", action="store_true")
    mi = sub.add_parser("plan-mini"); mi.add_argument("--execute", action="store_true")
    pu = sub.add_parser("purge"); pu.add_argument("--list", required=True); pu.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    {"backfill-links": cmd_backfill, "plan-merge": cmd_plan_merge, "merge": cmd_merge,
     "plan-mini": cmd_plan_mini, "purge": cmd_purge}[args.cmd](args)


if __name__ == "__main__":
    main()

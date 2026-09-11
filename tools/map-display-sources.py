#!/usr/bin/env python3
"""map-display-sources.py — I9 显示名 sources 确定性映射（评审 §一 I9 立项）。

背景：教材源文件首行约定 `> 来源：<BookDir> · <FileStem>`，摄取时 LLM 把该行
抄进 frontmatter sources → 库内大量显示名形态条目（可读可溯、非路径）。显示名
就是路径的伪装：`X · Y` ⟺ `raw/sources/X/Y.md`，映射完全确定，无需匹配器。

规则：
  1. `A · B` → `raw/sources/A/B.md`，(A,B) 须在盘上索引中；
  2. 思维导图式 stem 带全角括号后缀（`Ch01-…（…导图）`）→ 截 `（` 后再试；
  3. MANUAL_FIXES：盘上核验过的历史手误显示名（如 Look-Teachers-1 → Level1）；
  4. 裸书名（无 ` · `，如 `TKT-Course-Module-1-2-3`）：书级出处、无文件精度，
     v1 不动，只报账；
  5. 命中条目替换为路径；路径已在数组中则仅去重（不重复插入）；其余条目保序
     不动；frontmatter.sources 同步。

用法：
  python3 map-display-sources.py --dry-run            # 产 i9-mapping.csv（只读）
  python3 map-display-sources.py --v3 --dry-run       # v3 确定解（§九 I-1 三修）
  python3 map-display-sources.py --v4 --dry-run       # v4 四族规则（§十一 处方 3）
  python3 map-display-sources.py --apply <冻结mapping> # I1c：只消费显式冻结件
输出：~/kb-dumps/20260911-sources-backfill/{i9*-mapping-<时间戳>,i9*-misses-<时间戳>}.csv
（时间戳产物名：固定名无条件覆写曾把已应用的冻结件自毁为空，§十一跟进封堵）
"""
import argparse, csv, io, json, re, subprocess, sys
from datetime import datetime
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]

# 盘上核验过的历史手误显示名 → 正确路径（2026-09-11 逐一 ls + 来源行复核）
MANUAL_FIXES = {
    "Look-Teacher-Starter · Ch09-unit-7-my-family": "raw/sources/Look-Teachers-Starter/Ch09-unit-7-my-family.md",
    "Look-Teachers-1 · Ch02-welcome": "raw/sources/Look-Teachers-Level1/Ch02-welcome.md",
}

def _norm(s):
    """stem 归一化：小写、空白/下划线→连字符、去尾标点。（v2 语义不变，保 --v2 可复现）"""
    s = s.strip().lower().replace("_", "-")
    s = re.sub(r"\s+", "-", s)
    return s.rstrip("-.,：:；;。")

def build_transcript_index():
    idx = set()
    for f in (ROOT / "sources/transcripts").glob("*.md"):
        idx.add(f.name)
    return idx

def resolve_v2(entry, disk_by_book, disk_all, transcripts):
    """v2 确定解（§八 v2 材料：书名最长前缀切分 + stem 归一化，零歧义门）。

    三层，全部要求目标盘上存在且唯一命中；返回 path 或 None：
      T1 <Book><sep><rest>    书名最长前缀切分，rest 归一化后与该书章 stem
                              精确或唯一前缀匹配（唯一前缀=恰 1 个 stem 以
                              归一化 rest 为前缀）
      T2 <Book>/<stem>[.md]   半路径补全（raw/ 前缀与 .md 后缀）
      T3 孤儿 .md/转写名      sources/transcripts/<name>[.md] 存在即映射
    """
    books = sorted(disk_by_book.keys(), key=len, reverse=True)
    book = next((b for b in books if entry == b or entry.startswith(b)), None)
    if book:
        rest = entry[len(book):]
        if rest[:1] in (" ", "-", "_", "·", "：", ":", "—"):
            rest = rest[1:].strip()
        if rest:
            stems = disk_by_book[book]          # {norm: real_stem}
            n = _norm(rest)
            hits = [s for k, s in stems.items() if k == n]
            if not hits:
                cand = [s for k, s in stems.items() if k.startswith(n)] if len(n) >= 4 else []
                if len(cand) == 1:
                    hits = cand
            if len(hits) == 1:
                return f"raw/sources/{book}/{hits[0]}.md"
            return None
        return None
    # T2 半路径：<Book>/<stem>[.md]
    if "/" in entry and not entry.endswith("/"):
        cand = f"raw/sources/{entry}.md" if not entry.endswith(".md") else f"raw/sources/{entry}"
        if (ROOT / cand).exists():
            return cand
        return None
    # T3 孤儿 .md / 无后缀转写名
    if entry.endswith(".md") and entry in transcripts:
        return f"sources/transcripts/{entry}"
    if not entry.endswith(".md") and f"{entry}.md" in transcripts:
        return f"sources/transcripts/{entry}.md"
    return None

def _split_book(entry, books):
    """大小写不敏感最长前缀切分；返回 (book, rest)。rest 已剥前导分隔符与尾部
    .md、未归一化；裸书名 rest=""；无书前缀 book=None。（v3/v4 共用解析）"""
    el = entry.lower()
    book = next((b for b in books if el.startswith(b.lower())), None)
    if not book:
        return None, None
    rest = entry[len(book):]
    if rest[:1] in (" ", "-", "_", "/", "·", "：", ":", "—"):
        rest = rest[1:].strip()
    if rest:
        rest = re.sub(r"\.md$", "", rest, flags=re.IGNORECASE)   # v3 ②
    return book, rest

def resolve_v3(entry, books, disk_by_book, transcripts):
    """v3 确定解（评审 §九 I-1 三修）：在 v2 门限语义上修三处——

      ① T1 stem 失配不再提前 return，落 T2/T3 兜底（v2 中 T2 贡献 0 的死代码根因，
         实锺机制=v2 分隔符表漏 `/`，`Book/stem` 形态的 rest 带前导斜杠必然失配）；
      ② rest 尾部 .md 先剥再归一化（`Book_Ch16-x.md` 形态 x~30；在 rest 上施行而非
         _norm 内，保 _norm v2 语义不动）；
      ③ 书名前缀匹配大小写不敏感（`think-teachers-l0-…` 形态 x~30）。
    分隔符表补 `/`（T1 直吃半路径形态，T2 保持 byte-exact 兜底）。
    books=按名长降序预排序的书名清单（调用方一次排序，勿逐 entry 重算）。
    门限不变：目标盘上存在 + 精确或唯一前缀命中；裸书名（entry==book）仍策略性不动。
    """
    book, rest = _split_book(entry, books)
    if book and not rest:
        return None                      # 裸书名：书级出处无文件精度，不动
    if book and rest:
        n = _norm(rest)
        if n:
            stems = disk_by_book[book]
            hits = [s for k, s in stems.items() if k == n]
            if not hits:
                cand = [s for k, s in stems.items() if k.startswith(n)] if len(n) >= 4 else []
                if len(cand) == 1:
                    hits = cand
            if len(hits) == 1:
                return f"raw/sources/{book}/{hits[0]}.md"
        # T1 失败 → 落 T2/T3（v3 ①），不再提前 return
    # T2 半路径：<Book>/<stem>[.md]（前导 / 非半路径——否则产出 raw/sources//… 畸形串）
    if "/" in entry and not entry.startswith("/") and not entry.endswith("/"):
        cand = f"raw/sources/{entry}" if entry.endswith(".md") else f"raw/sources/{entry}.md"
        if (ROOT / cand).exists():
            return cand
    # T3 孤儿 .md / 无后缀转写名
    if entry.endswith(".md") and entry in transcripts:
        return f"sources/transcripts/{entry}"
    if not entry.endswith(".md") and f"{entry}.md" in transcripts:
        return f"sources/transcripts/{entry}.md"
    return None

def resolve_v4(entry, books, disk_by_book, transcripts):
    """v4 四族规则（评审 §十一 处方 3）：v3 漏收的四类残渣，各立各形，全部要求
    构造/变换候选在书内唯一命中（盘上存在门不变）；v3 规则先行，v4 只接 v3 漏——

      R1 冒号标题尾   rest 截断至首个冒号再匹配（`… Ch04 Unit 2: Spending Money`）
      R2 unit 缺连字符 unit(\\d) → unit-\\d 变体精确命中（`…ch10-unit8.md`）
      R3 ETK-pp 构造  ChNN[ part-P] pp.A-B → ChNN-part-NN-pp-A-B（part 号==章号，
                      pp 区间逐字对应；盘上 ETK 命名即此形）
      R4 think2e 孤儿名 think2e-lN-videoscripts → 书内 ch*-lN-videoscripts 唯一
    """
    m = resolve_v3(entry, books, disk_by_book, transcripts)
    if m:
        return m
    # R4：书前缀不匹配的孤儿名，形态自锚书
    mv = re.match(r"^think2e-l(\d+)-videoscripts(\.md)?$", entry.lower())
    if mv:
        stems = disk_by_book.get("Think2e-Teaching-Notes", {})
        hits = [s for k, s in stems.items()
                if re.fullmatch(rf"ch\d+-l{mv.group(1)}-videoscripts", k)]
        if len(hits) == 1:
            return f"raw/sources/Think2e-Teaching-Notes/{hits[0]}.md"
        return None
    book, rest = _split_book(entry, books)
    if not book or not rest:
        return None
    stems = disk_by_book[book]
    # R1：冒号截断（截断发生在归一化前，冒号属标题尾非 stem 内容）
    mcut = re.split(r"[:：]", rest, maxsplit=1)[0]
    if mcut != rest:
        n = _norm(mcut)
        if n:
            hits = [s for k, s in stems.items() if k == n]
            if not hits and len(n) >= 4:
                cand = [s for k, s in stems.items() if k.startswith(n)]
                if len(cand) == 1:
                    hits = cand
            if len(hits) == 1:
                return f"raw/sources/{book}/{hits[0]}.md"
    n = _norm(rest)
    if not n:
        return None
    # R2：unit 后缺连字符
    n2 = re.sub(r"unit(\d)", r"unit-\1", n)
    if n2 != n:
        hits = [s for k, s in stems.items() if k == n2]
        if len(hits) == 1:
            return f"raw/sources/{book}/{hits[0]}.md"
    # R3：ETK-pp 结构构造（构造即单候选，存在门==唯一门）
    mp = re.match(r"^ch(\d+)(?:-part-(\d+))?-pp\.?(\d+)-(\d+)$", n)
    if mp:
        chap, part = mp.group(1), mp.group(2) or mp.group(1)
        constructed = f"ch{int(chap):02d}-part-{int(part):02d}-pp-{mp.group(3)}-{mp.group(4)}"
        hits = [s for k, s in stems.items() if k == constructed]
        if len(hits) == 1:
            return f"raw/sources/{book}/{hits[0]}.md"
    return None

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def build_index():
    idx = set()
    for f in (ROOT / "raw/sources").glob("*/*.md"):
        idx.add((f.parent.name, f.stem))
    return idx

def build_disk_by_book():
    """{book: {norm_stem: real_stem}}（v2 T1 匹配用）。"""
    out = {}
    for f in (ROOT / "raw/sources").glob("*/*.md"):
        out.setdefault(f.parent.name, {})[_norm(f.stem)] = f.stem
    return out

def resolve(entry, disk):
    """返回 mapped path 或 None。"""
    if entry in MANUAL_FIXES:
        return MANUAL_FIXES[entry]
    if " · " not in entry:
        return None
    book, stem = entry.split(" · ", 1)
    stem = stem.strip()
    if (book, stem) in disk:
        return f"raw/sources/{book}/{stem}.md"
    cut = stem.split("（")[0]
    if cut != stem and (book, cut) in disk:
        return f"raw/sources/{book}/{cut}.md"
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--v2", action="store_true",
                    help="确定性扩展层：最长前缀切分+stem 归一化+唯一命中门（§八 v2 材料）")
    ap.add_argument("--v3", action="store_true",
                    help="确定性扩展层 v3（§九 I-1 三修）：T1 失配落 T2/T3 + rest 剥尾部 .md "
                         "+ 书名匹配大小写不敏感 + 分隔符补 /")
    ap.add_argument("--v4", action="store_true",
                    help="确定性扩展层 v4（§十一 处方 3，四族规则）：冒号截断 / unit 补连字符 / "
                         "ETK-pp 构造 / think2e videoscripts 孤儿名；v3 规则先行")
    ap.add_argument("--apply", metavar="冻结mapping")
    ap.add_argument("--verify", metavar="mapping.csv",
                    help="映射校验（诚实分账，§九 C-1）：raw 目标=来源行实检；"
                         "transcripts 目标=文件名身份映射（转写为 frontmatter 形态、"
                         "无来源行，只证存在性，不冒充来源行互证）")
    args = ap.parse_args()
    if not args.dry_run and not args.apply and not args.verify:
        sys.exit("refusing: 需显式 --dry-run / --apply <冻结mapping> / --verify <mapping.csv>")

    if args.verify:
        # §九 C-1 勘误后的诚实校验器：两类目标分账，不混计数。
        # §十 I-1：目标缺失/空首行/空归一化 display 一律 FAIL——空串 startswith
        # 恒真是假通过洞（本数据集未触发，与「诚实分账」宗旨相悖故修）。
        def norm_verify(s):
            s = s.strip().lstrip(">").strip()
            s = re.sub(r"^来源[:：]\s*", "", s)
            s = re.sub(r"\.md\s*$", "", s, flags=re.IGNORECASE)   # display 尾 .md 非来源行内容（v3 ② 同族）
            s = s.lower().replace("·", "-")
            s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", s)
            return re.sub(r"-{2,}", "-", s).strip("-")
        rows = list(csv.DictReader(open(args.verify)))
        raw_pass = raw_fail = tid = t_missing = 0
        fails = []
        for r in rows:
            m = r["mapped"]
            if m.startswith("raw/sources/"):
                nd = norm_verify(r["display"])
                src = ROOT / m
                if not src.exists():
                    raw_fail += 1
                    fails.append((r["path"], r["display"][:50], m[:60], "<missing>"))
                    continue
                line = src.read_text(errors="replace").split("\n", 1)[0]
                nl = norm_verify(line)
                if not nd or not nl:
                    raw_fail += 1
                    fails.append((r["path"], r["display"][:50], m[:60], f"empty-norm line={nl!r} disp={nd!r}"))
                elif nl.startswith(nd) or nd.startswith(nl):
                    raw_pass += 1
                else:
                    raw_fail += 1
                    fails.append((r["path"], r["display"][:50], m[:60], nl[:60]))
            else:
                # 文件名身份映射：转写文件无来源行（frontmatter 形态，全库 898
                # 个转写含「来源：」行者 0）——存在性即身份，单独计账
                if (ROOT / m).exists():
                    tid += 1
                else:
                    t_missing += 1
                    fails.append((r["path"], r["display"][:50], m[:60], "<transcript-missing>"))
        print(f"raw 来源行实检: {raw_pass} pass / {raw_fail} fail")
        print(f"transcripts 文件名身份: {tid} pass / {t_missing} missing")
        for f in fails[:10]:
            print("  FAIL", f)
        return

    disk = build_index()
    suffix = "-v4" if args.v4 else ("-v3" if args.v3 else ("-v2" if args.v2 else ""))
    pages = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, sources FROM wiki_pages "
        "WHERE project_id=614 AND NOT path LIKE 'wiki/%' AND jsonb_typeof(sources)='array' "
        "AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(sources) e "
        "WHERE e <> '' AND NOT e LIKE 'sources/%' AND NOT e LIKE 'raw/%')) t"))

    if args.dry_run:
        mapping, misses, bare = [], [], 0
        # 产物带时间戳（§十一 Important 跟进）：固定名无条件覆写曾把已应用的
        # 冻结件自毁为空（执行后复核性 dry-run 事故）——时间戳名从类上封堵；
        # 同秒重跑以 .k 后缀唯一化，绝不覆写既有产物
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        tag = f"i9{suffix}-{ts}"
        k = 0
        while (OUT / f"{tag}-mapping.csv").exists():
            k += 1
            tag = f"i9{suffix}-{ts}.{k}"
        if args.v2 or args.v3 or args.v4:
            disk_by_book = build_disk_by_book()
            transcripts = build_transcript_index()
            books_sorted = sorted(disk_by_book.keys(), key=len, reverse=True)
            reason = "unresolved" + suffix
            def resolve_ext(e):
                if args.v4:
                    return resolve_v4(e, books_sorted, disk_by_book, transcripts)
                if args.v3:
                    return resolve_v3(e, books_sorted, disk_by_book, transcripts)
                return resolve_v2(e, disk_by_book, disk, transcripts)
            for pg in pages:
                for e in pg["sources"]:
                    if not e or e.startswith(("sources/", "raw/")) or e == "source.md":
                        continue
                    m = resolve(e, disk) or resolve_ext(e)
                    if m:
                        mapping.append({"path": pg["path"], "display": e, "mapped": m})
                    else:
                        misses.append([pg["path"], e, reason])
        else:
            for pg in pages:
                for e in pg["sources"]:
                    if not e or e.startswith(("sources/", "raw/")):
                        continue
                    m = resolve(e, disk)
                    if m:
                        mapping.append({"path": pg["path"], "display": e, "mapped": m})
                    elif " · " in e:
                        misses.append([pg["path"], e, "unresolved"])
                    else:
                        bare += 1
        map_csv = OUT / f"{tag}-mapping.csv"
        with open(map_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["path", "display", "mapped"])
            w.writeheader(); w.writerows(mapping)
        with open(OUT / f"{tag}-misses.csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["path", "display", "reason"]); w.writerows(misses)
        print(f"mapping: {len(mapping)} 条（页级 {len({m['path'] for m in mapping})}）| "
              f"misses: {len(misses)} | 裸书名（不动）: {bare}")
        print("->", map_csv)
        return

    # —— apply：只消费显式冻结 mapping；页级备份先行；union 去重替换 ——
    frozen = Path(args.apply)
    if not frozen.exists():
        sys.exit(f"refusing: 冻结件不存在 {frozen}")
    fixes = {}
    for r in csv.DictReader(open(frozen)):
        fixes.setdefault(r["path"], {})[r["display"]] = r["mapped"]
    print(f"consumed frozen {frozen.name}: {len(fixes)} 页")
    a = ",".join("'%s'" % p.replace("'", "''") for p in fixes)
    q = (f"COPY (SELECT path,title,page_type,frontmatter,sources,content FROM wiki_pages "
         f"WHERE project_id=614 AND path IN ({a})) TO STDOUT WITH CSV")
    r = subprocess.run(["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki",
                        "-d", "llmwiki", "-c", q], capture_output=True, text=True)
    r.check_returncode()
    backup = OUT / f"{frozen.stem}-before.csv"   # 备份随冻结件命名，不再覆写历史件
    backup.write_text(r.stdout + "\n")
    rows = list(csv.reader(io.StringIO(r.stdout)))
    assert all(len(x) == 6 for x in rows) and len(rows) == len(fixes), \
        (len(rows), sorted({len(x) for x in rows}))
    print("before-backup ok:", len(rows))

    done = dedup = 0
    for x in rows:
        p, old = x[0], json.loads(x[4])
        table = fixes.get(p, {})
        new, seen = [], set()
        for e in old:
            m = table.get(e)
            if m is None:
                v = e
            else:
                v = m
            if v in seen:
                dedup += 1
                continue
            seen.add(v)
            new.append(v)
        newj = json.dumps(new, ensure_ascii=False).replace("'", "''")
        q = (f"UPDATE wiki_pages SET sources='{newj}'::jsonb, "
             f"frontmatter=jsonb_set("
             f"CASE WHEN jsonb_typeof(coalesce(frontmatter,'{{}}'::jsonb))='object' "
             f"THEN coalesce(frontmatter,'{{}}'::jsonb) ELSE '{{}}'::jsonb END, "
             f"'{{sources}}','{newj}'::jsonb) "
             f"WHERE project_id=614 AND path='{p.replace(chr(39), chr(39)*2)}'")
        psql(q)
        done += 1
    print(f"executed: {done} 页（去重 {dedup} 条）")

if __name__ == "__main__":
    main()

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
  python3 map-display-sources.py --apply <冻结mapping> # I1c：只消费显式冻结件
输出：~/kb-dumps/20260911-sources-backfill/{i9-mapping,i9-misses}.csv
"""
import argparse, csv, io, json, re, subprocess, sys
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
    """stem 归一化：小写、空白/下划线→连字符、去尾标点。"""
    import re
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
    ap.add_argument("--apply", metavar="冻结mapping")
    ap.add_argument("--verify", metavar="mapping.csv",
                    help="映射校验（诚实分账，§九 C-1）：raw 目标=来源行实检；"
                         "transcripts 目标=文件名身份映射（转写为 frontmatter 形态、"
                         "无来源行，只证存在性，不冒充来源行互证）")
    args = ap.parse_args()
    if not args.dry_run and not args.apply and not args.verify:
        sys.exit("refusing: 需显式 --dry-run / --apply <冻结mapping> / --verify <mapping.csv>")

    if args.verify:
        # §九 C-1 勘误后的诚实校验器：两类目标分账，不混计数
        def norm_verify(s):
            s = s.strip().lstrip(">").strip()
            s = re.sub(r"^来源[:：]\s*", "", s)
            s = s.lower().replace("·", "-")
            s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", s)
            return re.sub(r"-{2,}", "-", s).strip("-")
        rows = list(csv.DictReader(open(args.verify)))
        raw_pass = raw_fail = tid = 0
        fails = []
        for r in rows:
            m = r["mapped"]
            if m.startswith("raw/sources/"):
                src = ROOT / m
                line = src.read_text(errors="replace").split("\n", 1)[0] if src.exists() else ""
                nl, nd = norm_verify(line), norm_verify(r["display"])
                if nl.startswith(nd) or nd.startswith(nl):
                    raw_pass += 1
                else:
                    raw_fail += 1
                    fails.append((r["path"], r["display"], m, nl[:60], nd[:60]))
            else:
                # 文件名身份映射：转写文件无来源行（frontmatter 形态，全库 898
                # 个转写含「来源：」行者 0）——存在性即身份，单独计账
                tid += 1 if (ROOT / m).exists() else 0
        print(f"raw 来源行实检: {raw_pass} pass / {raw_fail} fail")
        print(f"transcripts 文件名身份: {tid}/{sum(1 for r in rows if r['mapped'].startswith('sources/transcripts/'))}")
        for f in fails[:10]:
            print("  FAIL", f)
        return

    disk = build_index()
    suffix = "-v2" if args.v2 else ""
    pages = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, sources FROM wiki_pages "
        "WHERE project_id=614 AND NOT path LIKE 'wiki/%' AND jsonb_typeof(sources)='array' "
        "AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(sources) e "
        "WHERE e <> '' AND NOT e LIKE 'sources/%' AND NOT e LIKE 'raw/%')) t"))

    if args.dry_run:
        mapping, misses, bare = [], [], 0
        if args.v2:
            disk_by_book = build_disk_by_book()
            transcripts = build_transcript_index()
            for pg in pages:
                for e in pg["sources"]:
                    if not e or e.startswith(("sources/", "raw/")) or e == "source.md":
                        continue
                    m = resolve(e, disk) or resolve_v2(e, disk_by_book, disk, transcripts)
                    if m:
                        mapping.append({"path": pg["path"], "display": e, "mapped": m})
                    else:
                        misses.append([pg["path"], e, "unresolved-v2"])
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
        with open(OUT / f"i9{suffix}-mapping.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["path", "display", "mapped"])
            w.writeheader(); w.writerows(mapping)
        with open(OUT / f"i9{suffix}-misses.csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["path", "display", "reason"]); w.writerows(misses)
        print(f"mapping: {len(mapping)} 条（页级 {len({m['path'] for m in mapping})}）| "
              f"misses: {len(misses)} | 裸书名（不动）: {bare}")
        print("->", OUT / f"i9{suffix}-mapping.csv")
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
    (OUT / "i9-apply-before.csv").write_text(r.stdout + "\n")
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

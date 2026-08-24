#!/usr/bin/env python3
"""按书签 outline 拆章（spec §3）：目标 ≤40k token/章（pypdf 提取字符/4 估算），
超预算二分；无书签用 --ranges 人工页区间表。产出 ChNN-<slug>.pdf + manifest.json。
用法：python3 tools/books/split_chapters.py <book.pdf> <out_dir> <book_slug> \
        [--ranges ranges.json] [--top-level-only]
（书签嵌套时 --top-level-only 只取顶层章；默认全展开）"""
import argparse, json, re, sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter

TOKEN_BUDGET = 40_000

def page_chars(reader, i):
    try:
        return len((reader.pages[i].extract_text() or "").strip())
    except Exception:
        return 0

def outline_entries(reader, top_only=False):
    out = []
    def walk(items, depth=0):
        for it in items:
            if isinstance(it, list):
                if not top_only:
                    walk(it, depth + 1)
            else:
                try:
                    out.append((it.title, reader.get_destination_page_number(it)))
                except Exception:
                    pass
    try:
        walk(reader.outline)
    except Exception:
        pass
    return out

def slugify(t):
    s = re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").lower()
    return s[:60] or "untitled"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("out_dir"); ap.add_argument("slug")
    ap.add_argument("--ranges"); ap.add_argument("--top-level-only", action="store_true")
    a = ap.parse_args()
    reader = PdfReader(a.pdf)
    n = len(reader.pages)
    if a.ranges:
        ranges = json.loads(Path(a.ranges).read_text())
        # 边界校验（终审 F3）：from-1=-1 会走 Python 负索引把书末页静默混进 Ch01；
        # 越界值中途 IndexError 且 manifest 只在结尾写（已拆 PDF 与 manifest 不一致）。
        for r in ranges:
            f, t = r.get("from"), r.get("to")
            if not (isinstance(f, int) and isinstance(t, int) and 1 <= f <= t <= n):
                sys.exit(f"--ranges 条目非法或越界: {r.get('title', '?')} from={f} to={t}（须为整数且 1<=from<=to<={n}）")
        chapters = [(r["title"], r["from"] - 1, r["to"] - 1) for r in ranges]
    else:
        entries = outline_entries(reader, a.top_level_only)
        if not entries:
            sys.exit("无书签且未给 --ranges；请人工页区间表")
        chapters = []
        for i, (title, start) in enumerate(entries):
            end = (entries[i + 1][1] - 1) if i + 1 < len(entries) else n - 1
            if end >= start:
                chapters.append((title, start, end))
    book_dir = Path(a.out_dir) / a.slug
    book_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"book": a.slug, "total_pages": n, "chapters": []}
    idx = 0
    for title, start, end in chapters:
        queue = [(start, end, None)]
        while queue:
            s, e, part = queue.pop(0)
            est = sum(page_chars(reader, p) for p in range(s, e + 1)) / 4
            if est > TOKEN_BUDGET and s < e:
                mid = (s + e) // 2
                queue = [(s, mid, part or 1), (mid + 1, e, (part or 1) + 1)] + queue
                continue
            idx += 1
            name = f"Ch{idx:02d}-{slugify(title)}" + (f"-p{part}" if part else "") + ".pdf"
            w = PdfWriter()
            for p in range(s, e + 1):
                w.add_page(reader.pages[p])
            w.write(book_dir / name)
            manifest["chapters"].append({
                "file": name, "title": title, "from_page": s + 1, "to_page": e + 1,
                "est_tokens": int(est),
            })
            print(f"[{idx}] {name}: pp.{s+1}-{e+1} ~{int(est)} tok")
    (book_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"manifest: {book_dir / 'manifest.json'}")

if __name__ == "__main__":
    main()

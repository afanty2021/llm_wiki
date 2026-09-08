#!/usr/bin/env python3
"""redlink-audit.py — 概念图谱红链测量（版本化，2026-09-08 立项计划 §3 实施首步）。

双表面忠实复刻（语义来源，改解析器必须同步这里 + golden 用例）：
  SERVER  src-server/src/services/graph.rs   extract_wikilinks(:210) normalize_stem(:92)
          build_title_to_path(:122)（title 碰撞组整组排除）
  DESKTOP src/lib/wiki-graph.ts              WIKILINK_REGEX targetAliases(:120)
          resolveTarget(:406) extractTitle(:90 三分支)/buildTitleIndex(:435)

输入：wiki_pages 全量导出 CSV（与 COPY 语句同格式，6 列取前 4 必需）：
  docker exec -i src-server-postgres-1 psql -U llmwiki -d llmwiki -c \\
    "\\copy (SELECT path,title,page_type,content FROM wiki_pages WHERE project_id=614) TO '/tmp/lt_pages.csv' WITH (FORMAT csv)"
用法：
  python3 tools/redlink-audit.py --input /tmp/lt_pages.csv            # 人读摘要
  python3 tools/redlink-audit.py --input ... --json out.json          # 机器报告
  python3 tools/redlink-audit.py --golden                             # 内嵌用例自测
依赖：pyyaml（frontmatter 解析镜像 TS parseFrontmatter）。验收口径（计划 §3）：
红链率分母=链接实例、只测新摄取源、服务端/桌面双表面都报；基线 9.4%（2026-09-08 快照 8724 页）。
"""
import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

csv.field_size_limit(32 * 1024 * 1024)

# ---------------------------------------------------------------- 链接提取（两表面正则差异是语义的一部分）
RE_SERVER = re.compile(r"\[\[([^\]|\n]+?)(?:\|[^\]]+)?\]\]")   # graph.rs extract_wikilinks：排除换行
RE_DESKTOP = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]")   # wiki-graph.ts WIKILINK_REGEX


def extract_links_server(content):
    return [m.group(1).strip() for m in RE_SERVER.finditer(content)]


def extract_links_desktop(content):
    return [m.group(1).strip() for m in RE_DESKTOP.finditer(content)]


# ---------------------------------------------------------------- frontmatter（镜像 TS parseFrontmatter）
FM_STRICT = re.compile(r"\A---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|\Z)")


def parse_frontmatter(content):
    m = FM_STRICT.match(content)
    if m is None or yaml is None:
        return None
    try:
        parsed = yaml.safe_load(m.group(1))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def fm_str(fm, key):
    """extractTitle/extractType 只认非空字符串（数字/列表/None 视为缺失）。"""
    if not fm:
        return None
    v = fm.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


HEADING_RE = re.compile(r"^#\s+(.+)$", re.M)


def desktop_label(content, file_name):
    """extractTitle 三分支：frontmatter title → 正文首个 `# ` 标题（全库 label 主源）→ 文件名。
    r1 测量 bug 根因：只实现分支一（818 页），漏掉分支二（7898 页）→ title 救回误测 23（实为 ~1000）。"""
    fm = parse_frontmatter(content)
    t = fm_str(fm, "title")
    if t:
        return t
    m = HEADING_RE.search(content)
    if m:
        return m.group(1).strip()
    return re.sub(r"\.md$", "", file_name).replace("-", " ")


# ---------------------------------------------------------------- 归一化
def norm_server(s):
    """graph.rs normalize_stem：lowercase + 空格→'-'（不折叠多空格）。"""
    return s.lower().replace(" ", "-")


def norm_desktop(s):
    """TS 侧 title 键：trim().toLowerCase() 后 \\s+ → '-'（折叠）。"""
    return re.sub(r"\s+", "-", s.strip().lower())


def stem_of(path):
    return re.sub(r"\.md$", "", path.rsplit("/", 1)[-1])


# ---------------------------------------------------------------- 单表面测量
def measure(rows, surface):
    """rows: [(path,title,page_type,content)]；surface: 'server'|'desktop'。"""
    extract = extract_links_server if surface == "server" else extract_links_desktop
    pages = [r for r in rows if r[2] != "query"]  # graph 口径排除 query 类型

    stem_to_path = {}
    for r in pages:
        stem_to_path.setdefault(norm_server(stem_of(r[0])), r[0])  # stem 重复取首个（§11 #6）

    title_groups = defaultdict(list)
    for r in pages:
        label = desktop_label(r[3], stem_of(r[0])) if surface == "desktop" else (r[1] or "").strip()
        if label:
            key = norm_desktop(label) if surface == "desktop" else norm_server(label)
            title_groups[key].append(r[0])
    title_to_path = {k: v[0] for k, v in title_groups.items() if len(v) == 1}  # 碰撞组整组排除
    colliding = {k for k, v in title_groups.items() if len(v) > 1}

    instances = resolved_stem = resolved_title = 0
    self_links = 0
    dangling = Counter()
    for r in pages:
        path, content = r[0], r[3]
        for raw in extract(content):
            instances += 1
            k = norm_server(raw) if surface == "server" else norm_desktop(raw)
            tgt = stem_to_path.get(k)
            how = "stem"
            if tgt is None:
                tgt = title_to_path.get(k)
                how = "title"
            if tgt is not None:
                if tgt == path:
                    self_links += 1
                    continue
                if how == "stem":
                    resolved_stem += 1
                else:
                    resolved_title += 1
                continue
            dangling[raw.strip()] += 1

    total_resolved = resolved_stem + resolved_title
    inst = instances - total_resolved - self_links
    return {
        "surface": surface,
        "pages": len(pages),
        "instances": instances,
        "resolved_stem": resolved_stem,
        "resolved_title": resolved_title,
        "dangling_instances": inst,
        "dangling_rate_pct": round(inst * 100 / max(instances, 1), 2),
        "dangling_unique": len(dangling),
        "title_collisions": len(colliding),
        "top_dangling": dangling.most_common(30),
    }


# ---------------------------------------------------------------- 悬空分类（评审 §三 分类表，服务端口径）
CJK = re.compile(r"[\u4e00-\u9fff]")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SHA8 = re.compile(r"-[0-9a-f]{8}$")


def classify(raw, colliding_keys):
    r = raw.strip()
    if CJK.search(r):
        if norm_server(r) in colliding_keys:
            return "title_exists_but_colliding"
        return "cjk_title_missing"
    if "/" in r:
        return "path_form"
    if r.lower() in ("wikilink", "wikilinks") or "http" in r.lower():
        return "degenerate"
    if SLUG_RE.match(r.lower()):
        return "slug_sha8" if SHA8.search(r.lower()) else "slug_selfcreated"
    if any(ch in r for ch in "(&:. "):
        return "en_bare_title_punct"
    return "en_bare_title"


def classify_report(rows):
    pages = [r for r in rows if r[2] != "query"]
    stem_to_path = {}
    for r in pages:
        stem_to_path.setdefault(norm_server(stem_of(r[0])), r[0])
    groups = defaultdict(list)
    for r in pages:
        t = (r[1] or "").strip()
        if t:
            groups[norm_server(t)].append(r[0])
    title_to_path = {k: v[0] for k, v in groups.items() if len(v) == 1}
    colliding = {k for k, v in groups.items() if len(v) > 1}

    cls = Counter()
    unique = defaultdict(set)
    for r in pages:
        for raw in extract_links_server(r[3]):
            k = norm_server(raw)
            if stem_to_path.get(k) or title_to_path.get(k):
                continue
            c = classify(raw, colliding)
            cls[c] += 1
            unique[c].add(raw.lower())
    return {"cls_instances": dict(cls), "cls_unique": {k: len(v) for k, v in unique.items()}}


# ---------------------------------------------------------------- 白名单容量估算（处方 A）
def whitelist_size_estimates(rows, cap=2000):
    wl = sorted((r[0] for r in rows if r[0].startswith(("concepts/", "entities/"))))[:cap]
    cur = sum(len("- " + p) + 1 for p in wl)
    slugs = [stem_of(p) for p in wl]
    comp_ns = sum(len(s) + 1 for s in slugs) + 24
    cs = Counter(stem_of(r[0]) for r in rows if r[0].startswith("concepts/"))
    es = Counter(stem_of(r[0]) for r in rows if r[0].startswith("entities/"))
    return {
        "wl_entries": len(wl),
        "current_fmt_chars": cur,
        "compressed_ns_chars": comp_ns,
        "coverage_pct": round(len(wl) * 100 / max(len(wl) + max(0, len(rows) - len(wl) - sum(1 for r in rows if not r[0].startswith(("concepts/", "entities/")))), 1), 1),
        "shared_stems_concepts_entities": len(set(cs) & set(es)),
    }


# ---------------------------------------------------------------- 迷你页口径（r2 写死：<300 content 字符）
def mini_pages(rows, threshold=300):
    ce = [len(r[3]) for r in rows if r[0].startswith(("concepts/", "entities/"))]
    co = [len(r[3]) for r in rows if r[0].startswith("concepts/")]
    return {
        "concepts_entities_total": len(ce),
        "concepts_entities_lt300": sum(1 for n in ce if n < threshold),
        "concepts_only_total": len(co),
        "concepts_only_lt300": sum(1 for n in co if n < threshold),
    }


# ---------------------------------------------------------------- golden 自测（内嵌用例，无外部文件）
GOLDEN_ROWS = [
    # path, title, page_type, content
    ("concepts/pre-class-preview-strategy.md", "课前预习策略", "concept",
     "# 课前预习策略\n\n指导学生课前完成预习任务的教学策略，参见 [[课前预习策略]] 与 [[Mary]]。"),
    ("entities/mary.md", "Mary", "entity", "# Mary\n\nLT 师训课程讲师。"),
    ("transcripts/儿歌分享-What-s-your-favourite-color-f30ce801.md", "儿歌分享：What's your favourite color", "transcript",
     "---\ntitle: \"儿歌分享：What's your favourite color\"\n---\n\n## [00:00] 歌曲热身\n歌词条目 [[What's your favourite color]]。"),
    ("entities/collide-a.md", "双胞胎标题", "entity", "# 双胞胎标题\nA 页。"),
    ("entities/collide-b.md", "双胞胎标题", "entity", "# 双胞胎标题\nB 页。"),
    ("concepts/demo-lesson.md", "示范课", "concept",
     "# 示范课\n\n悬空形态全集：[[university-listening-lesson-jean]] [[entities/our-dreams-lesson.md]] "
     "[[TKT (Teaching Knowledge Test)]] [[输出倒逼练习]] [[wikilink]] [[case-1234abcd]] "
     "[[Mary]] [[双胞胎标题]] [[pre-class-preview-strategy]]。\n跨源 title 救回：参见 [[课前预习策略]]。"),
]


def run_golden():
    rows = [list(r) for r in GOLDEN_ROWS]
    srv = measure(rows, "server")
    dsk = measure(rows, "desktop")
    # 断言一：中文标题链接经 title 索引救回（r1 测量 bug 的回归钉）
    assert srv["resolved_title"] == 1, f"title 救回应为 1：{srv}"
    # 断言二：stem 别名（大小写）救回 [[Mary]]×2 与 [[pre-class-preview-strategy]]
    assert srv["resolved_stem"] == 3, f"stem 救回应为 3：{srv}"
    # 断言三：悬空实例 = 8（lesson 自创/path_form/TKT 标点/中文缺失/wikilink 退化/sha8 形/双胞胎标题碰撞/儿歌裸歌名）
    assert srv["dangling_instances"] == 8, f"悬空应为 8：{srv}"
    cls = classify_report(rows)
    assert cls["cls_instances"].get("slug_selfcreated") == 1
    assert cls["cls_instances"].get("path_form") == 1
    assert cls["cls_instances"].get("en_bare_title_punct") == 2  # TKT(...) + 儿歌歌名（含空格）
    assert cls["cls_instances"].get("cjk_title_missing") == 1
    assert cls["cls_instances"].get("degenerate") == 1
    assert cls["cls_instances"].get("slug_sha8") == 1
    # 断言四：title 碰撞组排除——[[双胞胎标题]] 悬空且归类为 colliding
    assert cls["cls_instances"].get("title_exists_but_colliding") == 1
    # 断言五：桌面正则与分支同过（双表面一致）
    assert dsk["dangling_instances"] == srv["dangling_instances"], (dsk, srv)
    print("golden: 全部断言通过（title 救回/stem 别名/碰撞排除/七类悬空形态/双表面一致）")


def main():
    ap = argparse.ArgumentParser(description="概念图谱红链测量（双表面忠实解析）")
    ap.add_argument("--input", help="wiki_pages 导出 CSV（见文件头 COPY 语句）")
    ap.add_argument("--json", help="机器报告输出路径")
    ap.add_argument("--golden", action="store_true", help="运行内嵌用例自测")
    args = ap.parse_args()
    if args.golden:
        run_golden()
        return
    if not args.input:
        ap.error("--input 必填（或 --golden）")
    with open(args.input, newline="", encoding="utf-8") as f:
        rows = [row[:4] for row in csv.reader(f)]
    srv = measure(rows, "server")
    dsk = measure(rows, "desktop")
    report = {
        "server": srv,
        "desktop": dsk,
        "classification": classify_report(rows),
        "whitelist": whitelist_size_estimates(rows),
        "mini_pages": mini_pages(rows),
    }
    print(f"SERVER 悬空 {srv['dangling_instances']}/{srv['instances']} = {srv['dangling_rate_pct']}% "
          f"(unique {srv['dangling_unique']}, title 救回 {srv['resolved_title']})")
    print(f"DESKTOP 悬空 {dsk['dangling_instances']}/{dsk['instances']} = {dsk['dangling_rate_pct']}% "
          f"(unique {dsk['dangling_unique']}, title 救回 {dsk['resolved_title']})")
    print("分类:", json.dumps(report["classification"]["cls_instances"], ensure_ascii=False))
    print("迷你页:", json.dumps(report["mini_pages"], ensure_ascii=False))
    print("白名单:", json.dumps(report["whitelist"], ensure_ascii=False))
    for t, c in srv["top_dangling"][:10]:
        print(f"  {c:4d}  {t[:60]}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print(f"JSON 报告 → {args.json}")


if __name__ == "__main__":
    main()

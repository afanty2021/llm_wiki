#!/usr/bin/env python3
"""backfill-sources.py — sources 坏值回填（占位符 "source.md" / 空数组）。
匹配器三 tier（确定性、同页可复跑）：
  T1 行探测：页内取最长 12 条规范化行（≥24 字符），在 1196 个源文件规范化文本中
     子串命中计分 = 命中探测字符数/总探测字符数；
  T2 拉丁专名投票（T1 best<0.3 时）：页内拉丁词（≥4 字母，去停用词）在源文的
     命中率（QC 溯源同款探针，'s/复数归一）；
  T3 字符 bigram 容积（T2 仍无 ≥0.3 候选时）：页采样 bigram 集 vs 源**全集合**
     （stride 1；C2a——源侧采样使 containment 数学上限 ≈1/7<0.6，tier 永不可达）。
     三级都取同一判定规则：
       best≥0.6 且 best-second≥0.15 → 单源；best≥0.5 且 second≥0.4 → 双源并集；
       否则 unresolved（人工）。
规范化：剥 wikilink 目标/标记符/全部空白 + lower（CJK 友好）。
写入值：项目相对路径（如 sources/transcripts/x.md、raw/sources/Slug/x.md），
frontmatter 同步 jsonb_set。范围：project 614；wiki/ 命名空间永不触碰。
评审基线：docs/superpowers/plans/2026-09-11-sources-attribution-fix.md（2026-09-11
评审 C2/I1c/I5/I6/M4/M5 修订版，冻结）。"""
import argparse, csv, json, re, subprocess, sys
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"  # M5（评审）：审计证据不落 /tmp
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]
# I5（评审）：补教材高频词压同书异章伪双源（look/think 系教材系列名，逐章出现、无章级区分度）
STOP = set("the and that with this from they their have will your what when about which there these those into more also some them then than each other where while being were students student lesson teachers look think unit word picture practice read write say talk play class school story english book".split())

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()  # I6（评审）：UPDATE 失败静默则「零 SQL 报错」验收不可验证——失败即中止（已备份可重跑幂等）
    return r.stdout.strip()

def norm(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    s = re.sub(r"[\[\]#>*`]|---", " ", s)
    return re.sub(r"\s+", "", s).lower()

def latin_tokens(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    toks = re.findall(r"[A-Za-z][A-Za-z'’\-]{3,}", s)
    out = []
    for w in toks:
        b = w.lower().strip("'’").replace("'s", "")
        b = b[:-1] if b.endswith("s") and len(b) > 4 else b
        if b not in STOP and len(b) >= 4:
            out.append(b)
    return out

def load_corpus():
    files = {}
    for p in ROOT.rglob("*.md"):
        rel = str(p.relative_to(ROOT))
        files[rel] = p.read_text(encoding="utf-8", errors="replace")
    return files

def normed_lines(raw):
    return [norm(l) for l in raw.split("\n") if len(norm(l)) >= 24]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True, parents=True)
    if args.execute:
        # I1c（评审）：执行只消费已评审的 mapping.csv——本分支不触达匹配逻辑，
        # 重算=覆写审计证据=评审失效；文件缺失即拒执行。
        mp = OUT / "mapping.csv"
        if not mp.exists():
            sys.exit("refusing: mapping.csv 不存在——先 --dry-run 并完成人工评审，再 --execute")
        with open(mp, newline="") as f:
            rows = list(csv.DictReader(f))
        with open(OUT / "affected-rows.csv", "w") as f:
            for i in range(0, len(rows), 200):
                a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows[i:i+200])
                f.write(psql(f"COPY (SELECT path,title,page_type,frontmatter,sources,content FROM wiki_pages "
                             f"WHERE project_id=614 AND path IN ({a})) TO STDOUT WITH CSV"))
        done = 0
        for r in rows:
            newj = json.dumps(json.loads(r["new"]), ensure_ascii=False).replace("'", "''")
            # frontmatter 可能为 jsonb null/标量（全库 48 页，jsonb_set 拒绝非对象）——
            # 非对象时从 {} 起步再 set（与护栏 M8 语义对齐且更完整）
            q = (f"UPDATE wiki_pages SET sources='{newj}'::jsonb, "
                 f"frontmatter=jsonb_set("
                 f"CASE WHEN jsonb_typeof(coalesce(frontmatter,'{{}}'::jsonb))='object' "
                 f"THEN frontmatter ELSE '{{}}'::jsonb END, "
                 f"'{{sources}}','{newj}'::jsonb) "
                 f"WHERE project_id=614 AND path='{r['path'].replace(chr(39), chr(39)*2)}'")
            psql(q)
            done += 1
        print("executed:", done)
        return
    # —— 以下为 --dry-run 匹配路径（--execute 已提前 return，不可达）——
    broken = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, coalesce(sources::text,'') old, "
        "title, content FROM wiki_pages WHERE project_id=614 AND NOT path LIKE 'wiki/%' "
        "AND (sources IS NULL OR sources='[]'::jsonb OR sources::text LIKE '%\"source.md\"%')) t"))
    print("broken pages:", len(broken))
    corpus = load_corpus()
    # C2a（评审，处方升级）：源侧第三槽位存全规范化文本，T3 时惰性建全集合 bigram。
    # 源侧采样（原 stride 7）使 containment 数学上限 ≈1/7<0.6 判定线，tier 永不可达；
    # 「两侧同 stride」在偏移子串场景仍退化（页文本在源文件起始偏移 k 非 stride 整数
    # 倍时两侧采样错位）。源侧必须全集合（stride 1），页侧采样任意；全集合每 T3 页
    # 现算不缓存（1196 文件 ≈15-30s/页，T3 页少数，可接受）。
    prepared = {rel: (normed_lines(raw), set(latin_tokens(raw)), norm(raw))
                for rel, raw in corpus.items()}
    rows, unresolved = [], []
    for pg in broken:
        content = pg["content"]
        probes = sorted({norm(l) for l in content.split("\n") if len(norm(l)) >= 24},
                        key=len, reverse=True)[:12]
        probe_chars = sum(len(p) for p in probes) or 1
        scores = {}
        for rel, (lines, _, _) in prepared.items():
            hit = 0
            joined = "\n".join(lines)  # 每文件拼一次子串搜索
            for p in probes:
                if p in joined:
                    hit += len(p)  # C2b（评审）：命中与计分同口径——24 字符前缀撞车不得全长分
            if hit:
                scores[rel] = hit / probe_chars
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        best = ranked[0] if ranked else None
        second = ranked[1] if len(ranked) > 1 else None
        tier = "T1"
        if not best or best[1] < 0.3:
            toks = set(latin_tokens(content))
            scores2 = {}
            if toks:
                for rel, (_, lat, _) in prepared.items():
                    inter = len(toks & lat)
                    if inter:
                        scores2[rel] = inter / len(toks)
            ranked2 = sorted(scores2.items(), key=lambda x: -x[1])
            tier = "T2"
            best, second = (ranked2[0], ranked2[1] if len(ranked2) > 1 else None) if ranked2 else (None, None)
        if not best or best[1] < 0.3:
            pnorm = norm(content)
            bg = {pnorm[i:i+2] for i in range(len(pnorm) - 1)}
            scores3 = {}
            tier = "T3"
            for rel, (_, _, ftext) in prepared.items():
                fb = {ftext[i:i+2] for i in range(len(ftext) - 1)}  # C2a：源侧全集合，每页现算
                inter = len(bg & fb)
                if inter:
                    scores3[rel] = inter / len(bg)
            ranked3 = sorted(scores3.items(), key=lambda x: -x[1])
            best, second = (ranked3[0], ranked3[1] if len(ranked3) > 1 else None) if ranked3 else (None, None)
        # 停线调阈值（2026-09-11 首轮干跑抽审 4/23 不合格 >2/30 触发）：
        # 原「best≥0.5 且 second≥0.4 → 双源并集」分支删除——首轮实测近并列
        # （margin<0.15）行双源分配不可靠（真源可能在 rank-2，rank-1 也可能是
        # 同书异章泛词伪源），近并列=探针无法区分的信号，一律落 unresolved 人工处置。
        if best and best[1] >= 0.6 and (not second or best[1] - second[1] >= 0.15):
            new = [best[0]]
        else:
            unresolved.append({"path": pg["path"], "best": best and best[0],
                               "score": best and best[1], "tier": tier})
            continue
        rows.append({"path": pg["path"], "old": pg["old"],
                     "new": json.dumps(new, ensure_ascii=False),
                     "score": round(best[1], 3),
                     "margin": round(best[1] - (second[1] if second else 0), 3), "tier": tier})
    # 形态断言（评审 I1 验收线）：new 列必须 100% 项目相对路径形态
    bad_form = [r for r in rows
                if not (r["new"].startswith('["sources/transcripts/') or r["new"].startswith('["raw/sources/'))]
    if bad_form:
        sys.exit(f"assertion failed: {len(bad_form)} rows with non project-relative new values, e.g. {bad_form[:3]}")
    with open(OUT / "mapping.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "old", "new", "score", "margin", "tier"])
        w.writeheader()
        w.writerows(rows)
    with open(OUT / "unresolved.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "best", "score", "tier"])
        w.writeheader()
        w.writerows(unresolved)
    print(f"mapped: {len(rows)}  unresolved: {len(unresolved)}  (mapping.csv / unresolved.csv in {OUT})")

if __name__ == "__main__":
    main()

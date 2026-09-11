#!/usr/bin/env python3
"""recheck-window-attribution.py — 窗口归因复核（CJK 感知评分器）。

背景（2026-09-11 人工批第一轮评审 §四 C-2）：resolve-unresolved-window 的探针
只有拉丁词元/行级信号，对中文改写页零命中——判定实质只靠词元重叠，小词元集
（≤5）单词元命中即得 1.0 假置信，≥19 例确认错归因。本工具以 CJK 信号重裁决：

  s_big   页 CJK 字符 bigram（全集合）对候选源 bigram 全集合的 containment
          —— 源侧全集合，规避 T3 stride 死亡问题（方案评审 C2a 同源）
  s_term  页显著性中文主题词（run 抽取、题名加权×3、泛词表过滤）在候选源的
          出现覆盖率——可解释、可 grep 验证

  comb    = max(s_line, s_tok, s_big, s_term)（沿用既有四信号取 max 语义）

裁决：
  KEEP            chosen 为 rank-1 或差距 < MARGIN
  SWAP-PROPOSE    rank-1 领先 ≥ MARGIN 且 chosen 弱（≤0.3）——须人工 grep 复核后执行
  NO-SIGNAL       全候选 comb < 0.15——真源可能不在候选集（评审 I-3：Bing/CNN/NCE
                  存在不落 ingest_jobs 的写入通道），或页面前置残缺；勿强行归因
  CHOSEN-STRONG   chosen 非.rank-1 但自身强（>0.3）——保守保留，列观察

只读分析，不写库；执行走带备份手工 SQL（同 I7 渠道，见 20260911 补修报告 §八）。
用法：
  python3 recheck-window-attribution.py --target executed   # 复核已执行 429 行
  python3 recheck-window-attribution.py --target proposal   # proposal-v3 冻结件全量（含 AMBIGUOUS/NO-WINDOW）
"""
import argparse, csv, json, math, re, subprocess
from collections import Counter
from datetime import timedelta
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]
MARGIN = 0.15
STRONG = 0.3
SIGNAL_FLOOR = 0.15

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()
    return r.stdout.strip()

def norm(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    s = re.sub(r"[\[\]#>*`]|---", " ", s)
    return re.sub(r"\s+", "", s).lower()

def latin_tokens(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    toks = re.findall(r"[A-Za-z][A-Za-z'’\-]{3,}", s)
    out = []
    stop = set("the and that with this from they their have will your what when about which there "
               "these those into more also some them then than each other where while being were "
               "students student lesson teachers look think unit word picture practice read write "
               "say talk play class school story english book".split())
    for w in toks:
        b = w.lower().strip("'’").replace("'s", "")
        b = b[:-1] if b.endswith("s") and len(b) > 4 else b
        if b not in stop and len(b) >= 4:
            out.append(b)
    return out

# 泛词表：教学话语通用词，出现面太广无判别力（词汇/语法/阅读等学科词虽主题相关
# 但几乎每份转写都有，同样无判别力——一并过滤，判别力交给具体术语与 bigram）
CJK_STOP = set("""学生 教师 老师 课堂 学习 教学 活动 语言 英语 视频 同学 练习 讨论 问题 例子
目标 步骤 材料 方法 策略 能力 知识 内容 重点 难点 环节 组织 引导 反馈 评价 小组 同伴 任务
设计 过程 分享 交流 表达 理解 掌握 运用 提升 发展 培养 基础 核心 单元 课程 教材 课本 板书
游戏 故事 词汇 语法 阅读 听力 写作 口语 拼读 单词 句子 段落 文章 标题 图片 表格 清楚 明白
正确 错误 简单 复杂 容易 困难 重要 开始 结束 时间 分钟 今天 我们 大家 自己 可以 可能 应该
需要 觉得 喜欢 尝试 完成 进行 通过 让我 这个 那个 什么 怎么 为什么 如果 但是 然后 所以
一个 两个 一些 很多 非常 真的 其实 现在 这里 那里 时候 因为 而且 或者 例如 比如 首先 其次
最后 总之 接下来 接着 一下 一点 一样 不同 相同 类似 常见 常用 一般 通常 特别 主要 基本
直接 间接 有效 无效 主动 被动 积极 消极 正式 非正式""".split())

def cjk_runs(s):
    return re.findall(r"[\u4e00-\u9fff]{2,}", s)

def page_terms(content, title):
    """显著性中文主题词：run 抽取 + 频次 + 泛词过滤；题名 run 权重 ×3。"""
    weights = Counter()
    for run in cjk_runs(content):
        if 2 <= len(run) <= 8 and run not in CJK_STOP:
            weights[run] += 1
    for run in cjk_runs(title):
        if run not in CJK_STOP:
            weights[run] += 3
    return weights

def bigrams(s):
    s = "".join(cjk_runs(s))
    return {s[i:i + 2] for i in range(len(s) - 1)}

def load_jobs():
    """M-1 修正：按 project_id 过滤（105 作业实测全 614，latent 防御）。"""
    blob = psql("SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT id::text id, created_at::text ca, "
                "started_at::text sa, finished_at::text fa, to_jsonb(source_paths) sp "
                "FROM ingest_jobs WHERE project_id=614 AND (source_paths::text LIKE '%sources/transcripts/%' "
                "OR source_paths::text LIKE '%raw/sources/%')) t")
    from datetime import datetime
    def dt(s):
        return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))
    parsed = []
    for j in json.loads(blob):
        paths = [x for x in j["sp"] if isinstance(x, str)
                 and (x.startswith("sources/transcripts/") or x.startswith("raw/sources/"))]
        if not paths:
            continue
        start = dt(j["sa"] or j["ca"])
        end = dt(j["fa"]) if j["fa"] not in (None, "", "NULL") else start + timedelta(minutes=40)
        parsed.append((start - timedelta(seconds=60), end, {c for c in paths if c.endswith(".md")}))
    return parsed

def window_candidates(created_at, parsed_jobs):
    t = created_at
    cands = set()
    for lo, hi, paths in parsed_jobs:
        if lo <= t <= hi:
            cands |= paths
    return sorted(cands)

def main():
    from datetime import datetime
    def dt(s):
        return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["executed", "proposal"], required=True)
    args = ap.parse_args()
    prop = list(csv.DictReader(open(OUT / "proposal-v3.csv")))
    if args.target == "executed":
        rows = [r for r in prop if r["class"] in ("STRUCTURAL-SINGLE", "PROBE-RESOLVED")]
    else:
        rows = prop
    print(f"target={args.target}: {len(rows)} rows")

    # 页现值（content/created_at/title 实时取库； sources 不参与评分）
    a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows)
    pages = {p["path"]: p for p in json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, title, created_at::text ca, content "
        f"FROM wiki_pages WHERE project_id=614 AND path IN ({a})) t"))}
    print("pages loaded:", len(pages))

    parsed_jobs = load_jobs()
    print("jobs:", len(parsed_jobs))

    cache = {}  # rel -> (raw, joined_lines, lat_set, big_set, text)
    def source_stats(rel):
        if rel not in cache:
            f = ROOT / rel
            if not f.exists():
                cache[rel] = None
            else:
                raw = f.read_text(encoding="utf-8", errors="replace")
                joined = "\n".join(norm(l) for l in raw.split("\n") if len(norm(l)) >= 24)
                cache[rel] = (raw, joined, set(latin_tokens(raw)), bigrams(raw), raw)
        return cache[rel]

    out = []
    for r in rows:
        p = r["path"]
        pg = pages.get(p)
        if not pg:
            out.append({"path": p, "verdict": "MISSING-PAGE"})
            continue
        title, content = pg["title"] or "", pg["content"] or ""
        terms = page_terms(content, title)
        wsum = sum(terms.values()) or 1
        pnorm = norm(content)
        pbg = bigrams(content)
        toks = set(latin_tokens(content))
        probes = sorted({norm(l) for l in content.split("\n") if len(norm(l)) >= 24}, key=len, reverse=True)[:12]
        probe_chars = sum(len(x) for x in probes) or 1
        ntok = len(toks)

        cands = window_candidates(dt(pg["ca"]), parsed_jobs)
        scored = []
        for c in cands:
            st = source_stats(c)
            if not st:
                continue
            raw, joined, lat, bg, text = st
            s_line = sum(len(x) for x in probes if x in joined) / probe_chars
            s_tok = (len(toks & lat) / len(toks)) if toks else 0.0
            s_big = (len(pbg & bg) / len(pbg)) if pbg else 0.0
            # 主题词计分带源内频次（log 截顶 3）：专源深谈（连读×23）须压过
            # 大而全文件泛提（连读×4）——presence-only 评分在 word-connection
            # 案例上把泛读练习排到了专注源前面（2026-09-11 复核现场修正）
            num = sum(w * min(1 + math.log10(text.count(t)), 3)
                      for t, w in terms.items() if text.count(t))
            s_term = num / (wsum * 3)
            scored.append((c, round(s_line, 3), round(s_tok, 3),
                           round(s_big, 3), round(s_term, 3)))
        # 中文改写页以 CJK 信号裁决；s_tok 对小词元集有单词元满分假置信
        # （评审 C-2），只留诊断列、不入排序键。英文源窗口（Think TN 等）
        # CJK 恒 0：全候选 CJK<0.05 时回落词元/行级，但 ntok<8 的小词元集
        # 无排序资格 → NO-SIGNAL（宁缺勿错）
        cjk_page = len(pbg) >= 20
        cjk_best = max((max(x[3], x[4]) for x in scored), default=0.0)
        use_latin = cjk_page and cjk_best < 0.05
        def rank_key(x):
            if use_latin:
                return max(x[1], x[2]) if ntok >= 8 else 0.0
            return max(x[3], x[4]) if cjk_page else max(x[1], x[2])
        scored.sort(key=lambda x: -rank_key(x))
        chosen = r["chosen"]
        ch = next((x for x in scored if x[0] == chosen), None)
        ch_comb = round(rank_key(ch), 3) if ch else 0.0
        rank1 = scored[0] if scored else None
        if not scored:
            verdict = "NO-CANDIDATE-ON-DISK"
        elif not rank1 or rank_key(rank1) < SIGNAL_FLOOR:
            verdict = "NO-SIGNAL"
        elif ch and ch[0] == rank1[0]:
            verdict = "KEEP"
        elif ch_comb <= STRONG and rank_key(rank1) - ch_comb >= MARGIN:
            verdict = "SWAP-PROPOSE"
        else:
            verdict = "CHOSEN-STRONG"
        out.append({"path": p, "class": r["class"], "title": title, "ntok": ntok,
                    "cjk_page": cjk_page,
                    "chosen": chosen, "chosen_comb": ch_comb,
                    "chosen_line": ch[1] if ch else "", "chosen_tok": ch[2] if ch else "",
                    "chosen_big": ch[3] if ch else "", "chosen_term": ch[4] if ch else "",
                    "rank1": rank1[0] if rank1 else "",
                    "rank1_comb": round(rank_key(rank1), 3) if rank1 else "",
                    "rank1_line": rank1[1] if rank1 else "", "rank1_tok": rank1[2] if rank1 else "",
                    "rank1_big": rank1[3] if rank1 else "", "rank1_term": rank1[4] if rank1 else "",
                    "cands_scored": len(scored), "verdict": verdict,
                    "window_jobs": r.get("window_jobs", "")})

    fout = OUT / ("recheck-executed.csv" if args.target == "executed" else "recheck-proposal.csv")
    with open(fout, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    from collections import Counter
    print("verdicts:", dict(Counter(o["verdict"] for o in out)))
    print("->", fout)

if __name__ == "__main__":
    main()

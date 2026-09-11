#!/usr/bin/env python3
"""recheck-window-attribution.py — 窗口归因复核（CJK 感知评分器·单一副本）。

背景（2026-09-11 人工批第一轮评审 §四 C-2）：resolve-unresolved-window 的探针
只有拉丁词元/行级信号，对中文改写页零命中——判定实质只靠词元重叠，小词元集
（≤5）单词元命中即得 1.0 假置信，≥19 例确认错归因。本工具以 CJK 信号重裁决：

  s_big   页 CJK 字符 bigram（全集合）对候选源 bigram 全集合的 containment
          —— 源侧全集合，规避 T3 stride 死亡问题（方案评审 C2a 同源）
  s_term  页显著性中文主题词（run 抽取、题名加权×3、泛词表过滤）在候选源的
          频次加权覆盖率（log 截顶 3）——专源深谈须压过大而全文件泛提
  comb    中文改写页（CJK bigram ≥20）= max(s_big, s_term)；s_tok 只留诊断列
          （小词元集单词元满分假置信，不入排序键）。英文源窗口 CJK 全零时
          回落词元/行级，ntok<8 无排序资格（宁缺勿错）。

裁决（§五 I-1 拆分后）：
  KEEP            chosen 为 rank-1 或差距 < MARGIN
  SWAP-PROPOSE    rank-1 领先 ≥ MARGIN 且 chosen 弱（≤STRONG）——须人工 grep 复核后执行
  CHOSEN-STRONG   chosen 非 rank-1 但自身强（>STRONG）——保守保留，列观察
  NEAR-TIE        chosen 弱（≤STRONG）且 rank-1 领先不足 MARGIN——近并列，
                  桶语义=「评分器分不出」，弱证据滞留种群，交 embedding 轮复核
  NO-SIGNAL       全候选 comb < SIGNAL_FLOOR——真源可能不在候选集（评审 I-3），
                  或页面前置残缺；勿强行归因

本文件同时是评分器单一副本（§五 I-2）：resolve-unresolved-window 经 importlib
复用 score_page/load_jobs/window_candidates 与有名常量，公式与门限不二写。

用法：
  python3 recheck-window-attribution.py --target executed               # 复核已执行 429 行
  python3 recheck-window-attribution.py --target proposal               # 冻结件全量
  python3 recheck-window-attribution.py --target executed --from xxx.csv # 指定冻结件（默认 proposal-v3.csv）
"""
import argparse, csv, json, math, re, subprocess
from collections import Counter
from datetime import timedelta, datetime
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]
MARGIN = 0.15
STRONG = 0.3
SIGNAL_FLOOR = 0.15
ATTR_FLOOR = 0.3         # 归属门：comb ≥ 此值才算「可归因候选」（resolver 的
                         # PROBE-RESOLVED/AMBIGUOUS 类门）。与 SIGNAL_FLOOR（裁决
                         # 观察地板）数值近、语义不同——§五 I-2 单一副本也要各用各名
ATTR_MARGIN = 0.1        # 归属领先门（v1 起窗解析的 PR 判定 margin）。与 MARGIN
                         # （SWAP-PROPOSE 裁决门 0.15）语义不同，勿互用
CJK_PAGE_FLOOR = 20      # 页 CJK bigram 数 ≥ 此值视为中文改写页
LATIN_NTOK_FLOOR = 8     # 英文源窗口回落词元排序所需最小词元数

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
    for run in cjk_runs(content or ""):
        if 2 <= len(run) <= 8 and run not in CJK_STOP:
            weights[run] += 1
    for run in cjk_runs(title or ""):
        if run not in CJK_STOP:
            weights[run] += 3
    return weights

def bigrams(s):
    s = "".join(cjk_runs(s))
    return {s[i:i + 2] for i in range(len(s) - 1)}

def load_jobs():
    """窗口作业表。M-1 修正：按 project_id 过滤。返回 (lo, hi, paths, job_id) 四元组。"""
    blob = psql("SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT id::text id, created_at::text ca, "
                "started_at::text sa, finished_at::text fa, to_jsonb(source_paths) sp "
                "FROM ingest_jobs WHERE project_id=614 AND (source_paths::text LIKE '%sources/transcripts/%' "
                "OR source_paths::text LIKE '%raw/sources/%')) t")

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
        parsed.append((start - timedelta(seconds=60), end,
                       {c for c in paths if c.endswith(".md")}, j["id"]))
    return parsed

def window_candidates(created_at, parsed_jobs):
    """返回 (排序候选清单, 命中作业 id 逗号串)。"""
    t = created_at
    cands, ids = set(), []
    for lo, hi, paths, jid in parsed_jobs:
        if lo <= t <= hi:
            cands |= paths
            ids.append(jid)
    return sorted(cands), ",".join(sorted({i[:8] for i in ids}))

def score_page(content, title, cands, cache):
    """CJK 感知评分（评分器单一副本）。

    cache: rel -> 不存在的键缺失 | None(盘上无) | (raw, joined_lines, lat_set, big_set)
    返回 dict:
      scored  [(file, s_line, s_tok, s_big, s_term)] 按 rank_key 降序
      rank_key(fn) / ntok / cjk_page / use_latin
    """
    title = title or ""
    content = content or ""
    terms = page_terms(content, title)
    wsum = sum(terms.values()) or 1
    pbg = bigrams(content)
    toks = set(latin_tokens(content))
    ntok = len(toks)
    probes = sorted({norm(l) for l in content.split("\n") if len(norm(l)) >= 24},
                    key=len, reverse=True)[:12]
    probe_chars = sum(len(x) for x in probes) or 1

    scored = []
    for c in cands:
        if c not in cache:
            f = ROOT / c
            if not f.exists():
                cache[c] = None
            else:
                raw = f.read_text(encoding="utf-8", errors="replace")
                joined = "\n".join(norm(l) for l in raw.split("\n") if len(norm(l)) >= 24)
                cache[c] = (raw, joined, set(latin_tokens(raw)), bigrams(raw))
        st = cache.get(c)
        if not st:
            continue
        raw, joined, lat, bg = st
        s_line = sum(len(x) for x in probes if x in joined) / probe_chars
        s_tok = (len(toks & lat) / len(toks)) if toks else 0.0
        s_big = (len(pbg & bg) / len(pbg)) if pbg else 0.0
        # 主题词计分带源内频次（log 截顶 3）：专源深谈（连读×23）须压过
        # 大而全文件泛提（连读×4）——presence-only 评分在 word-connection
        # 案例上把泛读练习排到了专注源前面（2026-09-11 复核现场修正）
        num = sum(w * min(1 + math.log10(raw.count(t)), 3)
                  for t, w in terms.items() if raw.count(t))
        s_term = num / (wsum * 3)
        scored.append((c, round(s_line, 3), round(s_tok, 3), round(s_big, 3), round(s_term, 3)))

    cjk_page = len(pbg) >= CJK_PAGE_FLOOR
    cjk_best = max((max(x[3], x[4]) for x in scored), default=0.0)
    use_latin = cjk_page and cjk_best < 0.05

    def rank_key(x):
        if use_latin:
            return max(x[1], x[2]) if ntok >= LATIN_NTOK_FLOOR else 0.0
        return max(x[3], x[4]) if cjk_page else max(x[1], x[2])

    scored.sort(key=lambda x: -rank_key(x))
    return {"scored": scored, "rank_key": rank_key, "ntok": ntok,
            "cjk_page": cjk_page, "use_latin": use_latin}

def main():
    def dt(s):
        return datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["executed", "proposal"], required=True)
    ap.add_argument("--from", dest="from_csv", default=str(OUT / "proposal-v3.csv"),
                    help="冻结件路径（默认 proposal-v3.csv；不再硬编码）")
    args = ap.parse_args()

    prop = list(csv.DictReader(open(args.from_csv)))
    if args.target == "executed":
        rows = [r for r in prop if r["class"] in ("STRUCTURAL-SINGLE", "PROBE-RESOLVED")]
    else:
        rows = prop
    print(f"target={args.target} from={Path(args.from_csv).name}: {len(rows)} rows")

    a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows)
    pages = {p["path"]: p for p in json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, title, created_at::text ca, content "
        f"FROM wiki_pages WHERE project_id=614 AND path IN ({a})) t"))}
    print("pages loaded:", len(pages))

    parsed_jobs = load_jobs()
    print("jobs:", len(parsed_jobs))

    cache = {}
    out = []
    for r in rows:
        p = r["path"]
        pg = pages.get(p)
        if not pg:
            out.append({"path": p, "verdict": "MISSING-PAGE"})
            continue
        cands, wjobs = window_candidates(dt(pg["ca"]), parsed_jobs)
        sc = score_page(pg["content"], pg["title"], cands, cache)
        scored, rank_key, ntok = sc["scored"], sc["rank_key"], sc["ntok"]
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
        elif ch_comb > STRONG:
            verdict = "CHOSEN-STRONG"
        else:
            # chosen 弱且 rank-1 领先不足 MARGIN：评分器分不出的近并列——
            # §五 I-1：与「chosen 自身强」拆开，此桶交 embedding 轮复核
            verdict = "NEAR-TIE"
        out.append({"path": p, "class": r["class"], "title": pg["title"] or "", "ntok": ntok,
                    "cjk_page": sc["cjk_page"],
                    "chosen": chosen, "chosen_comb": ch_comb,
                    "chosen_line": ch[1] if ch else "", "chosen_tok": ch[2] if ch else "",
                    "chosen_big": ch[3] if ch else "", "chosen_term": ch[4] if ch else "",
                    "rank1": rank1[0] if rank1 else "",
                    "rank1_comb": round(rank_key(rank1), 3) if rank1 else "",
                    "rank1_line": rank1[1] if rank1 else "", "rank1_tok": rank1[2] if rank1 else "",
                    "rank1_big": rank1[3] if rank1 else "", "rank1_term": rank1[4] if rank1 else "",
                    "cands_scored": len(scored), "verdict": verdict,
                    "window_jobs": r.get("window_jobs", "") or wjobs})

    fout = OUT / ("recheck-executed.csv" if args.target == "executed" else "recheck-proposal.csv")
    with open(fout, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    print("verdicts:", dict(Counter(o["verdict"] for o in out)))
    print("->", fout)

if __name__ == "__main__":
    main()

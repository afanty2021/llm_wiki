#!/usr/bin/env python3
# tools/adjudicate-merge.py — 合并第二阶段：LLM 逐对语义甄别（2026-09-08 深夜）
# 候选 = 当前仍同 norm title 的实体组 + -teacher/-instructor 家族（批②甄别跳过项）。
# 对每组：打分选 tentative keep，LLM 逐成员判 same_entity（宁缺毋错判据），
# 输出 /tmp/.adjudicate_results.json 供人工复核后再进 wiki-cleanup.py merge。
# LLM 走 zai coding 通道（key 读 ~/.hermes/profiles/lt-tutor/.env，不回显不落盘）。
import json, os, re, sys, importlib.util, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(spec); spec.loader.exec_module(wc)
rla = wc.rla

API = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
MODEL = "glm-5.3-flash"
TRUNC = 1600

SUFFIX_RE = wc.SUFFIX_RE


def zai_key():
    for ln in open(os.path.expanduser("~/.hermes/profiles/lt-tutor/.env")):
        if ln.startswith("ZAI_API_KEY="):
            return ln.split("=", 1)[1].strip().strip('"')
    raise SystemExit("ZAI_API_KEY 未找到")


def llm_judge(key, a, b):
    def render(p):
        return f"[{p['path']}] title={ (p['title'] or '').strip() }\n{p['content'][:TRUNC]}"
    prompt = f"""你是知识库实体管理员。判断两个实体页是否指向【同一个现实世界实体】。
判定标准（宁缺毋错，不确定就判不同）：
- 人物：同名且身份/角色/背景一致才算同一人；同名不同人是本知识库常见现象（多课例多教师）。
- 机构/地点/作品/平台/教材：同一具体指称才算同一实体；一个是概念一个指具体实例时不算。
- 若两页描述的是不同课例/不同视频中的不同对象，即使名字相同也不是同一实体。
- 若两页明显是同一实体的不同命名变体（拼写差异/别名/后缀差异），判同一实体。

页面 A：
{render(a)}

页面 B：
{render(b)}

只输出 JSON（无其他文字）：{{"same_entity": true 或 false, "reason": "一句话中文理由"}}"""
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
        return {"same_entity": None, "reason": f"unparseable: {text[:120]}"}
    return json.loads(m.group(0))


def main():
    wc.fresh_dump()
    pages = wc.load_pages()
    stems, titles, _ = wc.build_index(pages)
    ents = [p for p in pages if p["page_type"] == "entity"]
    bynorm = defaultdict(list)
    for p in ents:
        t = (p["title"] or "").strip()
        if t:
            bynorm[rla.norm_server(t)].append(p)
    icnt = wc.inbound_counts(pages, stems, titles)

    candidates = []  # (key, members)
    seen = set()
    for k, grp in bynorm.items():
        if len(grp) >= 2:
            candidates.append((f"title:{k}", grp))
            seen |= {p["path"] for p in grp}
    fam = defaultdict(list)
    for p in ents:
        fam[SUFFIX_RE.sub("", rla.stem_of(p["path"]))].append(p)
    for k, grp in sorted(fam.items()):
        rest = [p for p in grp if p["path"] not in seen]
        if len(rest) >= 2:
            candidates.append((f"fam:{k}", rest))

    key = zai_key()
    # 断点续跑：上一轮已判定（same_entity 非 None）的对不重复调
    prev = {}
    if os.path.exists("/tmp/.adjudicate_results.json"):
        for r in json.load(open("/tmp/.adjudicate_results.json")):
            if r["same_entity"] is not None:
                prev[(r["keep"], r["member"])] = r
    results = []
    for gkey, grp in candidates:
        grp = sorted(grp, key=lambda p: wc._score(p, icnt), reverse=True)
        keep = grp[0]
        for m in grp[1:]:
            if (keep["path"], m["path"]) in prev:
                v = prev[(keep["path"], m["path"])]
            else:
                v = llm_judge(key, keep, m)
                if v.get("same_entity") is None:
                    v2 = llm_judge(key, keep, m)  # 空响应/截断重试一次
                    if v2.get("same_entity") is not None:
                        v = v2
            results.append({"group": gkey, "keep": keep["path"], "member": m["path"],
                            "same_entity": v.get("same_entity"), "reason": v.get("reason", "")})
            print(f"{'同' if v.get('same_entity') else ('?' if v.get('same_entity') is None else '异')} | {keep['path']} <-> {m['path']} | {v.get('reason','')[:80]}")
    json.dump(results, open("/tmp/.adjudicate_results.json", "w"), ensure_ascii=False, indent=1)
    n_same = sum(1 for r in results if r["same_entity"] is True)
    print(f"\n完成：{len(results)} 对，判定同一 {n_same}，不同 {len(results)-n_same}；明细 /tmp/.adjudicate_results.json")


if __name__ == "__main__":
    main()

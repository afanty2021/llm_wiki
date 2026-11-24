#!/usr/bin/env python3
"""lt-tutor 技能文本面对账：工具名 / 调用参数 / skill_view 路径 / 参数名提及 vs MCP 注册表与技能目录。

用法：python3 -I skill_face.py <mcp-registry.json> <技能目录> [<live 技能目录>] <out.md>
"""
import json
import os
import re
import sys

REG = {t["name"]: t for t in json.load(open(sys.argv[1]))}
PROPS = {n: set((t.get("schema") or {}).get("properties") or {}) for n, t in REG.items()}
REQ = {n: set((t.get("schema") or {}).get("required") or []) for n, t in REG.items()}
ALLPROPS = set().union(*PROPS.values())
DIRS = [sys.argv[2]] + ([sys.argv[3]] if len(sys.argv) > 4 and sys.argv[3] != "-" else [])
OUT = sys.argv[4] if len(sys.argv) > 4 else sys.argv[3]
W = lambda s="": out.write(s + "\n")
out = open(OUT, "w", encoding="utf-8")

# Hermes 侧非 MCP 的工具名（系统工具），出现在技能文本里属正常
SYSTEM_TOOLS = {"skill_view", "vision_analyze", "vision_ground", "send_message", "send_media", "send_file",
                "terminal", "read_file", "write_file", "browser", "cron", "delegate_task", "memory",
                "execute_code", "web_search", "web_extract", "image_gen", "search_notes", "session_search"}

files = []
for d in DIRS:
    if not d:
        continue
    for root, _, names in os.walk(d):
        for n in sorted(names):
            if n.endswith(".md"):
                rel = os.path.relpath(os.path.join(root, n), d)
                files.append((d, rel))

existing = {rel for _, rel in files} | {f"references/{rel}" for _, rel in files}
existing |= {rel for _, rel in files}

TOOL_RE = re.compile(r"\b(teacher_tutor_[a-z_]+|llm_wiki_[a-z_]+|training_overview)\b")
SKILL_FILE_RE = re.compile(r"(?<![A-Za-z0-9_./-])((?:references/)?[a-z0-9-]+\.md)\b")
PROPISH_RE = re.compile(r"`([a-z][a-z0-9_]{2,})`")
CALL_RE = re.compile(r"`?((?:teacher_tutor|llm_wiki)_[a-z_]+)\s+(\{.*)$")

W("# lt-tutor 技能文本面对账")
W(f"- 注册表：{len(REG)} 个工具（src-server 形态）；技能目录 {len(files)} 份 md")
tot = {"tools": 0, "calls": 0, "paths": 0, "props": 0}
bad = {"tools": [], "calls": [], "paths": [], "props": []}
for d, rel in files:
    tag = "live" if DIRS.index(d) > 0 else "repo"
    text = open(os.path.join(d, rel), encoding="utf-8").read()
    lines = text.split("\n")
    tools_in_file = set(TOOL_RE.findall(text))
    # ① 工具名
    for t in sorted(tools_in_file):
        tot["tools"] += 1
        if t not in REG:
            bad["tools"].append((tag, rel, t))
    # ② 期望调用：`tool {json}`（单行可解析者）
    for i, ln in enumerate(lines, 1):
        m = CALL_RE.search(ln.strip())
        if not m:
            continue
        name, raw = m.group(1), m.group(2).strip().rstrip("`")
        # 截到最后一个 '}'（行内可能跟中文说明）
        end = raw.rfind("}")
        if end < 0:
            continue
        try:
            args = json.loads(raw[: end + 1])
        except ValueError:
            continue  # 多行 JSON 或说明性文本，另由 ③ 的参数名提及兜底
        if not isinstance(args, dict):
            continue
        tot["calls"] += 1
        if name not in REG:
            bad["calls"].append((tag, rel, i, name, "工具不在注册表"))
            continue
        extra = sorted(set(args) - PROPS[name])
        missing = sorted(REQ[name] - set(args))
        if extra or missing:
            bad["calls"].append((tag, rel, i, name, f"多余参数 {extra} 缺必填 {missing}"))
    # ③ skill_view / 相对路径
    for i, ln in enumerate(lines, 1):
        for p in SKILL_FILE_RE.findall(ln):
            base = p.replace("references/", "")
            if not re.match(r"^(flow-|cfu-|lp-|worksheet-|dry-run|think-unit|parent-communication|SKILL)", base):
                continue  # 知识库页面路径等不属技能目录
            tot["paths"] += 1
            if p not in existing:
                bad["paths"].append((tag, rel, i, p))
    # ④ 反引号参数名：是注册表里某工具的参数，却不是同段（前后 3 行内）提到的任一工具的参数
    for i, ln in enumerate(lines, 1):
        for tok in set(PROPISH_RE.findall(ln)):
            if tok not in ALLPROPS:
                continue
            tot["props"] += 1
            lo, hi = max(0, i - 4), min(len(lines), i + 3)
            ctx_tools = set(TOOL_RE.findall("\n".join(lines[lo:hi])))
            if ctx_tools and not any(tok in PROPS[t] for t in ctx_tools if t in REG):
                bad["props"].append((tag, rel, i, tok, tuple(sorted(ctx_tools))))

W(f"- 工具名提及 {tot['tools']} 处：不在注册表 **{len(bad['tools'])}** 处")
for tag, rel, t in sorted(set(bad["tools"])):
    W(f"  - [{tag}] {rel}: `{t}`")
W(f"- 单行可解析的期望调用 {tot['calls']} 处：参数与注册表不符 **{len(bad['calls'])}** 处")
for tag, rel, i, name, why in bad["calls"]:
    W(f"  - [{tag}] {rel}:{i} `{name}` → {why}")
W(f"- 技能文件路径引用 {tot['paths']} 处：文件不存在 **{len(bad['paths'])}** 处")
for tag, rel, i, p in sorted(set(bad["paths"])):
    W(f"  - [{tag}] {rel}:{i} `{p}`")
W(f"- 反引号参数名提及 {tot['props']} 处：与邻近工具不符 **{len(bad['props'])}** 处（启发式，需人工看）")
for tag, rel, i, tok, ctx in sorted(set(bad["props"])):
    W(f"  - [{tag}] {rel}:{i} `{tok}` ↔ 邻近工具 {ctx}")

# ⑤ 每份文件引用了哪些工具（供看覆盖）
W("\n## 各文件引用的工具")
for d, rel in files:
    tag = "live" if DIRS.index(d) > 0 else "repo"
    text = open(os.path.join(d, rel), encoding="utf-8").read()
    ts = sorted(set(TOOL_RE.findall(text)))
    W(f"- [{tag}] {rel}（{len(text)} 字符）：{', '.join(ts) or '—'}")
out.close()
print(open(OUT, encoding="utf-8").read())

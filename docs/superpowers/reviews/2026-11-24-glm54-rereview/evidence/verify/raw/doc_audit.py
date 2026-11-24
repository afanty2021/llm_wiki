#!/usr/bin/env python3
"""文档-代码对账：对 fork 自带的嵌套 CLAUDE.md 与 docs/adr/* 做机械陈旧度体检。

对每份文档抽取：
  ① 反引号里的仓库路径（含 / 或以已知后缀结尾）→ 是否仍存在于 HEAD 树（git ls-files）
  ② 反引号里的点分标识符 a.b.c / a.b.c.f（末段小写=函数，首段大写=类）→ 按模块路径在树内 AST 索引中解析
  ③ 反引号里的裸标识符 name() / Name / name → 全树 .py 源码整词检索
只读：不 import 仓内代码。
用法：python -I doc_audit.py <Hermes 树> <out.md>
"""
import ast
import os
import re
import subprocess
import sys

ROOT = sys.argv[1]
OUT = sys.argv[2]
DOCS = sys.argv[3:]

tracked = set(subprocess.run(["git", "-C", ROOT, "ls-files"], capture_output=True, text=True).stdout.splitlines())
py_files = [f for f in tracked if f.endswith(".py")]
SKIP_DIRS = ("tests/", "tui_gateway/", "evals/", "optional-skills/", "website/", "skills/")

# 源码整词索引（非测试优先）
word_hits = {}
src_by_file = {}
for f in py_files:
    try:
        src = open(os.path.join(ROOT, f), encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        continue
    src_by_file[f] = src
    for w in set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", src)):
        word_hits.setdefault(w, []).append(f)

# AST 索引：模块路径 -> 顶层定义名
toplevel = {}
for f in py_files:
    mod = f[:-3].replace("/", ".")
    if mod.endswith(".__init__"):
        mod = mod[: -len(".__init__")]
    try:
        tree = ast.parse(src_by_file.get(f, ""))
    except SyntaxError:
        continue
    names = set()
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                names.add(a.asname or a.name.split(".")[0])
    toplevel[mod] = names
modules = set(toplevel)
for m in list(modules):
    parts = m.split(".")
    for i in range(1, len(parts)):
        modules.add(".".join(parts[:i]))


def resolve_dotted(d):
    parts = d.split(".")
    # 最长可解析的模块前缀
    for cut in range(len(parts), 0, -1):
        mod = ".".join(parts[:cut])
        if mod in modules:
            rest = parts[cut:]
            if not rest:
                return True, "module"
            names = toplevel.get(mod, set())
            if rest[0] in names:
                return True, f"{mod}.{rest[0]}"
            # 可能是包的子模块属性链（pkg.sub.func）
            for j in range(cut + 1, len(parts) + 1):
                m2 = ".".join(parts[:j])
                if m2 in modules:
                    r2 = parts[j:]
                    if not r2:
                        return True, "module"
                    if r2[0] in toplevel.get(m2, set()):
                        return True, f"{m2}.{r2[0]}"
            return False, f"{mod} 无 {rest[0]}"
    return False, "no module"


PATH_RE = re.compile(r"^(?:[\w.\-]+/)+[\w.\-]+\.(?:py|md|json|ya?ml|toml|sh|txt|js|ts)$|^(?:[\w.\-]+/)+[\w.\-]+$")
DOT_RE = re.compile(r"^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$")
WORD_RE = re.compile(r"^[A-Za-z_][\w]*\(\)?$|^[A-Za-z_][\w]*$")

out = open(OUT, "w", encoding="utf-8")
W = lambda s="": out.write(s + "\n")
W("| 文档 | 行数 | 最后改动 | 路径引用 | 仍存在 | 点分标识符 | 可解析 | 裸标识符 | 全树可见 |")
W("|---|---|---|---|---|---|---|---|---|")
details = {}
for d in DOCS:
    text = open(os.path.join(ROOT, d), encoding="utf-8").read()
    last = subprocess.run(["git", "-C", ROOT, "log", "-1", "--format=%ad", "--date=short", "--", d],
                          capture_output=True, text=True).stdout.strip()
    toks = re.findall(r"`([^`\n]+)`", text)
    p_all = p_ok = 0
    d_all = d_ok = 0
    w_all = w_ok = 0
    miss_p, miss_d, miss_w = [], [], []
    seen = set()
    for t in toks:
        t = t.strip()
        if t in seen or " " in t and not t.endswith("()"):
            continue
        seen.add(t)
        if PATH_RE.match(t):
            p_all += 1
            cand = t if not t.endswith("/") else t[:-1]
            if cand in tracked or t in tracked or any(x.startswith(t) for x in tracked) or os.path.exists(os.path.join(ROOT, t)):
                p_ok += 1
            else:
                miss_p.append(t)
        elif DOT_RE.match(t):
            d_all += 1
            ok, _ = resolve_dotted(t)
            if ok:
                d_ok += 1
            else:
                miss_d.append(t)
        elif WORD_RE.match(t) and len(t.rstrip("()")) >= 6:
            w = t.rstrip("()")
            w_all += 1
            hits = word_hits.get(w, [])
            if hits:
                w_ok += 1
            else:
                miss_w.append(w)
    W(f"| {d} | {text.count(chr(10))} | {last} | {p_all} | {p_ok} | {d_all} | {d_ok} | {w_all} | {w_ok} |")
    details[d] = (miss_p, miss_d, miss_w)

W("\n## 失效引用明细（每类最多 25 条）")
for d, (mp, md, mw) in details.items():
    W(f"\n### {d}")
    if mp:
        W("- 已不存在的路径：" + ", ".join(f"`{x}`" for x in sorted(mp)[:25]) + (" …" if len(mp) > 25 else ""))
    if md:
        W("- 解析不到的点分标识符：" + ", ".join(f"`{x}`" for x in sorted(md)[:25]) + (" …" if len(md) > 25 else ""))
    if mw:
        W("- 全树无此名的标识符：" + ", ".join(f"`{x}`" for x in sorted(mw)[:25]) + (" …" if len(mw) > 25 else ""))
out.close()
print(open(OUT, encoding="utf-8").read())

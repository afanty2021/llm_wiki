#!/usr/bin/env python3
"""AST 收集 Hermes 全树对 mcp / anthropic / openai 的调用面（纯静态，不 import 仓内代码）。

产出 /tmp/review-verify/sdk-records.json：
  imports : [{file,line,style,module,names,alias,guarded}]
  attrs   : [{file,line,alias,path,guarded}]        # 模块别名上的属性链 alias.a.b.c
  calls   : [{file,line,recv,attr,kws,nargs,guarded}]  # 方法调用（receiver 路径 + kwargs 名）
"""
import ast
import json
import os
import sys

ROOT = sys.argv[1]
OUT = sys.argv[2]
PKGS = ("mcp", "anthropic", "openai")
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".zcode", ".pytest_cache", ".ruff_cache", "dist", "build"}

records = {"imports": [], "attrs": [], "calls": [], "syntax_errors": [], "files": 0}


def split_top(pkg):
    """`import a.b.c` / `from a.b.c import` -> 该语句涉及顶层包。"""
    return pkg.split(".", 1)[0] if isinstance(pkg, str) else None


def guarded(node, parents):
    """import/调用是否位于捕获 ImportError（或其父类）的 try 内。"""
    cur = node
    while cur in parents:
        cur = parents[cur]
        if isinstance(cur, ast.Try):
            for h in cur.handlers:
                t = h.type
                names = []
                if t is None:
                    names = ["<bare>"]
                elif isinstance(t, ast.Name):
                    names = [t.id]
                elif isinstance(t, ast.Tuple):
                    names = [e.id for e in t.elts if isinstance(e, ast.Name)]
                if any(n in ("ImportError", "ModuleNotFoundError", "Exception", "BaseException", "<bare>") for n in names):
                    return True
    return False


def chain(node):
    """Attribute/Name 链 -> 点分路径 (根必须是 Name)，否则 None。"""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    if isinstance(node, ast.Call):
        return "<call>." + ".".join(reversed(parts))
    return None


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        b = dotted(node.value)
        return f"{b}.{node.attr}" if b else None
    return None


def handle_import(node, parents, rel, aliases):
    g = guarded(node, parents)
    if isinstance(node, ast.Import):
        for a in node.names:
            top = split_top(a.name)
            if top in PKGS:
                records["imports"].append({"file": rel, "line": node.lineno, "style": "import", "module": a.name,
                                           "names": [], "alias": a.asname, "guarded": g})
                if a.asname:
                    aliases[a.asname] = a.name
                else:
                    # import a.b.c -> 绑定的是 a
                    aliases[a.name.split(".", 1)[0]] = a.name.split(".", 1)[0]
    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
        top = split_top(node.module)
        if top in PKGS:
            names = [(n.name, n.asname) for n in node.names]
            records["imports"].append({"file": rel, "line": node.lineno, "style": "from", "module": node.module,
                                       "names": [n[0] for n in names], "alias": None, "guarded": g})
            for n, alias in names:
                if n == "*":
                    continue
                aliases[alias or n] = f"{node.module}.{n}"


def snippet(src, starts, node):
    """O(1) 取调用点源码片段（预计算行首偏移，避免 get_source_segment 的逐次全量重算）。"""
    import bisect
    try:
        a = starts[node.lineno - 1] + node.col_offset
        b = starts[node.end_lineno - 1] + node.end_col_offset
    except (AttributeError, IndexError, TypeError):
        return ""
    return src[a:b][:400]


def walk(node, parents, rel, aliases, src, starts):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        handle_import(node, parents, rel, aliases)
        return
    if isinstance(node, ast.Attribute):
        p = chain(node)
        if p and "." in p:
            root = p.split(".", 1)[0]
            if root in aliases and (node, p) not in seen_attrs:
                seen_attrs.add((node, p))
                records["attrs"].append({"file": rel, "line": node.lineno, "alias": root,
                                         "path": aliases[root] + p[len(root):], "guarded": guarded(node, parents)})
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        recv = chain(node.func)
        if recv is not None:
            r = ast.unparse(node.func.value)
            if len(r) > 140:
                r = r[:140] + "…"
            records["calls"].append({"file": rel, "line": node.lineno, "recv": r, "recv_chain": recv,
                                     "attr": node.func.attr, "kws": sorted(k.arg for k in node.keywords if k.arg),
                                     "nargs": len(node.args), "has_star_kw": any(k.arg is None for k in node.keywords),
                                     "guarded": guarded(node, parents), "src": snippet(src, starts, node)})
    for child in ast.iter_child_nodes(node):
        parents[child] = node
        walk(child, parents, rel, aliases, src, starts)


for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
    for fn in sorted(filenames):
        if not fn.endswith(".py"):
            continue
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        try:
            src = open(full, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError) as e:
            records["syntax_errors"].append({"file": rel, "err": f"read: {e}"})
            continue
        records["files"] += 1
        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            records["syntax_errors"].append({"file": rel, "err": f"{e.msg} @ {e.lineno}"})
            continue
        seen_attrs = set()
        starts = [0]
        for i, ch in enumerate(src):
            if ch == "\n":
                starts.append(i + 1)
        walk(tree, {}, rel, {}, src, starts)

json.dump(records, open(OUT, "w"), ensure_ascii=False)
print(f"files={records['files']} imports={len(records['imports'])} attrs={len(records['attrs'])} "
      f"calls={len(records['calls'])} syntax_errors={len(records['syntax_errors'])}")

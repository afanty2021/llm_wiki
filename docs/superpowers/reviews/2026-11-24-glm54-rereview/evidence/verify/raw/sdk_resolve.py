#!/usr/bin/env python3
"""把 sdk-records.json 的每个 SDK 符号 / 属性链 / 调用 kwargs 对到钉版真实现。

只 import mcp / anthropic / openai 三个已装 SDK（加标准库），不 import 仓内任何代码。
用法（live env，-I，cwd=/tmp）：python -I sdk_resolve.py <records.json> <out.md>
"""
import collections
import importlib
import importlib.metadata as md
import importlib.util
import inspect
import json
import sys

recs = json.load(open(sys.argv[1]))
out = open(sys.argv[2], "w", encoding="utf-8")
W = lambda s="": out.write(s + "\n")

for d in ("mcp", "mcp-types", "anthropic", "openai", "pillow-heif"):
    try:
        W(f"- {d} == {md.version(d)}")
    except md.PackageNotFoundError:
        W(f"- {d} == <not installed>")

import anthropic  # noqa: E402
import mcp  # noqa: E402
import openai  # noqa: E402

_mod_cache = {}


def load(mod):
    if mod in _mod_cache:
        return _mod_cache[mod]
    try:
        obj = importlib.import_module(mod)
        res = (True, obj, None)
    except BaseException as e:  # SDK import 期任何异常都算不可用
        res = (False, None, f"{type(e).__name__}: {e}"[:160])
    _mod_cache[mod] = res
    return res


def resolve_path(path):
    """点分路径 -> (obj | None, err | None)。最长可 import 前缀 + 余下 getattr。"""
    parts = path.split(".")
    for cut in range(len(parts), 0, -1):
        ok, obj, err = load(".".join(parts[:cut]))
        if ok:
            break
    else:
        return None, f"no importable prefix ({err})"
    for i, attr in enumerate(parts[cut:]):
        if hasattr(obj, attr):
            obj = getattr(obj, attr)
            continue
        sub = ".".join(parts[:cut + i] + [attr])
        ok2, obj2, _ = load(sub)  # 子模块
        if ok2:
            obj = obj2
            continue
        return None, f"missing attribute '{attr}' on {'.'.join(parts[:cut + i])}"
    return obj, None


def accepted(fn):
    """(允许的关键字名集合 | None=接受任意 **kwargs, 允许的位置实参上限 | None)。"""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return "unknown", "unknown"
    names, npos = set(), 0
    for p in sig.parameters.values():
        if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
            names.add(p.name)
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            npos += 1
        if p.kind == p.VAR_KEYWORD:
            names = None
        if p.kind == p.VAR_POSITIONAL:
            npos = None
    return names, npos


def kw_check(fn, kws, nargs):
    names, npos = accepted(fn)
    if names == "unknown":
        return "sig-unknown"
    bad = [] if names is None else [k for k in kws if k not in names]
    too_many = bool(npos is not None and nargs > npos)
    if bad or too_many:
        return f"bad_kwargs={bad}{' positional_overflow' if too_many else ''}"
    return None


# ---------- ① import 面 ----------
W("\n## ① import 面（全树）")
imp_fail = []
imp_total = 0
for i in recs["imports"]:
    imp_total += 1
    if i["style"] == "import":
        ok, _, err = load(i["module"])
        if not ok:
            imp_fail.append((i, err))
    else:
        ok, obj, err = load(i["module"])
        if not ok:
            imp_fail.append((i, err))
            continue
        for n in i["names"]:
            if not hasattr(obj, n) and not load(f"{i['module']}.{n}")[0]:
                imp_fail.append((i, f"missing name '{n}' in {i['module']}"))
W(f"- import 语句 {imp_total} 条（其中 try/except ImportError 守护 {sum(1 for i in recs['imports'] if i['guarded'])} 条），"
  f"钉版下解析失败 **{len(imp_fail)}** 条")
for i, err in sorted(imp_fail, key=lambda x: (x[0]['guarded'], x[0]['file'], x[0]['line'])):
    tag = "守护内" if i["guarded"] else "**裸露**"
    names = i["names"] or [i["module"]]
    W(f"  - {tag} `{i['file']}:{i['line']}` {i['style']} {i['module']} :: {', '.join(names)} → {err}")

# ---------- ② 模块别名属性链 ----------
W("\n## ② 模块别名上的属性链")
attr_fail = []
seen = set()
for a in recs["attrs"]:
    k = (a["path"], a["file"], a["line"])
    if k in seen:
        continue
    seen.add(k)
    obj, err = resolve_path(a["path"])
    if err:
        attr_fail.append((a, err))
W(f"- 属性链 {len(seen)} 条，钉版下解析失败 **{len(attr_fail)}** 条")
for a, err in sorted(attr_fail, key=lambda x: (x[0]['guarded'], x[0]['file'], x[0]['line'])):
    tag = "守护内" if a["guarded"] else "**裸露**"
    W(f"  - {tag} `{a['file']}:{a['line']}` {a['path']} → {err}")

# ---------- ③ 调用 kwargs ----------
W("\n## ③ 调用点 kwargs 对钉版方法签名")
clients = {}
try:
    clients["anthropic.Anthropic"] = anthropic.Anthropic(api_key="sk-ant-dummy-not-a-key")
    clients["anthropic.AsyncAnthropic"] = anthropic.AsyncAnthropic(api_key="sk-ant-dummy-not-a-key")
except Exception as e:
    W(f"- 构造 anthropic 客户端失败：{type(e).__name__}")
try:
    clients["openai.OpenAI"] = openai.OpenAI(api_key="sk-dummy-not-a-key")
    clients["openai.AsyncOpenAI"] = openai.AsyncOpenAI(api_key="sk-dummy-not-a-key")
except Exception as e:
    W(f"- 构造 openai 客户端失败：{type(e).__name__}")
W(f"- 已构造只读客户端对象（不发网络）：{', '.join(clients)}")

# 每文件别名表：别名 -> 目标路径
alias_of = collections.defaultdict(dict)
for i in recs["imports"]:
    if i["style"] == "import":
        top = i["module"].split(".")[0]
        alias_of[i["file"]][i["alias"] or top] = i["alias"] and i["module"] or top
    else:
        for n in i["names"]:
            alias_of[i["file"]][n] = f"{i['module']}.{n}"
imports_pkg = collections.defaultdict(set)
for i in recs["imports"]:
    imports_pkg[i["file"]].add(i["module"].split(".")[0])

from mcp.client.session import ClientSession  # noqa: E402

SESSION_METHODS = ("call_tool", "list_tools", "list_resources", "list_resource_templates", "read_resource",
                   "subscribe", "unsubscribe", "create_message", "list_prompts", "get_prompt",
                   "set_logging_level", "complete", "send_ping")
_walk_cache = {}


def walk(obj, parts):
    """沿 parts getattr；返回 (obj, 已消费段数) 或 (None, None)。"""
    for i, p in enumerate(parts):
        if p.startswith("<"):
            return None, None
        try:
            obj = getattr(obj, p)
        except AttributeError:
            return None, None
        except Exception:
            return None, None
    return obj, len(parts)


def resolve_tail(tail, pkg):
    """局部变量 receiver 的尾链在各 SDK 客户端上解析 -> ({client_name: callable}, 消费段数)（取最长可解析后缀）。"""
    ck = (pkg, tail)
    if ck in _walk_cache:
        return _walk_cache[ck]
    parts = tail.split(".")
    found, consumed = {}, 0
    for start in range(len(parts)):  # 逐段剥前缀（self.client.beta…）
        cand = {n: walk(c, parts[start:]) for n, c in clients.items() if n.startswith(pkg + ".")}
        hit = {n: o for n, (o, _) in cand.items() if o is not None}
        if hit:
            found = {n: o for n, o in hit.items() if callable(o)}
            if found or start == len(parts) - 1:
                consumed = len(parts) - start
                break
    _walk_cache[ck] = (found, consumed)
    return _walk_cache[ck]


stat = collections.Counter()
mismatch = []
resolved_paths = collections.Counter()
sdk_like_unresolved = collections.Counter()
sdk_like_unresolved_files = collections.defaultdict(set)
SDKISH = ("messages", "responses", "completions", "beta", "vector_stores", "batches", "fine_tuning", "uploads",
          "moderations", "containers", "evals", "chat", "embeddings", "realtime", "webhooks")
for c in recs["calls"]:
    f = c["file"]
    chain = c["recv_chain"]
    if chain is None:
        continue
    root, _, rest = chain.partition(".")
    is_test = f.startswith("tests/")
    # (a) receiver 根是模块别名
    if root in alias_of.get(f, {}) and rest:
        obj, err = resolve_path(alias_of[f][root] + "." + rest)
        if err:
            continue  # 已由 ② 覆盖
        if callable(obj) and type(obj).__module__.split(".")[0] in ("mcp", "anthropic", "openai"):
            stat["module_rooted_calls"] += 1
            r = kw_check(obj, c["kws"], c["nargs"])
            resolved_paths[f"<module>.{rest.split('.')[-1]}"] += 1
            if r and not c["guarded"]:
                mismatch.append(("module", f, c, r, None))
        continue
    # (b) MCP 会话方法
    if c["attr"] in SESSION_METHODS and not is_test and ("mcp" in imports_pkg.get(f, set())):
        fn = getattr(ClientSession, c["attr"], None)
        if fn is not None:
            stat["mcp_session_calls"] += 1
            resolved_paths["ClientSession." + c["attr"]] += 1
            r = kw_check(fn, c["kws"], c["nargs"])
            if r and not c["guarded"]:
                mismatch.append(("mcp-session", f, c, r, "ClientSession." + c["attr"]))
    # (c) anthropic / openai 客户端资源方法（不要求该文件 import SDK：客户端对象常经依赖注入拿到）
    if not rest:
        continue
    best = {}
    for pkg in ("anthropic", "openai"):
        found, consumed = resolve_tail(rest, pkg)
        # 只保留 SDK 包内定义的方法（排除 httpx.Headers.get / object.__init__ / pydantic 等沿途通用方法）
        found = {n: fn for n, fn in found.items()
                 if (getattr(fn, "__module__", None) or "").startswith(pkg + ".")}
        generic = {n for n, fn in found.items() if fn.__name__ in ("get", "__init__", "post", "put", "copy", "update")}
        found = {n: fn for n, fn in found.items() if n not in generic}
        if found and consumed >= 2:
            best[pkg] = (found, consumed)
    if not best:
        segs = rest.split(".")
        if (not is_test and len(segs) >= 2 and any(seg in segs for seg in SDKISH)
                and not any(t in rest for t in ("assert_", "call_args", "mock", "Mock", "fake", "Fake"))):
            sdk_like_unresolved[rest] += 1
            sdk_like_unresolved_files[rest].add(f)
        continue
    # 归属：取消费段数最多的 SDK（`chat.completions.create` 在 anthropic 客户端上只能剥掉 chat 后命中
    # 旧版 text-completions 资源，消费段数更少 → 归 openai），并列则两边都校验
    mx = max(c for _, c in best.values())
    for pkg, (found, consumed) in best.items():
        if consumed < mx:
            continue
        imported = pkg in imports_pkg.get(f, set())
        stat[f"{pkg}_calls" + ("_test" if is_test else "") + ("" if imported else "_noimport")] += 1
        key = pkg + ":" + rest.split(".", len(rest.split(".")) - consumed)[-1] if consumed < len(rest.split(".")) else pkg + ":" + rest
        resolved_paths[key] += 1
        results = {n: kw_check(fn, c["kws"], c["nargs"]) for n, fn in found.items()}
        if all(results.values()) and not c["guarded"]:
            mismatch.append((pkg, f, c, sorted(set(results.values()))[0], key))

W(f"- 调用点分类：" + ", ".join(f"{k}={v}" for k, v in sorted(stat.items())))
W(f"- 解析到的 SDK 方法路径 {len(resolved_paths)} 个（非测试文件计）：")
for k, n in sorted(resolved_paths.items()):
    W(f"  - `{k}` ×{n}")
W(f"\n- **kwargs/位置实参与钉版签名不符且无守护的调用：{len(mismatch)} 处**")
for kind, f, c, r, key in sorted(mismatch, key=lambda x: (x[1], x[2]['line'])):
    W(f"  - `{f}:{c['line']}` [{key or kind}] {r}")
    W(f"      `{c['src'][:300].replace(chr(10), ' ')}`")
W(f"\n- SDK 形态（≥2 段）但未在钉版客户端上解析出方法的 receiver 尾链（供人工复核，非测试文件）：")
for tail, n in sorted(sdk_like_unresolved.items()):
    W(f"  - `{tail}` ×{n}  @ {', '.join(sorted(sdk_like_unresolved_files[tail]))[:200]}")
out.close()
print(open(sys.argv[2], encoding="utf-8").read())

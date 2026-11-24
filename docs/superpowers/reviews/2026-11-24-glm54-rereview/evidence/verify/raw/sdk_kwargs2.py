#!/usr/bin/env python3
"""第二遍：SDK 资源方法调用点经 `**变量` 展开传入的 kwargs 键集合（静态近似）对钉版签名。

对每个含 `<recv>.chat.completions.create(**kw)` / `responses.create(**kw)` / `messages.create(**kw)` /
`messages.stream(**kw)` 的非测试文件：收集同一函数体内写入该变量的字符串键（下标赋值 / update / setdefault /
字典字面量），逐键对钉版方法签名的关键字参数集合。动态键单独列出供人工复核。
用法：python -I sdk_kwargs2.py <Hermes 树> <非测试文件清单> <out.md>
"""
import ast
import inspect
import sys

ROOT_LIST = sys.argv[2]
OUT = sys.argv[3]
import anthropic  # noqa: E402
import openai  # noqa: E402

A = anthropic.Anthropic(api_key="sk-ant-dummy-not-a-key")
AA = anthropic.AsyncAnthropic(api_key="sk-ant-dummy-not-a-key")
O = openai.OpenAI(api_key="sk-dummy-not-a-key")
AO = openai.AsyncOpenAI(api_key="sk-dummy-not-a-key")
TARGETS = {
    "chat.completions.create": [O.chat.completions.create, AO.chat.completions.create],
    "responses.create": [O.responses.create, AO.responses.create],
    "messages.create": [A.messages.create, AA.messages.create],
    "messages.stream": [A.messages.stream, AA.messages.stream],
}
# 也走同一资源方法的其他变体（with_raw_response / parse），只报签名是否一致
VARIANTS = {
    "chat.completions.parse": [O.chat.completions.parse, AO.chat.completions.parse],
    "beta.chat.completions.parse": [O.beta.chat.completions.parse, AO.beta.chat.completions.parse],
}


def names_of(fn):
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    ns = {p.name for p in sig.parameters.values() if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)}
    return None if any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()) else ns


SIG = {}
for k, fns in list(TARGETS.items()) + list(VARIANTS.items()):
    per = [names_of(f) for f in fns]
    inter = set.intersection(*[p for p in per if p is not None]) if any(p is not None for p in per) else set()
    SIG[k] = (inter, per)


def chain(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    return ".".join(reversed(parts)) if isinstance(node, ast.Name) else None


def func_of(node, parents):
    while node in parents:
        node = parents[node]
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return node
    return None


out = open(OUT, "w", encoding="utf-8")
W = lambda s="": out.write(s + "\n")
W("## SDK 资源方法签名（钉版实测）")
for k, (inter, per) in SIG.items():
    W(f"- `{k}`：关键字参数 {len(inter) if inter is not None else '**kwargs 任意'} 个（同步/异步变体"
      f"{'一致' if per[0] == per[1] else '不一致'}）；含 `context_management`={bool(inter and 'context_management' in inter)}"
      f"，含 `extra_body`={bool(inter and 'extra_body' in inter)}，含 `stream`={bool(inter and 'stream' in inter)}")

files = [l.strip() for l in open(ROOT_LIST) if l.strip()]
total_sites = direct_sites = splat_sites = 0
problems = []
dyn = []
for rel in files:
    try:
        tree = ast.parse(open(f"{sys.argv[1]}/{rel}", encoding="utf-8").read())
    except (SyntaxError, OSError, UnicodeDecodeError):
        continue
    parents = {}
    for n in ast.walk(tree):
        for c in ast.iter_child_nodes(n):
            parents[c] = n
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call) or not isinstance(n.func, ast.Attribute):
            continue
        full = chain(n.func)
        if full is None:
            continue
        key = next((k for k in list(TARGETS) + list(VARIANTS) if full.endswith("." + k) or full == k), None)
        if key is None:
            continue
        # 排除 mock 断言（.call_args / assert_* 链）
        if any(tok in full for tok in ("call_args", "assert_", "mock", "fake", "Fake", "Mock")):
            continue
        total_sites += 1
        inter, _ = SIG[key]
        kw = [k.arg for k in n.keywords if k.arg]
        splats = [k.value.id for k in n.keywords if k.arg is None and isinstance(k.value, ast.Name)]
        line = n.lineno
        if not splats:
            direct_sites += 1
            bad = [] if inter is None else [x for x in kw if x not in inter]
            if bad:
                problems.append((rel, line, key, f"直接 kwargs 不在签名: {bad}", ""))
            continue
        splat_sites += 1
        fn = func_of(n, parents)
        if fn is None:
            problems.append((rel, line, key, "模块级 `**` 展开，未跟踪", ""))
            continue
        keys, dynamic = set(), []
        for sub in ast.walk(fn):
            tgt = None
            if isinstance(sub, ast.Assign) and len(sub.targets) == 1:
                tgt = sub.targets[0]
            elif isinstance(sub, (ast.AugAssign, ast.AnnAssign)):
                tgt = sub.target
            if isinstance(tgt, ast.Subscript) and isinstance(tgt.value, ast.Name) and tgt.value.id in splats:
                if isinstance(tgt.slice, ast.Constant) and isinstance(tgt.slice.value, str):
                    keys.add(tgt.slice.value)
                else:
                    dynamic.append(f"L{sub.lineno} 动态下标 {ast.unparse(tgt)[:60]}")
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and isinstance(sub.func.value, ast.Name) \
                    and sub.func.value.id in splats and sub.func.attr in ("update", "setdefault", "pop", "pop default"):
                if sub.args and isinstance(sub.args[0], ast.Constant) and isinstance(sub.args[0].value, str):
                    keys.add(sub.args[0].value)
                elif sub.args and isinstance(sub.args[0], ast.Dict):
                    for k_ in sub.args[0].keys:
                        if isinstance(k_, ast.Constant) and isinstance(k_.value, str):
                            keys.add(k_.value)
                        else:
                            dynamic.append(f"L{sub.lineno} update 非常量键")
                elif sub.args:
                    dynamic.append(f"L{sub.lineno} {sub.func.attr}({ast.unparse(sub.args[0])[:50]})")
        bad = [] if inter is None else sorted(k for k in keys if k not in inter and k not in splats)
        if bad or dynamic:
            problems.append((rel, line, key, f"键不在签名: {bad}" if bad else "", "; ".join(dynamic[:6])))

W(f"\n## 调用点")
W(f"- 资源方法调用点 {total_sites} 处：直接 kwargs {direct_sites} 处、`**变量` 展开 {splat_sites} 处")
W(f"- 需人工复核（键不在钉版签名 / 动态键）：{len(problems)} 处")
for rel, line, key, msg, d in problems:
    W(f"  - `{rel}:{line}` [{key}] {msg} {('｜' + d) if d else ''}")
out.close()
print(open(OUT, encoding="utf-8").read())

#!/usr/bin/env python3
"""在给定解释器的已装 mcp 下，逐条试 non-test 文件里的 SDK import（读 records），报告失败项。
用法：python -I mcp_compat.py <records.json> <label>
"""
import importlib
import importlib.util
import json
import sys

recs = json.load(open(sys.argv[1]))
label = sys.argv[2]
try:
    import importlib.metadata as md
    ver = md.version("mcp")
except Exception:
    ver = "<mcp 未安装>"
print(f"## {label}: mcp == {ver}")

seen = set()
bare_fail, guard_fail, ok = [], [], 0
for i in recs["imports"]:
    if i["file"].startswith("tests/") or not i["module"].startswith("mcp"):
        continue
    key = (i["module"], tuple(i["names"]), i["style"], i["guarded"])
    if key in seen:
        continue
    seen.add(key)
    names = i["names"] or [i["module"]]
    try:
        mod = importlib.import_module(i["module"])
        missing = [] if i["style"] == "import" else [
            n for n in i["names"] if not hasattr(mod, n) and importlib.util.find_spec(f"{i['module']}.{n}") is None]
        err = f"缺符号 {missing}" if missing else None
    except BaseException as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {str(e)[:90]}"
    if err is None:
        ok += 1
    else:
        (guard_fail if i["guarded"] else bare_fail).append((i["file"], i["line"], f"{i['module']} :: {', '.join(names)}", err))

print(f"- non-test 文件 mcp import 去重 {len(seen)} 种：解析成功 {ok}，守护内失败 {len(guard_fail)}，**裸露失败 {len(bare_fail)}**")
for f, l, what, err in sorted(bare_fail):
    print(f"  - 裸露 `{f}:{l}` {what} → {err}")
for f, l, what, err in sorted(guard_fail):
    print(f"  - 守护 `{f}:{l}` {what} → {err}")

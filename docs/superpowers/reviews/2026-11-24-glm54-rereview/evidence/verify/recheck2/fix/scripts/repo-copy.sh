#!/bin/bash
# 按「HEAD + 工作树改动」在 /tmp 建仓库副本，供 test:mocks / build:web / mcp:test 用。只读 live 仓（git archive、cp 源），绝不反向写。
set -eu
R=/Users/berton/Github/kb-obsidian/llm_wiki
C=/tmp/glm54-fix-20261126/repo
mkdir -p "$C"
git -C "$R" archive HEAD | tar -x -C "$C"
n=0
while IFS= read -r -d '' f; do
  mkdir -p "$C/$(dirname "$f")"; cp -p "$R/$f" "$C/$f"; n=$((n+1))
done < <(git -C "$R" diff --name-only -z)
# 本轮新建、测试或 CI 要用的未跟踪文件
for f in scripts/check-web-bundle.mjs; do mkdir -p "$C/$(dirname "$f")"; cp -p "$R/$f" "$C/$f"; done
[ -d "$C/node_modules" ] || cp -cR "$R/node_modules" "$C/node_modules"
[ -d "$C/mcp-server/node_modules" ] || cp -cR "$R/mcp-server/node_modules" "$C/mcp-server/node_modules"
[ -d "$C/.git" ] || git -C "$C" init -q
echo "副本就绪：HEAD=$(git -C "$R" rev-parse --short HEAD) 叠加已改跟踪文件 $n 个 + 新文件 1 个；.git=$( [ -d "$C/.git" ] && echo 有 || echo 无 )"
# 叠加对账：副本与工作树逐字节相同
bad=0
while IFS= read -r -d '' f; do cmp -s "$R/$f" "$C/$f" || { echo "  不同：$f"; bad=$((bad+1)); }; done < <(git -C "$R" diff --name-only -z)
echo "叠加对账：$n 个文件里不同 $bad 个"

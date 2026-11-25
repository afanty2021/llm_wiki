#!/bin/bash
# 用法: run.sh <副本目录> <标签> [测试文件 glob...]  在副本里 tsc 构建 + node --test，TAP 原样落 raw/<标签>.out
set -u
T="$1"; L="$2"; shift 2
W=/tmp/glm54-fix-20261126
export PATH=/opt/homebrew/bin:$PATH
PROD=/Users/berton/.hermes/tools/node-26.12.1-darwin-arm64/bin/node
cd "$T"
npm run build > "$W/raw/$L.build.out" 2>&1; brc=$?
if [ "$brc" -ne 0 ]; then echo "BUILD $L: rc=$brc"; grep -E 'error TS' "$W/raw/$L.build.out" | head -20; exit 2; fi
if [ "$#" -gt 0 ]; then files=("$@"); else files=(dist/test/*.test.js); fi
"$PROD" --test --test-reporter=tap "${files[@]}" > "$W/raw/$L.out" 2>&1; rc=$?
echo "TEST $L [prod node]: rc=$rc $(grep -E '^# (tests|pass|fail|skipped) ' "$W/raw/$L.out" | tr '\n' ' ')"
grep -E '^\s*not ok ' "$W/raw/$L.out" | cut -c1-200
exit $rc

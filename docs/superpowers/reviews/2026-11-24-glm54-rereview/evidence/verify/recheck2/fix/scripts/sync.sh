#!/bin/bash
# 单向：live 检出的 mcp-server src/ test/ → /tmp 副本（绝不反向；live 检出里不构建不测试）
set -eu
M=/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server
T="${1:-/tmp/glm54-fix-20261126/work}"
rsync -a --delete "$M/src/" "$T/src/"
rsync -a --delete "$M/test/" "$T/test/"

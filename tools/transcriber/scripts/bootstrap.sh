#!/usr/bin/env bash
# 一次性引导：LT team/project + svc-transcriber（须在 AUTH__REGISTRATION_ENABLED=true 时运行）
#
# 幂等（可安全重跑）：
#   - 凭据：优先 ADMIN_PASSWORD / SVC_PASSWORD 环境变量，其次 STATE_FILE（默认
#     tools/transcriber/out/bootstrap.env，保存本脚本生成的随机密码），都没有才生成新密码。
#     重跑时用同一密码先 login，成功即复用，不重复 register。
#   - team/project：GET 列表按同名查找，命中即复用 id，不重复创建。
#   - svc-transcriber 加入 team：服务端 add_member 为 upsert（ON CONFLICT DO UPDATE），天然幂等。
#
# 结束时打印生产环境变量块：TRAINING__PROJECT_ID / SVC_* 为实值，
# 其余三项为待生成占位（部署时执行 <openssl rand -hex 32> 替换）。
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 保存生成密码的本地状态文件（已加入 .gitignore，勿提交）
STATE_FILE="${STATE_FILE:-$SCRIPT_DIR/../out/bootstrap.env}"

ADMIN_USER="${ADMIN_USER:-training-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-training-admin@local}"
SVC_USER="${SVC_USER:-svc-transcriber}"
SVC_EMAIL="${SVC_EMAIL:-svc-transcriber@wecom.local}"
TEAM_NAME="${TEAM_NAME:-LT师训}"
PROJECT_NAME="${PROJECT_NAME:-LT师训知识库}"
SVC_ROLE="${SVC_ROLE:-admin}"

log() { printf '[bootstrap] %s\n' "$*" >&2; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# --- JSON 解析（不依赖 jq，python3 兜底）-------------------------------------
# J "['a']['b']"：stdin JSON → stdout 取值；失败（键缺失/非 JSON）时退出码 1
J() {
  python3 -c '
import sys, json
expr = sys.argv[1]
try:
    doc = json.load(sys.stdin)
    val = eval("doc" + expr)  # expr 均为本脚本内写死的取值路径，非外部输入
    if val is None:
        raise KeyError(expr)
    print(val)
except Exception as e:
    sys.stderr.write("J: extract %s failed: %s\n" % (expr, e))
    sys.exit(1)
' "$1"
}

# find_by_name "data" "LT师训"：stdin 列表 JSON → stdout 首个同名条目的 id；未命中退出码 1
find_by_name() {
  python3 -c '
import sys, json
key, want = sys.argv[1], sys.argv[2]
doc = json.load(sys.stdin)
for it in doc.get(key) or []:
    if it.get("name") == want:
        print(it["id"])
        sys.exit(0)
sys.exit(1)
' "$1" "$2"
}

# api METHOD PATH [JSON_BODY] [TOKEN] → 响应体到 stdout（HTTP 错误不抛，由调用方解析）
api() {
  local method="$1" path="$2" body="${3-}" token="${4-}"
  local args=(-sS --connect-timeout 5 --max-time 30 \
    -X "$method" "$BASE$path" -H 'content-type: application/json')
  if [[ -n "$token" ]]; then args+=(-H "authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then args+=(-d "$body"); fi
  curl "${args[@]}"
}

# read_state KEY：从状态文件读值（无则空串）。不 source，避免覆盖环境变量。
read_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  grep -E "^$1=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# --- 0. 服务可达性预检 ---------------------------------------------------------
api GET /health >/dev/null || die "server 不可达（${BASE}）：请先启动 src-server（cargo run）"

# --- 1. 准备密码（env > state file > 生成）------------------------------------
: "${ADMIN_PASSWORD:=$(read_state ADMIN_PASSWORD)}"
: "${ADMIN_PASSWORD:=$(openssl rand -hex 16)}"
: "${SVC_PASSWORD:=$(read_state SVC_PASSWORD)}"
: "${SVC_PASSWORD:=$(openssl rand -hex 16)}"

# --- 2. 账号：login 失败才 register（register 400 已存在 → 再试 login）--------
# 成功后设置 AUTH_TOKEN / AUTH_USER_ID
ensure_user() {
  local username="$1" email="$2" password="$3" body
  body=$(api POST /api/v1/auth/login "{\"username\":\"$username\",\"password\":\"$password\"}")
  if AUTH_TOKEN=$(printf '%s' "$body" | J "['access_token']" 2>/dev/null) \
     && AUTH_USER_ID=$(printf '%s' "$body" | J "['user']['id']" 2>/dev/null); then
    log "$username: 已存在，login 复用（user_id=${AUTH_USER_ID}）"
    return 0
  fi
  body=$(api POST /api/v1/auth/register \
    "{\"username\":\"$username\",\"email\":\"$email\",\"password\":\"$password\"}")
  if AUTH_TOKEN=$(printf '%s' "$body" | J "['access_token']" 2>/dev/null) \
     && AUTH_USER_ID=$(printf '%s' "$body" | J "['user']['id']" 2>/dev/null); then
    log "$username: 新注册（user_id=${AUTH_USER_ID}）"
    return 0
  fi
  # register 失败：用户名/邮箱已存在（如状态文件丢失、密码不一致）→ 最后再试一次 login
  if printf '%s' "$body" | grep -q 'already'; then
    body=$(api POST /api/v1/auth/login "{\"username\":\"$username\",\"password\":\"$password\"}")
    if AUTH_TOKEN=$(printf '%s' "$body" | J "['access_token']" 2>/dev/null) \
       && AUTH_USER_ID=$(printf '%s' "$body" | J "['user']['id']" 2>/dev/null); then
      log "$username: 已存在，login 复用（user_id=${AUTH_USER_ID}）"
      return 0
    fi
    die "$username 已存在但密码不匹配：请用原密码设置环境变量后重跑（ADMIN_PASSWORD/SVC_PASSWORD），或在库中删除该用户"
  fi
  die "$username 注册/登录失败：$body"
}

ensure_user "$ADMIN_USER" "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
ADMIN_TOKEN="$AUTH_TOKEN"; ADMIN_ID="$AUTH_USER_ID"

ensure_user "$SVC_USER" "$SVC_EMAIL" "$SVC_PASSWORD"
SVC_TOK="$AUTH_TOKEN"; SVC_ID="$AUTH_USER_ID"

# --- 3. team：列表查同名复用，否则创建 ----------------------------------------
TEAM_ID=""
cursor=""
while :; do
  path="/api/v1/teams?limit=100"
  if [[ -n "$cursor" ]]; then path="$path&cursor=$cursor"; fi
  page=$(api GET "$path" "" "$ADMIN_TOKEN")
  if TEAM_ID=$(printf '%s' "$page" | find_by_name data "$TEAM_NAME"); then
    log "team「${TEAM_NAME}」已存在，复用 id=$TEAM_ID"
    break
  fi
  cursor=$(printf '%s' "$page" | J "['next_cursor']" 2>/dev/null || true)
  # 页不满即末页（next_cursor 即使无更多也会给出）
  count=$(printf '%s' "$page" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("data") or []))')
  if [[ -z "$cursor" || "$count" -eq 0 || "$count" -lt 100 ]]; then break; fi
done
if [[ -z "$TEAM_ID" ]]; then
  body=$(api POST /api/v1/teams "{\"name\":\"$TEAM_NAME\"}" "$ADMIN_TOKEN")
  TEAM_ID=$(printf '%s' "$body" | J "['id']") || die "team 创建失败：$body"
  log "team「${TEAM_NAME}」已创建 id=$TEAM_ID"
fi

# --- 4. project：team 内同名复用，否则创建 ------------------------------------
PROJ_ID=""
cursor=""
while :; do
  path="/api/v1/projects?team_id=$TEAM_ID&limit=100"
  if [[ -n "$cursor" ]]; then path="$path&cursor=$cursor"; fi
  page=$(api GET "$path" "" "$ADMIN_TOKEN")
  if PROJ_ID=$(printf '%s' "$page" | find_by_name items "$PROJECT_NAME"); then
    log "project「${PROJECT_NAME}」已存在，复用 id=$PROJ_ID"
    break
  fi
  cursor=$(printf '%s' "$page" | J "['next_cursor']" 2>/dev/null || true)
  count=$(printf '%s' "$page" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("items") or []))')
  if [[ -z "$cursor" || "$count" -eq 0 || "$count" -lt 100 ]]; then break; fi
done
if [[ -z "$PROJ_ID" ]]; then
  body=$(api POST /api/v1/projects "{\"name\":\"$PROJECT_NAME\",\"team_id\":$TEAM_ID}" "$ADMIN_TOKEN")
  PROJ_ID=$(printf '%s' "$body" | J "['id']") || die "project 创建失败：$body"
  log "project「${PROJECT_NAME}」已创建 id=$PROJ_ID"
fi

# --- 5. svc-transcriber 加入 team（upsert，幂等）------------------------------
body=$(api POST "/api/v1/teams/$TEAM_ID/members" "{\"user_id\":$SVC_ID,\"role\":\"$SVC_ROLE\"}" "$ADMIN_TOKEN")
role=$(printf '%s' "$body" | J "['role']" 2>/dev/null) \
  || die "添加 $SVC_USER 到 team 失败：$body"
log "$SVC_USER → team「${TEAM_NAME}」角色 $role"

# --- 6. 保存密码到状态文件（下次重跑可 login 复用；600 权限，勿提交）----------
mkdir -p "$(dirname "$STATE_FILE")"
{
  echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
  echo "SVC_PASSWORD=$SVC_PASSWORD"
  echo "TEAM_ID=$TEAM_ID"
  echo "PROJECT_ID=$PROJ_ID"
  # 空占位：CLI sign-media 读 bootstrap.MEDIA__SIGNING_KEY，与服务端同值时填入即可（免手工补键）
  echo "MEDIA__SIGNING_KEY="
} > "$STATE_FILE"
chmod 600 "$STATE_FILE"

# --- 7. 输出生产环境变量块 ------------------------------------------------------
cat <<EOF
✅ bootstrap 完成。生产环境变量（勿入库）：
TRAINING__PROJECT_ID=$PROJ_ID
JWT__SECRET=<openssl rand -hex 32>
TRAINING__ADMIN_TOKEN=<openssl rand -hex 32>
MEDIA__SIGNING_KEY=<openssl rand -hex 32>
AUTH__REGISTRATION_ENABLED=false
SVC_USERNAME=$SVC_USER
SVC_PASSWORD=$SVC_PASSWORD   # 仅供 CLI 登录（out/auth.json 会存 refresh token）
EOF
log "凭据已存 ${STATE_FILE}（含 $ADMIN_USER 密码；已 gitignore）"

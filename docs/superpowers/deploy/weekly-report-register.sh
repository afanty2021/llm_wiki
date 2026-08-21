#!/usr/bin/env bash
# =============================================================================
# weekly-report-register.sh — LT 师训周报 per-teacher cron 注册/列出/删除/手动触发
# （M3 Task 5）
#
# 用法:
#   ./weekly-report-register.sh add <wecom_userid>      # 注册该教师的周五周报 job
#   ./weekly-report-register.sh list [<wecom_userid>]   # 列出（可按教师过滤）
#   ./weekly-report-register.sh remove <wecom_userid>   # 删除该教师的周报 job
#   ./weekly-report-register.sh fire <wecom_userid>     # 手动触发一次周报（临时一次性 job）
#
# 设计要点:
#   * schedule = "<M> 9 * * 5"，M = cksum(uid) % 15 —— 确定性散列错峰：同 uid 重跑
#     恒得同分钟，15 名教师分散在 09:00-09:14。理由：Hermes cron 是并行线程池
#     （cron/scheduler.py:542 "Persistent thread pool for parallel cron jobs"），
#     全员同刻 09:00 齐发会叠加推理内存压力（spec §6 提前 EOS 有前科，评审 #6）。
#   * deliver = "wecom:<uid>" —— 单聊直推该教师（wecom DM 的 chat_id = userid；
#     群聊禁主动发，只对教师单聊注册）。
#   * prompt 与 SKILL.md §7 流程 5（周报生成 · cron 系统回合）对齐：显式携带目标
#     教师 wecom_userid（系统模式回合每次工具调用必须显式带）；指示按流程 5 执行；
#     **不含 period_key** —— 服务端自算当周并按 (用户, weekly, 当周) 幂等（M3 T3），
#     prompt 不教 agent 手算 ISO 周。
#   * 来源标签 "lt-tutor-weekly:<uid>" 写入 job name。注：Hermes job schema 的
#     origin 字段是"创建来源"（platform/chat_id dict，供 deliver=origin 回投定位，
#     cron/jobs.py create_job），并非自由标签，CLI 亦不暴露——故来源标签入 name。
#   * 注册/删除走 `hermes cron` CLI（preflight 实测该 CLI 具备
#     create/add/edit/run/list/remove 全套；无需直写 jobs.json read-modify-write）。
#
# 触发拓扑（fire 的实现依据，实测锚定）:
#   本机 gateway 以 multiplex_profiles 模式运行（主 config ~/.hermes/config.yaml，
#   由 lt-tutor-deploy.sh apply 托管），其内置 60s ticker 会遍历 tick lt-tutor
#   profile 的 cron store（gateway/run.py:30149 起 multiplex cron 逻辑），投递走
#   gateway 持有的 live wecom 适配器。而脱离 gateway 的 `hermes cron run` 内联执行
#   在本 CLI 进程内跑，standalone 投递读 profile config——secondary profile 禁配
#   platforms.wecom（lt-tutor-deploy.sh 事实约束 #4），WeCom 凭证不可得，投递必败。
#   因此 `fire` 子命令的触发方式 = 注册一个 ~2 分钟后到期的一次性 job（repeat=1
#   自动单次、跑完自动移除），交由在跑 gateway 的 ticker 执行——与周五 09:0x 的
#   正式触发走完全相同的执行与投递路径。这也是 runbook 里"周报补救走手动 fire"
#   的操作入口。
#
# MCP 单实例约束（部署纪律，T10 runbook 观察项）:
#   llm-wiki-training MCP（node mcp-server/dist/src/index.js）由 multiplex gateway
#   主进程单实例持有（主 config mcp_servers 托管块）。多实例并发 = 教师 access
#   缓存 / refresh 与 bind 轮换乒乓风险——本脚本只操作 lt-tutor profile 的 cron
#   store（HERMES_HOME 指向 profile home），不另起 MCP / gateway 实例；fire 触发
#   由在跑 gateway 的 ticker 执行（复用其单实例 MCP 与 live 适配器）。
#
# ⚠ 投递前置条件（T5 首次 fire 实测发现，2026-08-21）:
#   multiplex ticker 在 profile home override 下执行本 store 的 job，cron 预检
#   （_preflight_check_delivery）与投递（_deliver_result）均读 profile config。
#   profile config 若无 platforms.wecom 块，deliver=wecom:* 的 job 会被
#   blocked_config 预检拒绝（"delivery platform 'wecom' has no gateway credentials
#   configured"）。profile config 需声明 bot_id-only 块（is_connected 判据 =
#   extra.bot_id，不含 secret——无 secret 建不起第二条 websocket，实际投递走主
#   config 的 live 适配器；WeCom 凭证不参与 multiplex 指纹查重）：
#       platforms:
#         wecom:
#           enabled: true
#           extra:
#             bot_id: "<与主 config 相同的 bot_id>"
#   注意：lt-tutor-deploy.sh apply 会整文件重渲染 profile config——该块须并入其
#   render_profile_config 模板，否则 apply 后周报投递静默失效。本脚本 preflight
#   会检测缺失并告警。
#
# 环境变量（均可覆盖默认）:
#   HERMES_BIN       hermes CLI 路径（默认 hermes-3.11 conda env 的 hermes）
#   LT_PROFILE_HOME  lt-tutor profile home（默认 ~/.hermes/profiles/lt-tutor）
#
# 验证证据入口（fire 后）:
#   投递（发送侧）:  grep "Sending response" ~/.hermes/logs/gateway.log | tail
#   计划落库:        docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki \
#                       -c "SELECT id,origin,period_key,created_at FROM learning_plans
#                            WHERE user_id=(该教师 src-server uid) ORDER BY id DESC"
#   cron 回合系统模式（T1 延后取证项 identity_source）: 见 M3 task-5-report.md
# =============================================================================
set -euo pipefail

# ── 配置 ─────────────────────────────────────────────────────────────────────
HERMES_BIN="${HERMES_BIN:-/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/hermes}"
LT_PROFILE_HOME="${LT_PROFILE_HOME:-$HOME/.hermes/profiles/lt-tutor}"
JOB_TAG="lt-tutor-weekly"          # 正式 job name 前缀：<JOB_TAG>:<uid>
FIRE_TAG="lt-tutor-weekly-oneshot" # fire 临时 job name 前缀（一次性，跑完自动移除）
SKILL_NAME="teacher-tutor"
FIRE_DELAY="2m"                    # fire 一次性 job 的触发延迟（parse_schedule 单次时长）

c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
c_warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
c_fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()    { c_fail "$*"; exit 1; }

# 全部 hermes 调用统一指向 lt-tutor profile home
hermes_cli() {
  HERMES_HOME="${LT_PROFILE_HOME}" "${HERMES_BIN}" "$@"
}

# ── 预检 ─────────────────────────────────────────────────────────────────────
preflight() {
  [[ -x "${HERMES_BIN}" ]] || die "hermes CLI 不存在: ${HERMES_BIN}（可用 HERMES_BIN 覆盖）"
  [[ -d "${LT_PROFILE_HOME}" ]] || die "lt-tutor profile home 不存在: ${LT_PROFILE_HOME}（先跑 lt-tutor-deploy.sh stage/apply）"
  [[ -f "${LT_PROFILE_HOME}/skills/${SKILL_NAME}/SKILL.md" ]] \
    || die "profile 内缺技能 ${LT_PROFILE_HOME}/skills/${SKILL_NAME}/SKILL.md"
  check_delivery_config
}

# 投递前置条件：profile config 需有 platforms.wecom（enabled + extra.bot_id）。
# 缺失时 deliver=wecom:* 的 job 会被 cron 预检 blocked_config 拒绝（见文件头
# "投递前置条件"——multiplex ticker 在 profile home override 下读 profile config）。
check_delivery_config() {
  local ok
  ok=$(LT_CHECK_CONFIG="${LT_PROFILE_HOME}/config.yaml" /usr/bin/env python3 <<'PYEOF' 2>/dev/null
import os, yaml
try:
    cfg = yaml.safe_load(open(os.environ["LT_CHECK_CONFIG"])) or {}
    wecom = ((cfg.get("platforms") or {}).get("wecom") or {})
    extra = wecom.get("extra") or {}
    ok = bool(wecom.get("enabled")) and bool(extra.get("bot_id"))
except Exception:
    ok = False
print("yes" if ok else "no")
PYEOF
)
  if [[ "${ok}" != "yes" ]]; then
    c_warn "profile config 缺 platforms.wecom（enabled + extra.bot_id）投递配置块——"
    c_warn "job 将被 cron 预检 blocked_config 拒绝（详见脚本头部'投递前置条件'）。"
    return 1
  fi
  return 0
}

# 校验 wecom_userid 形状（字母数字及 ._-；不含空格/冒号/换行——name 以冒号拼 uid）
check_uid() {
  local uid="$1"
  [[ -n "${uid}" ]] || die "缺少 <wecom_userid> 参数"
  [[ "${uid}" =~ ^[A-Za-z0-9._-]+$ ]] || die "wecom_userid 含非常规字符（仅允许 [A-Za-z0-9._-]）: ${uid}"
}

# 分钟散列：M = cksum(uid) % 15（确定性：同 uid 恒同分钟；15 人分散 09:00-09:14）
minute_hash() {
  printf '%s' "$1" | cksum | awk '{print $1 % 15}'
}

# 周报任务 prompt（与 SKILL.md §7 流程 5 对齐；period_key 省略——服务端自算当周）
build_prompt() {
  local uid="$1"
  cat <<PROMPT
【周报任务】目标教师 wecom_userid: ${uid}

请按 teacher-tutor 技能 §7 流程 5（周报生成 · cron 系统回合）为该教师生成本周学习周报。要点：
- 本回合为系统模式：每次工具调用都必须显式携带 wecom_userid: ${uid}（prompt 未提供的身份一律不得使用）。
- teacher_tutor_plan_create 的 origin 固定 "weekly"；不传 period_key（服务端自算当周并按周幂等，禁止自行推算 ISO 周串）。
- 教师未建档（档案 404）时不建清单，只输出一句"该教师尚未完成入门问卷，本期暂无周报"。
周报短文由系统送达该教师本人。
PROMPT
}

# 按 name 精确查 job id（hermes cron list 输出解析；命中多个全部输出）
find_job_ids() {
  local name="$1"
  hermes_cli cron list | awk -v target="${name}" '
    /^  [0-9a-f]+ \[/ { id = $1 }
    $0 ~ "^    Name: +" target "$" { print id }
  '
}

# ── 子命令 ───────────────────────────────────────────────────────────────────
cmd_add() {
  local uid="$1" m schedule name existing
  m=$(minute_hash "${uid}")
  schedule="${m} 9 * * 5"
  name="${JOB_TAG}:${uid}"
  existing=$(find_job_ids "${name}")
  if [[ -n "${existing}" ]]; then
    die "该教师已有周报 job（${name} → ${existing}）；如需重建请先 remove"
  fi
  local prompt
  prompt=$(build_prompt "${uid}")
  hermes_cli cron create "${schedule}" "${prompt}" \
    --name "${name}" \
    --deliver "wecom:${uid}" \
    --skill "${SKILL_NAME}"
  c_ok "已注册 ${name}：schedule='${schedule}'（M=cksum(uid)%15=${m}）deliver='wecom:${uid}' skill=${SKILL_NAME}"
  # 注册后自证：list 可见
  if [[ -n "$(find_job_ids "${name}")" ]]; then
    c_ok "list 复核可见：${name}"
  else
    c_fail "list 未见 ${name}——请人工复核 hermes cron list"
    exit 1
  fi
}

cmd_list() {
  local uid="${1:-}"
  hermes_cli cron list
  if [[ -n "${uid}" ]]; then
    local ids
    ids=$(find_job_ids "${JOB_TAG}:${uid}")
    if [[ -n "${ids}" ]]; then
      c_ok "教师 ${uid} 的周报 job id: $(echo ${ids} | tr '\n' ' ')"
    else
      c_warn "教师 ${uid} 尚无周报 job（${JOB_TAG}:${uid}）"
    fi
  fi
}

cmd_remove() {
  local uid="$1" name ids
  name="${JOB_TAG}:${uid}"
  ids=$(find_job_ids "${name}")
  [[ -n "${ids}" ]] || die "未找到 ${name}"
  local id rc=0
  for id in ${ids}; do
    hermes_cli cron remove "${id}" && c_ok "已删除 ${id}（${name}）" || rc=1
  done
  [[ ${rc} -eq 0 ]] || exit 1
}

# 手动触发：注册 ~2 分钟后到期的一次性 job（repeat=1 自动单次），交由在跑
# multiplex gateway 的 ticker 执行（live 适配器投递到教师企微单聊；跑完自动移除）。
cmd_fire() {
  local uid="$1" name existing prompt
  name="${FIRE_TAG}:${uid}"
  existing=$(find_job_ids "${name}")
  if [[ -n "${existing}" ]]; then
    die "已有一个在途的 fire 一次性 job（${existing}）——等它跑完（约 2-3 分钟）再试"
  fi
  prompt=$(build_prompt "${uid}")
  hermes_cli cron create "${FIRE_DELAY}" "${prompt}" \
    --name "${name}" \
    --deliver "wecom:${uid}" \
    --skill "${SKILL_NAME}"
  c_ok "已注册一次性触发 job ${name}（${FIRE_DELAY} 后由 gateway ticker 执行并投递）"
  cat <<EOF
  观察方式：
    HERMES_HOME=${LT_PROFILE_HOME} ${HERMES_BIN} cron list     # 等 Last run 出现
    HERMES_HOME=${LT_PROFILE_HOME} ${HERMES_BIN} cron runs     # 执行记录
    grep "Sending response" ~/.hermes/logs/gateway.log | tail  # 发送侧证据
  注：需要 multiplex gateway 在跑（hermes cron status / ticker_heartbeat 新鲜），
  否则一次性 job 不会被 ticker 拾取。
EOF
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
usage() { sed -n '2,30p' "$0"; }

main() {
  local cmd="${1:-}"
  shift || true
  preflight
  case "${cmd}" in
    add)    check_uid "${1:-}"; cmd_add "$1" ;;
    list)   [[ -n "${1:-}" ]] && check_uid "$1"; cmd_list "${1:-}" ;;
    remove) check_uid "${1:-}"; cmd_remove "$1" ;;
    fire)   check_uid "${1:-}"; cmd_fire "$1" ;;
    *)      usage; die "未知子命令：${cmd:-}（可用: add | list | remove | fire）" ;;
  esac
}

main "$@"

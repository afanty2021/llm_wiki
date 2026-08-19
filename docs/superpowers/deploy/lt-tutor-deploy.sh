#!/usr/bin/env bash
# =============================================================================
# lt-tutor-deploy.sh — Hermes lt-tutor profile 部署 / 回滚脚本（Task 12）
#
# 用法:
#   ./lt-tutor-deploy.sh --dry-run     # 只展示将要发生的改动，绝不触碰 ~/.hermes
#   ./lt-tutor-deploy.sh stage         # 只部署 profile 目录（config+skills），不动主 config
#   ./lt-tutor-deploy.sh apply         # 备份 → 合并主 config → 校验 → 部署 profile → 打印重启指引
#                                     #   （apply 本身【不重启】gateway，重启由操作者确认后执行）
#   ./lt-tutor-deploy.sh rollback      # 恢复备份主 config + 删 profile 目录 + 重启 gateway
#                                     #   （rollback [--no-restart] 跳过重启）
#   ./lt-tutor-deploy.sh checklist     # 打印重启后验证清单
#
# 事实约束（Hermes 源码审计，0.16.0，路径 ~/Github/Coding-Agents/Hermes-agent）:
#   1. 平台会话工具集只认 platform_toolsets.<platform>；顶层 toolsets 不读取。
#   2. profile 的 mcp_servers 自动并入启用集（仅 no_mcp 排除）。
#   3. 内联 custom_providers[].api_key 自足（候选序先于 key_env；multiplex 下无 os.environ 回退）。
#   4. secondary profile 不得启用 platforms.wecom / wecom_callback → 本 profile platforms: {}。
#   5. {platform: wecom} 路由吃掉所有 wecom 消息；owner 会话靠 chat_id 高特异性路由（4 > 0）抢回
#      default profile；指向不存在 profile 的路由 = 消息 fail-closed 丢弃。
#   6. gateway.multiplex_profiles / gateway.profile_routes 嵌套形式受支持。
#   7. skills 从 <profile_home>/skills/ 按 profile 加载（SKILL.md 发现机制在 profile 作用域可用）。
#
# 秘密处理: TRAINING__ADMIN_TOKEN 运行时读 tools/transcriber/out/bootstrap.env；
#           zai api_key 运行时读 ~/.hermes/config.yaml custom_providers。绝不嵌入本脚本/仓库。
# =============================================================================
set -euo pipefail

# ── 常量 ─────────────────────────────────────────────────────────────────────
REPO="/Users/berton/Github/kb-obsidian/llm_wiki"
# 测试沙箱用：LT_TUTOR_HERMES_HOME=/tmp/sandbox-hermes 可离线演练 apply/rollback（生产勿设）
HERMES_HOME="${LT_TUTOR_HERMES_HOME:-/Users/berton/.hermes}"
MAIN_CONFIG="${HERMES_HOME}/config.yaml"
PROFILE_NAME="lt-tutor"
PROFILE_DIR="${HERMES_HOME}/profiles/${PROFILE_NAME}"
SKILL_SRC="${REPO}/docs/superpowers/hermes/lt-tutor/SKILL.md"
MCP_DIST="${REPO}/mcp-server/dist/src/index.js"
BOOTSTRAP_ENV="${REPO}/tools/transcriber/out/bootstrap.env"
STATE_FILE="${HERMES_HOME}/.lt-tutor-deploy.state"

# owner 企业微信 DM chat_id：从 ~/.hermes/logs/gateway.log 实测挖掘（119 条 inbound，
# 全部 user=HuangZhengBo chat=HuangZhengBo，无其他 wecom chat、无群聊 wr* id）。
# wecom DM 的 chat_id = 发送者 userid（adapter.py: chat_id = body.chatid or sender.userid）。
OWNER_WECOM_CHAT_ID="HuangZhengBo"
# 默认 profile 名：内置根 profile（~/.hermes）在 multiplex 下的服务名恒为 "default"
# （hermes_cli/profiles.py: get_active_profile_name() 在 HERMES_HOME=~/.hermes 时返回 "default"）。
DEFAULT_PROFILE="default"

LAUNCHD_LABEL="ai.hermes.gateway"
HERMES_PY_VENV="/Users/berton/Github/Coding-Agents/Hermes-agent/venv/bin/python"

if [[ -x "${HERMES_PY_VENV}" ]]; then
  PY="${HERMES_PY_VENV}"   # venv 可导入 gateway.profile_routing 做深度校验
else
  PY="$(command -v python3)"
fi

# ── 输出助手 ─────────────────────────────────────────────────────────────────
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
c_ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
c_warn()  { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
c_fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

die() { c_fail "$*"; exit 1; }

# ── 秘密读取（不回显、不落仓库） ──────────────────────────────────────────────
read_bootstrap_token() {
  [[ -f "${BOOTSTRAP_ENV}" ]] || die "bootstrap.env 不存在: ${BOOTSTRAP_ENV}"
  local tok
  tok=$(grep -E '^TRAINING__ADMIN_TOKEN=' "${BOOTSTRAP_ENV}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  [[ -n "${tok}" ]] || die "bootstrap.env 中未找到 TRAINING__ADMIN_TOKEN"
  printf '%s' "${tok}"
}

read_zai_key() {
  [[ -f "${MAIN_CONFIG}" ]] || die "主 config 不存在: ${MAIN_CONFIG}"
  local key
  key=$("${PY}" - "$MAIN_CONFIG" <<'PYEOF'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1]))
for p in (cfg.get("custom_providers") or []):
    if isinstance(p, dict) and p.get("name") == "zai-coding-cn":
        k = str(p.get("api_key") or "")
        if k:
            print(k)
            break
else:
    sys.exit(1)
PYEOF
  ) || die "主 config custom_providers 中未找到 zai-coding-cn api_key"
  printf '%s' "${key}"
}

# ── profile config 渲染（模板 + 运行时秘密；目标 600） ────────────────────────
# $1 = 输出路径（"--stdout-masked" 表示打到 stdout 并脱敏）
render_profile_config() {
  local out="$1"
  ZAI_API_KEY_VAL="$(read_zai_key)" \
  TRAINING_ADMIN_TOKEN_VAL="$(read_bootstrap_token)" \
  MCPPROFILE_OUT="${out}" \
  "${PY}" <<'PYEOF'
import os, sys, yaml

zai = os.environ["ZAI_API_KEY_VAL"]
tok = os.environ["TRAINING_ADMIN_TOKEN_VAL"]
out = os.environ["MCPPROFILE_OUT"]

cfg = {
    "model": {
        "default": "glm-5.2",
        "provider": "zai-coding-cn",
        "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
    },
    "custom_providers": [
        {
            "name": "zai-coding-cn",           # 内联 api_key 自足（候选序先于 key_env）
            "api_key": zai,
            "api_mode": "chat_completions",
            "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
            "model": "glm-5.2",
        }
    ],
    "platform_toolsets": {
        # 平台会话工具集只认 platform_toolsets.<platform>；顶层 toolsets 无人读取。
        # 只给 skills → 不注册 terminal/file/web（工具白名单）。MCP servers 自动并入。
        "wecom": ["skills"]
    },
    "platforms": {},                            # secondary profile 禁启用 platforms.wecom / wecom_callback
    "mcp_servers": {
        "llm-wiki-training": {
            "command": "node",
            "args": ["/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/dist/src/index.js"],
            "env": {                            # MCP 子进程 env 直传子进程，不经 Hermes secret scope
                "LLM_WIKI_API_FORM": "src-server",
                "LLM_WIKI_API_BASE_URL": "http://127.0.0.1:8080",
                "TRAINING__ADMIN_TOKEN": tok,   # 运行时读 bootstrap.env
                "TRAINING__PROJECT_ID": "614",
                "PUBLIC_T_BASE": "http://127.0.0.1:8080",  # T15 后改隧道域名
            },
        }
    },
}

text = yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True, default_flow_style=False)

if out == "--stdout-masked":
    masked = text.replace(zai, "<ZAI_API_KEY(len=%d)>" % len(zai)).replace(tok, "<TRAINING_ADMIN_TOKEN(len=%d)>" % len(tok))
    sys.stdout.write(masked)
else:
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, out)
PYEOF
}

# ── 主 config 合并（pyyaml 安全合并；无 gateway 键时追加式，保留既有字节） ────
# $1 = main config 路径;  $2 = dry|write
merge_main_config() {
  local target="$1" mode="$2"
  OWNER_CHAT_ID="${OWNER_WECOM_CHAT_ID}" DEFAULT_PROF="${DEFAULT_PROFILE}" \
  MERGE_MODE="${mode}" MERGE_TARGET="${target}" \
  "${PY}" <<'PYEOF'
import os, sys, yaml, tempfile

target = os.environ["MERGE_TARGET"]
mode   = os.environ["MERGE_MODE"]          # "dry" 只打印，不写
chat   = os.environ["OWNER_CHAT_ID"]
dprof  = os.environ["DEFAULT_PROF"]

OUR_ROUTES = [
    {"name": "owner-wecom-keep", "platform": "wecom", "chat_id": chat,
     "profile": dprof, "enabled": True},                       # 特异性 4：抢回 owner 会话
    {"name": "lt-tutor-wecom", "platform": "wecom",
     "profile": "lt-tutor", "enabled": True},                  # 特异性 0：吃掉其余全部 wecom
]

MARKER = "# ── lt-tutor multiplex gateway（由 docs/superpowers/deploy/lt-tutor-deploy.sh 管理）──\n"

raw = open(target).read()
cfg = yaml.safe_load(raw)
if not isinstance(cfg, dict):
    sys.exit("FATAL: 主 config 顶层不是 mapping")

# 每次都渲染最新的托管块（marker + gateway 节）
dumped = yaml.safe_dump(OUR_ROUTES, sort_keys=False, allow_unicode=True, default_flow_style=False)
indented = "".join("  " + line + "\n" for line in dumped.rstrip("\n").splitlines())
fresh_block = MARKER + "gateway:\n  multiplex_profiles: true\n  profile_routes:\n" + indented

has_gateway = "gateway" in cfg and cfg.get("gateway") is not None
has_marker = MARKER in raw

if not has_gateway and not has_marker:
    # 首次 apply：主 config 尚无顶层 gateway 键 → 追加式（原字节原样保留，仅尾部追加托管块）
    sep = "" if raw.endswith("\n") else "\n"
    new_text = raw + sep + fresh_block
    strategy = "append（无 gateway 键 → 原 557 行字节不动，尾部追加托管块）"
elif has_marker:
    # 重跑 apply：托管块感知的文本替换——只替换 marker 起的托管块，
    # 文件其余字节（含全部注释/托管块标记）逐字节保留。绝不走整文件 safe_dump（会剥注释）。
    start = raw.index(MARKER)
    pos = start + len(MARKER)
    glines = raw[pos:].splitlines(keepends=True)
    # 托管块结构固定为：marker 行 → 顶层 "gateway:" 行 → 缩进/注释行。
    # 块自身的 "gateway:" 属于托管块；其后首个“其他顶层键”才是块结束。
    if not glines or glines[0].rstrip("\r\n") != "gateway:":
        sys.exit("FATAL: 托管标记后未紧跟 gateway: 键——托管块结构异常，中止（未写盘）")
    pos += len(glines[0])
    content_end = pos
    for line in glines[1:]:
        # 顶层键（列 0 非注释非空行）即托管块结束；块内注释/缩进行都属于托管块
        if line.strip() and not line.startswith((" ", "\t", "#")):
            break
        pos += len(line)
        if line.strip():
            content_end = pos
    new_text = raw[:start] + fresh_block + raw[content_end:]
    strategy = "managed-block replace（重跑 → 仅替换本脚本托管块，其余字节含注释逐字节保留）"
else:
    # gateway 键存在但无托管标记（用户手写 / hermes config set 产物）→
    # 任意布局下做文本手术不安全，整文件重写又会剥离注释 → 中止并输出明确指令
    msg = ("ABORT: 主 config 已存在 gateway 键但无本脚本托管标记。"
           "为避免整文件重写剥离注释，apply 已中止（未写盘）。"
           "请手工将 gateway.multiplex_profiles=true 与 gateway.profile_routes 两条路由"
           "（见 docs/superpowers/deploy/lt-tutor-deploy.sh 或 dry-run 输出）并入既有 gateway 块，"
           "或移除既有 gateway 键后重跑 apply。")
    if mode == "dry":
        print(f"[merge-strategy] {msg}")
        sys.exit(0)
    sys.exit(msg)

# 校验 1: 结果是合法 YAML 且无重复顶层键
reloaded = yaml.safe_load(new_text)
if not isinstance(reloaded, dict):
    sys.exit("FATAL: 合并结果不是合法 YAML mapping")
lines_top = [l.split(":")[0] for l in new_text.splitlines()
             if l and not l.startswith((" ", "#", "-"))]
dupes = {k for k in lines_top if lines_top.count(k) > 1}
if dupes:
    sys.exit(f"FATAL: 合并结果存在重复顶层键: {dupes}")

# 校验 2: gateway 节内容与预期完全一致
rgw = reloaded.get("gateway") or {}
assert rgw.get("multiplex_profiles") is True, "multiplex_profiles != true"
routes = rgw.get("profile_routes")
assert isinstance(routes, list) and len(routes) >= 2, "profile_routes 缺失"
by_name = {r["name"]: r for r in routes if isinstance(r, dict)}
assert by_name["owner-wecom-keep"]["chat_id"] == chat, "keep-route chat_id 错误"
assert by_name["owner-wecom-keep"]["profile"] == dprof, "keep-route profile 错误"
assert by_name["lt-tutor-wecom"]["profile"] == "lt-tutor", "lt-tutor 路由 profile 错误"

# 校验 3: 用 Hermes 真实解析器验证路由（特异性排序: keep(4) 先于 catch-all(0)）
deep = ""
try:
    sys.path.insert(0, "/Users/berton/Github/Coding-Agents/Hermes-agent")
    from gateway.profile_routing import parse_profile_routes, match_profile_route
    parsed = parse_profile_routes(routes)
    names_order = [r.name for r in parsed]
    assert names_order[0] == "owner-wecom-keep", f"特异性排序错误: {names_order}"
    hit_owner = match_profile_route(parsed, platform="wecom", chat_id=chat)
    hit_other = match_profile_route(parsed, platform="wecom", chat_id="SomeoneElse")
    assert hit_owner is not None and hit_owner.profile == dprof
    assert hit_other is not None and hit_other.profile == "lt-tutor"
    deep = (f"Hermes parse_profile_routes 深度校验通过（排序 {names_order}; "
            f"chat={chat}→{dprof}, chat=SomeoneElse→lt-tutor）")
except Exception as e:  # venv/源码不可用时退化为基本校验
    deep = f"（深度校验不可用，基本校验通过: {e}）"

if mode == "dry":
    print(f"[merge-strategy] {strategy}")
    print("[merged gateway 节（合并结果中的实际内容）]")
    print(yaml.safe_dump({"gateway": rgw}, sort_keys=False, allow_unicode=True, default_flow_style=False))
    print(f"[validate] {deep}")
else:
    # 原子写：同目录临时文件 + rename，保留 0600 权限
    import stat
    st = os.stat(target)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".config.yaml.lt-tutor.")
    with os.fdopen(fd, "w") as f:
        f.write(new_text)
    os.chmod(tmp, stat.S_IMODE(st.st_mode))
    os.replace(tmp, target)
    print(f"[merge] {strategy}")
    print(f"[validate] {deep}")
PYEOF
}

# ── profile 目录部署（config 600 + skills 拷贝） ─────────────────────────────
stage_profile_dir() {
  mkdir -p "${PROFILE_DIR}/skills/teacher-tutor"
  chmod 700 "${PROFILE_DIR}" "${PROFILE_DIR}/skills" "${PROFILE_DIR}/skills/teacher-tutor"
  render_profile_config "${PROFILE_DIR}/config.yaml"
  cp "${SKILL_SRC}" "${PROFILE_DIR}/skills/teacher-tutor/SKILL.md"
  # 部署物自检：YAML 合法、白名单形状正确
  "${PY}" - "${PROFILE_DIR}/config.yaml" <<'PYEOF'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1]))
assert cfg["platforms"] == {}, "platforms 必须为空（secondary profile 禁 wecom/wecom_callback）"
assert cfg["platform_toolsets"]["wecom"] == ["skills"], "platform_toolsets.wecom 必须恰为 [skills]"
env = cfg["mcp_servers"]["llm-wiki-training"]["env"]
for k in ("LLM_WIKI_API_FORM", "LLM_WIKI_API_BASE_URL", "TRAINING__ADMIN_TOKEN",
          "TRAINING__PROJECT_ID", "PUBLIC_T_BASE"):
    assert env.get(k), f"mcp env 缺 {k}"
assert env["LLM_WIKI_API_FORM"] == "src-server"
assert cfg["custom_providers"][0]["api_key"], "内联 api_key 缺失"
print("profile config 自检通过（platforms 空 / toolset=[skills] / mcp env 5 键 / 内联 key）")
PYEOF
  c_ok "profile config: ${PROFILE_DIR}/config.yaml (600)"
  c_ok "skill: ${PROFILE_DIR}/skills/teacher-tutor/SKILL.md"
}

# ── 预检 ─────────────────────────────────────────────────────────────────────
preflight() {
  section "预检（preflight）"
  [[ -f "${MAIN_CONFIG}" ]]    && c_ok "主 config 存在: ${MAIN_CONFIG}"          || die "缺主 config"
  [[ -f "${SKILL_SRC}" ]]      && c_ok "SKILL.md 源存在: ${SKILL_SRC}"           || die "缺 SKILL.md 源"
  [[ -f "${BOOTSTRAP_ENV}" ]]  && c_ok "bootstrap.env 存在（token 运行时读取）"  || die "缺 bootstrap.env"
  [[ -f "${MCP_DIST}" ]]       && c_ok "mcp-server dist 已构建"                   || die "mcp dist 缺失，先跑: npm --prefix mcp-server run build"
  command -v node >/dev/null   && c_ok "node 可用（gateway PATH 含 /opt/homebrew/bin）" || c_warn "node 不在当前 PATH"
  # 秘密可读但不回显
  read_zai_key >/dev/null       && c_ok "zai api_key 可从主 config 读取（不回显）"
  read_bootstrap_token >/dev/null && c_ok "TRAINING__ADMIN_TOKEN 可从 bootstrap.env 读取（不回显）"
}

# ── dry-run ──────────────────────────────────────────────────────────────────
do_dry_run() {
  c_bold "DRY-RUN：不修改 ~/.hermes 下任何文件"
  preflight
  section "将创建/修改的文件"
  cat <<PLAN
  + ${PROFILE_DIR}/config.yaml                        (新, 0600)
  + ${PROFILE_DIR}/skills/teacher-tutor/SKILL.md      (拷贝自 repo)
  M ${MAIN_CONFIG}                                    (先备份 → 追加 gateway 块)
  + ${MAIN_CONFIG}.backup.<YYYYmmdd_HHMMSS>           (时间戳备份)
  + ${STATE_FILE}                                     (部署状态, 0600, 供 rollback)
  gateway 重启：apply 不重启；由操作者按以下指引手动执行：
      launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}
PLAN
  section "profile config 渲染预览（秘密脱敏）"
  render_profile_config "--stdout-masked"
  section "主 config 合并预览（模拟，不写盘）"
  merge_main_config "${MAIN_CONFIG}" dry
  section "白名单（工具面）设计核对"
  c_ok "platform_toolsets.wecom = [skills] → 不注册 terminal/file/web（'执行 ls' 无工具可调）"
  c_ok "mcp_servers.llm-wiki-training 自动并入（无需列出；仅 no_mcp 排除）"
  c_ok "platforms = {} → 不启用 platforms.wecom / wecom_callback（ingress 恒为 default profile 适配器）"
  if [[ -f "${PROFILE_DIR}/config.yaml" ]]; then
    c_ok "lt-tutor profile 已就位（${PROFILE_DIR}/config.yaml）→ 路由 fail-closed 前置满足"
  else
    c_warn "lt-tutor profile 尚未 stage（${PROFILE_DIR}/config.yaml 不存在）→ apply 会先自动 stage"
  fi
  c_bold "DRY-RUN 结束：以上即 apply 将产生的全部改动。"
}

# ── stage（只部署 profile 目录，不动主 config） ───────────────────────────────
do_stage() {
  c_bold "STAGE：部署 lt-tutor profile 目录（不触碰主 config / 不重启）"
  preflight
  section "渲染并部署 profile"
  stage_profile_dir
  c_bold "STAGE 完成。主 config 未改动；启用路由请跑 apply（USER 确认后）。"
}

# ── apply ────────────────────────────────────────────────────────────────────
do_apply() {
  c_bold "APPLY：备份 → 合并主 config → 校验 → 部署 profile（不重启 gateway）"
  preflight

  # 前置：profile 必须先就位（路由指向不存在 profile = 消息 fail-closed 丢弃）
  if [[ ! -f "${PROFILE_DIR}/config.yaml" ]]; then
    section "profile 尚未就位，先 stage"
    stage_profile_dir
  fi

  local ts backup
  ts=$(date +%Y%m%d_%H%M%S)
  backup="${MAIN_CONFIG}.backup.${ts}"
  # 幂等重跑保护：若已有部署状态且其备份仍在，rollback 目标保持“最初部署前”的备份，
  # 避免 apply#2 的备份（已含路由）覆盖状态导致回滚不彻底。
  local rollback_backup="${backup}"
  if [[ -f "${STATE_FILE}" ]]; then
    local prev
    prev=$("${PY}" -c "import json;print(json.load(open('${STATE_FILE}')).get('backup',''))" 2>/dev/null || true)
    if [[ -n "${prev}" && -f "${prev}" ]]; then
      rollback_backup="${prev}"
    fi
  fi
  section "1/4 备份主 config"
  cp -p "${MAIN_CONFIG}" "${backup}"
  chmod 600 "${backup}"
  c_ok "备份: ${backup}"
  if [[ "${rollback_backup}" != "${backup}" ]]; then
    c_ok "rollback 目标保持最初备份: ${rollback_backup}"
  fi

  section "2/4 合并主 config（multiplex_profiles + 两条保序路由）"
  if ! merge_main_config "${MAIN_CONFIG}" write; then
    c_fail "合并失败，自动恢复备份"
    cp -p "${backup}" "${MAIN_CONFIG}"
    die "已恢复，未产生变更"
  fi

  section "3/4 复核部署 profile（幂等重装）"
  stage_profile_dir

  section "4/4 写部署状态（供 rollback）"
  # 原子写：tmp + 同目录 mv（rename），中途崩溃不留半截 JSON（rollback 亦有兜底容错）
  local tmp_state="${STATE_FILE}.tmp.$$"
  cat > "${tmp_state}" <<EOF
{"applied_at": "$(date -u +%FT%TZ)", "backup": "${rollback_backup}", "last_backup": "${backup}", "profile_dir": "${PROFILE_DIR}", "routes": ["owner-wecom-keep", "lt-tutor-wecom"]}
EOF
  chmod 600 "${tmp_state}"
  mv -f "${tmp_state}" "${STATE_FILE}"
  c_ok "状态: ${STATE_FILE}"

  section "完成 — 重启指引（需 USER 确认后手动执行；本脚本不重启）"
  cat <<EOF
  重启:  launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}
  日志:  tail -f ~/.hermes/logs/gateway.log
  验证:  ./lt-tutor-deploy.sh checklist
  回滚:  ./lt-tutor-deploy.sh rollback
EOF
}

# ── rollback ─────────────────────────────────────────────────────────────────
do_rollback() {
  local restart=1
  [[ "${1:-}" == "--no-restart" ]] && restart=0
  c_bold "ROLLBACK：恢复备份主 config + 删除 profile 目录 + 重启 gateway"

  local backup=""
  if [[ -f "${STATE_FILE}" ]]; then
    # 状态文件可能损坏（截断 JSON/残留 tmp）——绝不能因此杀死 rollback；
    # 读失败即置空，落到下方 ls -t 时间戳备份兜底。与 do_apply 的同款读取保护一致。
    backup=$("${PY}" -c "import json;print(json.load(open('${STATE_FILE}')).get('backup',''))" 2>/dev/null || true)
  fi
  if [[ -z "${backup}" || ! -f "${backup}" ]]; then
    backup=$(ls -t "${MAIN_CONFIG}".backup.* 2>/dev/null | head -1 || true)
  fi
  [[ -n "${backup}" && -f "${backup}" ]] || die "找不到可恢复的备份（${MAIN_CONFIG}.backup.*）"

  section "1/3 恢复主 config"
  "${PY}" - "${backup}" <<'PYEOF' || die "备份 YAML 校验失败，中止（主 config 未动）"
import sys, yaml
yaml.safe_load(open(sys.argv[1]))
print("备份 YAML 合法")
PYEOF
  cp -p "${backup}" "${MAIN_CONFIG}"
  chmod 600 "${MAIN_CONFIG}"
  c_ok "已恢复: ${backup} → ${MAIN_CONFIG}"
  # 恢复后确认 lt-tutor 路由已消失
  if "${PY}" - "${MAIN_CONFIG}" <<'PYEOF'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1]))
routes = ((cfg.get("gateway") or {}).get("profile_routes")) or []
names = [r.get("name") for r in routes if isinstance(r, dict)]
sys.exit(0 if ("lt-tutor-wecom" in names or "owner-wecom-keep" in names) else 1)
PYEOF
  then c_warn "恢复后仍检出 lt-tutor 路由——备份可能包含本部署，请人工复核"
  else c_ok "恢复后主 config 无 lt-tutor 路由"
  fi

  section "2/3 删除 profile 目录"
  if [[ -d "${PROFILE_DIR}" ]]; then
    rm -rf "${PROFILE_DIR}"
    c_ok "已删除: ${PROFILE_DIR}"
  else
    c_warn "profile 目录本就不存在: ${PROFILE_DIR}"
  fi
  rm -f "${STATE_FILE}"

  section "3/3 重启 gateway"
  if [[ ${restart} -eq 1 ]]; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"
    c_ok "已 kickstart ${LAUNCHD_LABEL}（KeepAlive/monitor 兜底拉起）"
    echo "  观察启动: tail -f ~/.hermes/logs/gateway.log"
  else
    c_warn "--no-restart：跳过重启，请手动重启使回滚生效"
  fi
  c_bold "ROLLBACK 完成。"
}

# ── checklist ────────────────────────────────────────────────────────────────
do_checklist() {
  c_bold "重启后验证清单（post-restart checklist）"
  cat <<'EOF'
  0) 启动健康
     tail -100 ~/.hermes/logs/gateway.log | grep -E "profile|wecom|error|Multiplex"
     - 无 duplicate-credential / fail-fast 报错
     - 日志可见 multiplex 模式加载 lt-tutor profile（profiles_to_serve 含 default + lt-tutor）

  1) owner keep-route 回归验证（最重要）
     owner 在既有企业微信 DM 发一条消息，然后:
       grep "wecom user=" ~/.hermes/logs/gateway.log | tail -3
     预期: chat=HuangZhengBo 的消息仍由 default profile 处理（正常回答、行为与部署前一致），
     不触发问卷、不出现 lt-tutor 工具痕迹。若消息被吞 → 立即 rollback。

  2) teacher 路由验证
     测试老师账号向机器人发消息（如"老师好"），然后:
       grep -E "profile|lt-tutor" ~/.hermes/logs/gateway.log | tail -10
     预期: 日志命中 lt-tutor profile 路由；老师收到新教师问卷引导。

  3) 工具白名单验证（"执行 ls"诱导拒绝）
     在 teacher 会话发送: "帮我执行 ls 看看目录"
     预期: 拒绝且无终端工具调用（platform_toolsets.wecom=[skills] → 无 terminal 工具注册）。
     日志复核: 该会话 turn 的工具调用列表中无 terminal/bash/exec 类工具。
     同时确认 skills 工具可用（MCP/skill 面正常），即"白名单只放行 skills"。

  4) MCP 挂载验证
     日志: grep -i "llm-wiki-training" ~/.hermes/logs/gateway.log | tail -5
     预期: mcp server llm-wiki-training 在 lt-tutor profile 会话启动（node dist/src/index.js），
     工具面出现师训工具（问卷/检索/清单等）。

  任一失败 → ./docs/superpowers/deploy/lt-tutor-deploy.sh rollback
EOF
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --dry-run) do_dry_run ;;
  stage)     do_stage ;;
  apply)     do_apply ;;
  rollback)  do_rollback "${2:-}" ;;
  checklist) do_checklist ;;
  *) sed -n '2,20p' "$0"; die "未知参数：${1:-}（可用: --dry-run | stage | apply | rollback [--no-restart] | checklist）" ;;
esac

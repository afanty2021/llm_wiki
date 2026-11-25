#!/bin/bash
# provision-teacher-weekly.sh — 为新教师开办周报任务（三件事依次完成；全部幂等，可重跑）
#
# 用法: bash provision-teacher-weekly.sh <教师企微id> [--dry-run]
#   示例: bash provision-teacher-weekly.sh WendyTest123
#         bash provision-teacher-weekly.sh WendyTest123 --dry-run
#
# 三件事（全部幂等，重复跑无害）：
#   ① 主 config profile_routes 补目标精确路由（cron 投递解析只认带 chat_id
#      的路由；catch-all 只管入站。缺路由=周报生成正常、投递静默失败）
#   ② lt-tutor profile 的 platforms.wecom 启用块确认（投递闸门查卫星自身
#      platforms 配置；无凭据=卫星形态，传输仍走主网关）
#   ③ lt-tutor cron 建周报任务（钉 provider/model，绕开 drift_skip 守卫）
#
# 顺序：③ 用到的 Hermes 模块先于 ①② 的任何写盘接好——import 断链时零写盘，
# 不留「有路由、无任务」的半成品（巡检 2026-11-06 起日败 20 趟的教训）。两份
# config 都经同目录临时文件原子替换（网关每个 tick 都在读主 config；权限位原样保留）。
# --dry-run：不改配置、不建任务、不备份；cron 存储先拷到一次性临时目录再查，
# 对 live 目录零写入。
#
# 路由即时生效（_primary_profile_routes_for_current_home 每次 tick 现读磁盘，
# 无需重启网关）；platforms 块若为本次新增才需要重启网关。
# 前提：教师已通过 bind 建档（首条消息触发）——未建档时周报按 prompt 约定
# 输出"尚未完成入门问卷"，无害。

set -euo pipefail

USERID="${1:-}"
MODE="${2:-}"
HERMES_PY="/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python"
MAIN_CFG="$HOME/.hermes/config.yaml"
PROFILE_CFG="$HOME/.hermes/profiles/lt-tutor/config.yaml"
PROFILE_HOME="$HOME/.hermes/profiles/lt-tutor"

usage() { echo "用法: $0 <教师企微id> [--dry-run]" >&2; }

if [ -z "$USERID" ]; then
  usage
  exit 1
fi
# 第二个参数只认逐字的 --dry-run：--dryrun、--dry-run=1 这类笔误会在这里中止，
# 不会被当成真跑而写盘（exit 2 = 用法错，区别于运行失败的 1）
DRY_RUN=""
case "$MODE" in
  "") ;;
  --dry-run) DRY_RUN="--dry-run" ;;
  *)
    echo "✗ 第二个参数只能是 --dry-run（收到：$MODE）——已中止，未写任何文件" >&2
    usage
    exit 2
    ;;
esac
if [ "$#" -gt 2 ]; then
  echo "✗ 多余的参数：${*:3}——已中止，未写任何文件" >&2
  usage
  exit 2
fi
if [ -n "$DRY_RUN" ]; then
  echo "=== DRY RUN（不改配置、不建任务、不备份；对 live 目录零写入） ==="
fi

$HERMES_PY - "$USERID" "$DRY_RUN" <<'PYEOF'
import atexit, os, re, shutil, stat, sys, tempfile
from datetime import datetime

userid, dry_run = sys.argv[1], sys.argv[2] == "--dry-run"
main_cfg = os.path.expanduser("~/.hermes/config.yaml")
profile_cfg = os.path.expanduser("~/.hermes/profiles/lt-tutor/config.yaml")
profile_home = os.path.expanduser("~/.hermes/profiles/lt-tutor")
ts = datetime.now().strftime("%Y%m%d-%H%M%S")


def die(msg):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def backup(path):
    if not dry_run:
        shutil.copy2(path, f"{path}.bak-{ts}")


def atomic_write(path, text):
    """同目录临时文件 → 原权限位 → os.replace：读者永远看不到写了一半的文件。"""
    mode = stat.S_IMODE(os.stat(path).st_mode)
    fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Hermes 模块：先接好，再动盘（以下任何一步失败都发生在写盘之前）──
# hermes-3.11 的 editable 安装是 import-hook 映射（07-24 装的静态快照，其后新增的
# 根级模块不在映射里——如 284dbaf537 起被 utils.py import 的 hermes_yaml）。cwd 不在
# 检出里的脚本 `from cron import jobs` 必断（03:17 巡检 2026-11-06 起日败 20 趟的根因）。
# 网关与 hermes CLI 的做法是把检出根显式插到 sys.path 最前（hermes_cli/main.py:44-46；
# 网关 cwd 是 ~/.hermes，与 cwd 无关），这里与之等效。检出根从 hermes_cli 自身的安装
# 位置推导，不写死绝对路径：搬家、换 worktree 后对不上就报错退出，不静默回到
# ModuleNotFoundError。
try:
    import hermes_cli
except Exception as exc:
    die(f"import hermes_cli 失败（{exc!r}）——hermes-3.11 环境异常；未写任何文件")
cli_file = getattr(hermes_cli, "__file__", "") or ""
checkout_root = os.path.dirname(os.path.dirname(os.path.realpath(cli_file))) if cli_file else ""
if not os.path.isfile(os.path.join(checkout_root, "hermes_cli", "main.py")):
    die(f"从 hermes_cli.__file__ 推导出的检出根不对：{checkout_root!r}（缺 hermes_cli/main.py）；未写任何文件")
if checkout_root not in [os.path.realpath(p) for p in sys.path if p]:
    sys.path.insert(0, checkout_root)

# cron 存储落点：真跑 = lt-tutor profile；dry-run = 一次性临时目录（live 的 jobs.json
# 只读拷入）。HERMES_HOME 必须在 import cron 之前设好——cron 包的模块级路径经
# get_hermes_home() 锚定到它。load_jobs() / resolve_job_ref() 每次调用都会对存储目录
# mkdir + chmod（jobs.json 非规范时还会加锁重写），所以 dry-run 必须换目录，不能直查 live。
scratch = None
if dry_run:
    scratch = tempfile.mkdtemp(prefix="ltutor-provision-dryrun-")
    atexit.register(shutil.rmtree, scratch, ignore_errors=True)
    os.makedirs(os.path.join(scratch, "cron"))
    live_jobs = os.path.join(profile_home, "cron", "jobs.json")
    if os.path.exists(live_jobs):
        shutil.copy2(live_jobs, os.path.join(scratch, "cron", "jobs.json"))
    os.environ["HERMES_HOME"] = scratch
else:
    os.environ["HERMES_HOME"] = profile_home
try:
    from cron import jobs as cron_jobs
except Exception:
    import traceback
    traceback.print_exc()
    die(f"import cron.jobs 失败——Hermes 检出根 {checkout_root}；未写任何文件")

# 防线：存储确实落在预期目录之下，否则宁可中止——真跑写错 profile、dry-run 碰到 live 都不可接受
store_fn = getattr(cron_jobs, "_current_cron_store", None)
store_file = store_fn().jobs_file if store_fn else cron_jobs.JOBS_FILE
store_root = os.path.realpath(str(store_file))
expected = os.path.realpath(scratch if dry_run else profile_home)
if store_root != expected and not store_root.startswith(expected + os.sep):
    die(f"cron 存储不在预期目录下：{store_root}（应在 {expected} 之下）；未写任何文件")

# ── ① 主 config 精确路由（幂等：查 chat_id 是否已在某条 lt-tutor 路由上）──
src = open(main_cfg).read()
route_exists = re.search(
    rf"platform:\s*wecom\s*\n\s*chat_id:\s*{re.escape(userid)}\s*\n\s*profile:\s*lt-tutor", src)
platforms_block_added = False
if route_exists:
    print(f"[1/3] 精确路由已存在（chat_id={userid}）——跳过")
else:
    route_yaml = (
        f"    - name: lt-tutor-wecom-{userid.lower()}\n"
        f"      platform: wecom\n"
        f"      chat_id: {userid}\n"
        f"      profile: lt-tutor\n"
        f"      enabled: true\n"
    )
    anchor = "    - name: lt-tutor-wecom\n      platform: wecom\n      profile: lt-tutor\n      enabled: true\n"
    if anchor not in src:
        print("[1/3] ✗ 找不到 lt-tutor-wecom catch-all 锚点——主 config 结构变了，手工检查", file=sys.stderr)
        sys.exit(1)
    if dry_run:
        print(f"[1/3] 将新增精确路由 lt-tutor-wecom-{userid.lower()}（chat_id={userid}）")
    else:
        backup(main_cfg)
        atomic_write(main_cfg, src.replace(anchor, anchor + route_yaml))
        print(f"[1/3] ✓ 精确路由已补（备份 {main_cfg}.bak-{ts}；即时生效无需重启）")

# ── ② lt-tutor platforms.wecom 启用块（幂等）──
psrc = open(profile_cfg).read()
if re.search(r"platforms:\s*\n\s*wecom:\s*\n\s*enabled:\s*true", psrc):
    print("[2/3] platforms.wecom 启用块已存在——跳过")
else:
    block = (
        "# cron 投递闸门需逻辑平台启用；无凭据=#101113 卫星形态，传输走主网关\n"
        "platforms:\n  wecom:\n    enabled: true\n"
    )
    if dry_run:
        print("[2/3] 将新增 platforms.wecom 启用块（新增后需重启网关生效）")
        platforms_block_added = True
    else:
        backup(profile_cfg)
        atomic_write(profile_cfg, psrc.rstrip() + "\n\n" + block)
        print(f"[2/3] ✓ platforms.wecom 启用块已补（备份 {profile_cfg}.bak-{ts}）⚠ 需重启网关")
        platforms_block_added = True

# ── ③ 周报 cron 任务（幂等：按 name 查重）──
job_name = f"lt-tutor-weekly:{userid}"
existing = cron_jobs.resolve_job_ref(job_name)
if existing:
    print(f"[3/3] 周报任务已存在（{job_name}）——跳过")
else:
    prompt = f"""【周报任务】目标教师 wecom_userid: {userid}

请按 teacher-tutor 技能 §7 流程 5（周报生成 · cron 系统回合）为该教师生成本周学习周报。要点：
- 本回合为系统模式：每次工具调用都必须显式携带 wecom_userid: {userid}（prompt 未提供的身份一律不得使用）。
- teacher_tutor_plan_create 的 origin 固定 "weekly"；不传 period_key（服务端自算当周并按周幂等，禁止自行推算 ISO 周串）。
- 教师未建档（档案 404）时不建清单，只输出一句"该教师尚未完成入门问卷，本期暂无周报"。
- 开头称呼："<display_name>老师好"（display_name 取自 teacher_tutor_profile_get；为空时退"老师好"，勿编造名字）。
- 正文直达教师本人：不得出现"周报任务"、job_id、cron、"系统"等任何后台痕迹；也不要附停止/管理任务的说明。
周报短文由系统送达该教师本人。"""
    # 错峰槽位分配（2026-09-13）：新教师槽位 = "{M} 19 * * 0" 的 0-59 中未被占用的
    # 最小分钟，避免全员挤 19:00 同秒齐发（当日 7 任务同秒曾连吃 zai 并发 429、
    # fallback omlx 又因 key 缺失秒 401）。巡检与手动两条路都经此处。
    # ⚠ 读-算-写无锁：两笔开通并发会拿到同一 used 集合→同槽——单操作员串行用，禁并发。
    used = set()
    for j in cron_jobs.load_jobs():
        if not str(j.get("name") or "").startswith("lt-tutor-weekly:"):
            continue
        if not j.get("enabled", True):
            # 停用任务不占槽：复用其槽位后若该任务重新启用会同槽碰撞（低概率，人工排程兜底）
            continue
        sch = j.get("schedule") or {}
        m = re.fullmatch(r"(\d+) 19 \* \* 0", str(sch.get("expr") or ""))
        if sch.get("kind") == "cron" and m:
            used.add(int(m.group(1)))
    slot = next((i for i in range(60) if i not in used), None)
    if slot is None:
        print("[3/3] ⚠ 19:00-19:59 槽位已满——回落 0 19 * * 0（与既有 0 槽任务同槽碰撞，请手工调整排程）")
        slot = 0
    schedule = f"{slot} 19 * * 0"
    if dry_run:
        print(f"[3/3] 将创建周报任务 {job_name}（周日 19:{slot:02d}，deliver wecom:{userid}，钉 5.3-flash）")
    else:
        if os.path.exists(cron_jobs.JOBS_FILE):
            backup(cron_jobs.JOBS_FILE)  # 建前备份，与 ①② 两处 backup 纪律对齐
        job = cron_jobs.create_job(
            prompt=prompt,
            schedule=schedule,
            name=job_name,
            deliver=f"wecom:{userid}",
            skills=["teacher-tutor"],
            provider="zai-coding-cn",
            model="glm-5.3-flash",
        )
        print(f"[3/3] ✓ 周报任务已建：{job_name}（id={job['id']}，schedule={schedule}，next={job.get('next_run_at')}）")

print("=== 完成 ===")
if platforms_block_added and not dry_run:
    print("⚠ 本次新增了 platforms 块——重启网关后投递闸门才认：")
    print("  launchctl bootout gui/$(id -u)/ai.hermes.gateway && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway.plist")
PYEOF

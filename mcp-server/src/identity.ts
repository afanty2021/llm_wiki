/**
 * 会话身份硬闸（M3 T2）。
 *
 * 消费 Hermes（T1 补丁）在 MCP tools/call 注入的 `request.params._meta` 会话身份，
 * 判定本次工具调用的授权身份，三种出口（判定序即安全序）：
 *
 * ① 用户模式：`hermes_platform=="wecom"` 且 `hermes_user_id` 非空 → 授权身份 =
 *    `hermes_user_id`（模型可见的只有 arguments，_meta 出自 Hermes contextvars，不可注入）。
 *    args `wecom_userid` 省略 → 直接用；给出且相等 → 通过；给出且不等 → IdentityMismatch
 *    （硬拒，不降级不重试——冒名/注入的唯一结局）。
 * ② `hermes_platform=="wecom"` 但 `hermes_user_id` 为空 → IdentityUnavailable（硬拒）。
 *    合法流量不存在此组合（cron 回合连 platform 一并清空走 ③）；落系统模式 = 交互流量
 *    被诱导降级的唯一残余通道 → fail-closed。
 * ③ 系统模式：meta 缺失或 platform 非 wecom（cron 周报 / 运维 / cli 直连调试）→ 必须显式
 *    `wecom_userid` 参数，否则 ToolArgumentError。
 *
 * meta 形状可变（T1 空值键会被 truthiness 过滤省略）：以 hermes_user_id 存在性为准，
 * 不假设固定六键集。
 *
 * T2 主管越权门（视频学习任务）：`resolveIdentityWithSupervision` 在三出口之上加
 * supervisor 出口——白名单工具名常量与 admin 角色判定都在 training.ts 分发层完成
 * （异步 member-role 查询注入），本模块保持同步纯函数、不引入任何网络依赖、
 * 不持有工具名概念（toolName 只是输入，不是清单）。
 */

/** T1 注入的 `_meta`（六键 hermes_platform/user_id/user_name/chat_id/session_key/profile，可变）。 */
export interface MetaLike {
  hermes_platform?: unknown
  hermes_user_id?: unknown
  [key: string]: unknown
}

export type IdentityMode = "user" | "system"

/** 身份来源（T2 主管门审计标记）：supervisor = admin 会话经白名单工具代目标教师操作。 */
export type IdentitySource = "user" | "system" | "supervisor"

export interface ResolvedIdentity {
  mode: IdentityMode
  /** 授权身份（凭证库 getAccess 用的 wecom_userid）。 */
  wecomUserid: string
  /** 身份来源（可选）：省略 = 既有三出口判定（展示侧回落 mode）；"supervisor" = 主管 override。 */
  identitySource?: IdentitySource
}

/** 系统模式下缺少显式 wecom_userid（映射 MCP InvalidParams）。 */
export class ToolArgumentError extends Error {}

/** args 身份与会话身份不符（硬拒不降级不重试）。 */
export class IdentityMismatchError extends Error {}

/** wecom 会话但会话身份缺失（fail-closed，不落系统模式）。 */
export class IdentityUnavailableError extends Error {}

/** 从低层 setRequestHandler 的 request.params._meta 提取对象形状 meta；非对象一律归 undefined。 */
export function extractRequestMeta(value: unknown): MetaLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MetaLike : undefined
}

/**
 * 身份判定（10 个 src-server 工具统一入口第一行调用）。
 * argsWecomUserid 传 undefined（省略）或字符串；空白串视为省略。
 */
export function resolveIdentity(
  meta: MetaLike | undefined,
  argsWecomUserid: string | undefined,
): ResolvedIdentity {
  // platform 归一大小写（评审 S2）：当前枚举源唯一（Platform.WECOM="wecom"），
  // 但上游漂移（新枚举/二次封装）写出 "WECOM" 时大小写敏感匹配会静默落系统
  // 模式 fail-open——归一后漂移仍落用户模式（fail-closed 方向）。
  const platform = typeof meta?.hermes_platform === "string" ? meta.hermes_platform.trim().toLowerCase() : ""
  const sessionUserid = typeof meta?.hermes_user_id === "string" ? meta.hermes_user_id.trim() : ""
  const argsUserid = typeof argsWecomUserid === "string" ? argsWecomUserid.trim() : ""

  if (platform === "wecom") {
    if (sessionUserid === "") {
      // ② 会话上下文丢失/伪造/配置错误——不存在合法降级路径
      throw new IdentityUnavailableError(
        "wecom session carries no hermes_user_id: identity unavailable, refusing call "
        + "(no fallback to system mode; check Hermes session context)",
      )
    }
    if (argsUserid !== "" && argsUserid !== sessionUserid) {
      // ① 硬拒：会话身份已锁定，参数身份不得替换（冒名/注入唯一结局）
      throw new IdentityMismatchError(
        `wecom_userid "${argsUserid}" does not match session identity "${sessionUserid}": `
        + "refusing call (session identity is locked; no override, no retry)",
      )
    }
    return { mode: "user", wecomUserid: sessionUserid }
  }

  // ③ 系统模式（meta 缺失或 platform 非 wecom）：必须显式 wecom_userid
  if (argsUserid === "") {
    throw new ToolArgumentError("wecom_userid is required for system calls")
  }
  return { mode: "system", wecomUserid: argsUserid }
}

/**
 * wecom 会话且会话身份可用（training.ts roster_search admin 闸的适用性判定；
 * platform/user_id 归一逻辑与 resolveIdentity 同源，纯读 meta、无 IO）。
 */
export function hasWecomSessionIdentity(meta: MetaLike | undefined): boolean {
  const platform = typeof meta?.hermes_platform === "string" ? meta.hermes_platform.trim().toLowerCase() : ""
  const sessionUserid = typeof meta?.hermes_user_id === "string" ? meta.hermes_user_id.trim() : ""
  return platform === "wecom" && sessionUserid !== ""
}

/**
 * 会话身份原文（去空白；无则空串）——分发层主管门 member-role 查询的目标。
 */
export function sessionWecomUserid(meta: MetaLike | undefined): string {
  return typeof meta?.hermes_user_id === "string" ? meta.hermes_user_id.trim() : ""
}

/** resolveIdentityWithSupervision 的调用选项。toolName 仅为输入（错误文案/审计用）——
 * 白名单常量在 training.ts 分发层（计划决策③：identity.ts 不持有工具名概念），
 * 分发层只对白名单工具在身份冲突时调用本函数；isCallerAdmin 由分发层先行完成
 * 异步 member-role 查询后注入。 */
export interface SupervisionOptions {
  toolName: string
  isCallerAdmin: boolean
}

/**
 * 主管越权判定（T2，同步纯函数）：语义 = resolveIdentity 三出口 + supervisor 出口。
 * 仅当 wecom 会话身份与 args 身份冲突且 isCallerAdmin===true → 返回目标教师身份
 * （identitySource:"supervisor"，响应尾 identity_source 如实标记，审计可辨）；
 * 冲突 + 非 admin → IdentityMismatchError（照拒，非 admin/非白名单同款硬拒）；
 * args 空白/等于会话身份、系统模式、会话身份缺失 → resolveIdentity 现行为原样
 * （含 IdentityUnavailable/ToolArgumentError 透传）。不做任何 IO。
 */
export function resolveIdentityWithSupervision(
  meta: MetaLike | undefined,
  argsWecomUserid: string | undefined,
  opts: SupervisionOptions,
): ResolvedIdentity {
  try {
    return resolveIdentity(meta, argsWecomUserid)
  } catch (err) {
    if (!(err instanceof IdentityMismatchError)) throw err
    if (opts.isCallerAdmin === true) {
      // 走到这里仅当冲突（platform=wecom、会话身份在、args 非空且 ≠ 会话）——
      // resolveIdentity 其余出口已被排除，argsUserid 此处必非空
      const argsUserid = typeof argsWecomUserid === "string" ? argsWecomUserid.trim() : ""
      return { mode: "user", wecomUserid: argsUserid, identitySource: "supervisor" }
    }
    throw new IdentityMismatchError(
      `wecom_userid override on ${opts.toolName} requires an admin/owner session: `
      + "refusing call (caller is not a team admin; session identity stays locked)",
    )
  }
}

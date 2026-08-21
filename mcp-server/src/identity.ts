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
 */

/** T1 注入的 `_meta`（六键 hermes_platform/user_id/user_name/chat_id/session_key/profile，可变）。 */
export interface MetaLike {
  hermes_platform?: unknown
  hermes_user_id?: unknown
  [key: string]: unknown
}

export type IdentityMode = "user" | "system"

export interface ResolvedIdentity {
  mode: IdentityMode
  /** 授权身份（凭证库 getAccess 用的 wecom_userid）。 */
  wecomUserid: string
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

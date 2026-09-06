#!/usr/bin/env node
/**
 * llm-wiki-admin — LT 师训管理面 MCP server（独立进程，仅 default/管理工具面挂载）。
 *
 * 为什么独立于 llm-wiki-training：Hermes platform_toolsets 白名单粒度是 MCP
 * server 名级——管理工具若混入 training server，lt-tutor 教师回合（wecom 白名单
 * [skills, llm-wiki-training]）会连同教师工具一起看到它，教师可窥全局学习数据。
 * 独立 server 后：default profile（platform_toolsets 无 wecom 条目 = 全量工具面）
 * 可用；lt-tutor/zops 的 server 级白名单天然把本 server 挡在教师/运维回合之外。
 *
 * 单工具 training_overview：GET /api/v1/training/overview（TRAINING__ADMIN_TOKEN
 * 鉴权）+ 本地渲染紧凑中文摘要（测试残渣档案折叠计数不逐行输出）。
 * 起因（2026-09-06）：管理员在 default profile 问「现在有几位老师在学习」，
 * 模型 16 个工具回合试错（教师工具语义不匹配）后落到 shell 直查并卡危险命令
 * 审批，217.8s 才答出——管理面问题需要管理面工具，一跳可答。
 *
 * 只读、无凭证存储、无状态：多实例无害（对照 llm-wiki-training 的 MCP 单实例
 * 约束——那是由 per-teacher 凭证缓存/bind 轮换驱动的）。
 */
import { pathToFileURL } from "node:url"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"

import { LlmWikiApiClient } from "./api-client.js"
import type { ToolDefinition, ToolOutput } from "./training.js"
import { VERSION } from "./version.js"

export function adminToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "training_overview",
      description:
        "Read-only admin overview of the LT teacher-training system: per-teacher "
        + "learning-plan/item/event aggregates with a 7-day window (teacher count, "
        + "onboarding states, viewed/completed items, last activity). Answers questions "
        + "like 「现在有几位老师在学习」「老师们的学习进度怎么样」. No parameters.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ]
}

// ── 响应形状（src-server routes/training.rs OverviewResponse）──

export interface OverviewItemCounts {
  total?: number
  viewed?: number
  completed?: number
}

export interface OverviewTeacherRow {
  wecom_userid?: string
  display_name?: string | null
  onboarding_state?: string
  plans_total?: number
  items?: OverviewItemCounts
  items_7d?: OverviewItemCounts
  last_active_at?: string | null
  last_ask_at?: string | null
}

export interface OverviewPayload {
  teachers?: OverviewTeacherRow[]
  generated_at?: string
}

// 测试残渣过滤：与 tools/ltutor/auto-provision-weekly.sh 同源（tN_ 前缀/纯重复
// 字符），另加两条 admin 面专用判据（总览直接进管理问答，噪声即错误答案）：
//   ① 短周期重复整串（"Yu"×7、"名"×100、"王a"×22 等 unique() 长度/并发测试产物）
//      ——重复单元 ≤2 字符且整串 ≥8 才判：残渣生成器单元均 ≤2；lingling/fangfang
//      类真人叠名拼音单元 ≥3，必须放行（评审 M2：周期≤4 旧判据实跑误折叠真人）。
//      单字符任意长度重复由 REPEATED_CHAR_RE 常开兜底。
//   ② unique() 的 `_{pid}_{n}` 大数字尾缀——pid 至少 2 位起（评审 M1：macOS 重启
//      后 pid 从 ~100 起，3-4 位常见，_\d{5,} 旧判据漏 t6_lw_9999_3 实锤）；
//      真人企微 id 双数字尾缀形态罕见。
// 注意：teacher_profiles.wecom_userid 存裸 id（wecom_ 前缀在 users.username），
// 匹配前统一归一到 prefixed 形态（live 探针实证）。
const TEST_USERID_RE = /^wecom_(t[0-9]+_|test|smoke|ctrl|restore)/
const REPEATED_CHAR_RE = /^wecom_(.)\1+_/
const PID_SUFFIX_RE = /_\d{2,}_\d+$/

function isPeriodicRepetition(uid: string): boolean {
  if (uid.length < 8) return false
  for (const period of [1, 2]) {
    if (uid.length % period !== 0) continue
    const unit = uid.slice(0, period)
    if (unit.repeat(uid.length / period) === uid) return true
  }
  return false
}

function fmtCounts(c: OverviewItemCounts | undefined): string {
  return `${c?.total ?? 0}(看${c?.viewed ?? 0}/完${c?.completed ?? 0})`
}

const LOCAL_TZ = "Asia/Shanghai"

/** UTC/带偏移 ISO → 上海本地 `YYYY-MM-DD HH:mm`；空返回 null、无法解析返回 null
 * （调用方回落原文，防上游格式漂移把时间渲染成 null）。总览的消费方是管理问答，
 * 原样透传 UTC 串会被模型当本地时间拼进回复（2026-09-07 00:35 实锺：last_active
 * `…T16:23Z` 被渲染成"今天 16:23"，实为昨晚 00:23——差 8 小时且日期错）。 */
function fmtLocalTime(raw: string | null | undefined): string | null {
  const iso = (raw ?? "").trim()
  if (iso === "") return null
  const normalized = iso.includes(" ") && !iso.includes("T") ? iso.replace(" ", "T") : iso
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: LOCAL_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** 展示字段清洗（评审 I2）：display_name 教师可自设（PUT /profile 不拦换行），
 * 原样拼接可注 `\n- ` 伪造总览行；折叠一切空白 + 全角竖线转半角（竖线是本渲染
 * 的字段分隔符）。uid 同洗（bind 侧仅校验长度）。 */
function sanitizeDisplay(value: string): string {
  return value.replace(/\s+/g, " ").replace(/｜/g, "|")
}

/** overview JSON → 紧凑中文摘要。真实档案逐行；测试/过滤档案折叠为计数。 */
export function renderOverview(data: OverviewPayload): string {
  const rows = Array.isArray(data.teachers) ? data.teachers : []
  const real: OverviewTeacherRow[] = []
  let filteredCount = 0
  for (const row of rows) {
    // teacher_profiles.wecom_userid 存裸 id（wecom_ 前缀在 users.username，bind
    // 双表两形态）；过滤口径统一归一到 prefixed 形态再匹配（live 探针实证）。
    const raw = typeof row.wecom_userid === "string" ? row.wecom_userid : ""
    const uid = raw.replace(/^wecom_/, "")
    if (
      TEST_USERID_RE.test(`wecom_${uid}`)
      || REPEATED_CHAR_RE.test(`wecom_${uid}`)
      || PID_SUFFIX_RE.test(uid)
      || isPeriodicRepetition(uid)
    ) {
      filteredCount += 1
      continue
    }
    real.push(row)
  }
  const surveyed = real.filter((r) => r.onboarding_state === "surveyed")
  const withActivity = real.filter((r) => (r.last_active_at ?? "").trim() !== "")

  const lines: string[] = ["# LT 师训总览"]
  if (typeof data.generated_at === "string" && data.generated_at !== "") {
    const snap = fmtLocalTime(data.generated_at)
    lines.push(snap !== null ? `快照：${snap}（UTC+8）` : `快照：${data.generated_at}`)
  }
  lines.push(
    `真实档案 ${real.length} 个（surveyed ${surveyed.length}、其余 ${real.length - surveyed.length}），`
    + `有学习活动记录 ${withActivity.length} 位`
    + (filteredCount > 0 ? `；测试/过滤形态档案 ${filteredCount} 个未逐行列出` : "")
    + "。",
    "",
  )
  for (const r of real) {
    // 展示 uid 同样兼容裸/prefixed 两形态，展示字段过清洗
    const uid = sanitizeDisplay((r.wecom_userid ?? "").replace(/^wecom_/, ""))
    const name = sanitizeDisplay((r.display_name ?? "").trim()) || uid || "?"
    lines.push(
      `- ${name}(${uid}) [${r.onboarding_state ?? "?"}] 计划 ${r.plans_total ?? 0}`
      + `｜条目 ${fmtCounts(r.items)}｜近7d计划条目 ${fmtCounts(r.items_7d)}`
      + `｜最近活跃 ${fmtLocalTime(r.last_active_at) ?? r.last_active_at ?? "无"}`
      + `｜最近提问 ${fmtLocalTime(r.last_ask_at) ?? r.last_ask_at ?? "无"}`,
    )
  }
  if (real.length === 0) lines.push("（无真实教师档案）")
  return lines.join("\n")
}

export interface AdminHandlerDeps {
  client: LlmWikiApiClient
  /** env TRAINING__ADMIN_TOKEN（惰性读取）。 */
  getAdminToken: () => string
}

export function createAdminHandler(deps: AdminHandlerDeps): () => Promise<ToolOutput> {
  return async () => {
    let data: Record<string, unknown>
    try {
      data = await deps.client.trainingOverview(deps.getAdminToken())
    } catch (err) {
      // 错误走正常返回而非抛 MCP 错误（评审 I1，镜像 read_file 404 / record_ask
      // 拒绝前例）：src-server 未起/token 错/5xx 是服务级问题，抛错会被 Hermes
      // 熔断器计入（3 次熔断 ~60s），把管理问答卡成假故障。
      const reason = err instanceof Error ? err.message : String(err)
      return {
        content: [{
          type: "text",
          text: `training_overview 暂不可用：src-server 请求失败（${reason}）。请稍后重试；持续失败请检查 src-server 服务（launchctl wiki.src-server）与 TRAINING__ADMIN_TOKEN 配置。`,
        }],
      }
    }
    return {
      content: [{ type: "text", text: renderOverview(data as OverviewPayload) }],
    }
  }
}

function main(): void {
  const adminToken = (process.env.TRAINING__ADMIN_TOKEN ?? "").trim()
  const baseUrl = (process.env.LLM_WIKI_API_BASE_URL ?? "").trim()
  if (!adminToken) {
    console.error("llm-wiki-admin: TRAINING__ADMIN_TOKEN is required")
    process.exit(1)
  }
  if (!baseUrl) {
    console.error(
      "llm-wiki-admin: LLM_WIKI_API_BASE_URL is required (src-server base, e.g. http://127.0.0.1:8080)",
    )
    process.exit(1)
  }

  const client = new LlmWikiApiClient({ baseUrl })
  const overview = createAdminHandler({ client, getAdminToken: () => adminToken })

  const server = new Server(
    { name: "llm-wiki-admin", version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: adminToolDefinitions(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "training_overview") {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
    }
    return overview()
  })

  void server.connect(new StdioServerTransport()).catch((err) => {
    console.error("llm-wiki-admin: failed to start:", err)
    process.exit(1)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

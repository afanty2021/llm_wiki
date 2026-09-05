import assert from "node:assert/strict"
import { test } from "node:test"

import { LlmWikiApiClient } from "../src/api-client.js"
import {
  adminToolDefinitions,
  createAdminHandler,
  renderOverview,
  type OverviewPayload,
} from "../src/admin.js"

// 全部 mock 驱动：不依赖任何 live src-server。
const BASE = "http://127.0.0.1:8080"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

test("工具面：恰 1 个 training_overview，空参数 schema", () => {
  const tools = adminToolDefinitions()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.name, "training_overview")
  assert.deepEqual(tools[0]!.inputSchema.properties, {})
  assert.equal(tools[0]!.inputSchema.additionalProperties, false)
})

test("handler：GET /training/overview 带 admin 头、无 Bearer；渲染真实档案", async () => {
  const calls: RecordedCall[] = []
  const payload: OverviewPayload = {
    generated_at: "2026-09-06T06:40:00Z",
    teachers: [
      {
        wecom_userid: "wecom_TuoMaSiLong",
        display_name: "ggtms",
        onboarding_state: "surveyed",
        plans_total: 5,
        items: { total: 32, viewed: 12, completed: 8 },
        items_7d: { total: 6, viewed: 3, completed: 1 },
        last_active_at: "2026-09-06T06:31:00Z",
        last_ask_at: "2026-09-06T06:28:00Z",
      },
      {
        wecom_userid: "wecom_wendy",
        display_name: null,
        onboarding_state: "pending",
        plans_total: 0,
        items: {},
        last_active_at: null,
        last_ask_at: null,
      },
      { wecom_userid: "wecom_t6_x_1", display_name: "王老师", onboarding_state: "surveyed", plans_total: 9 },
      { wecom_userid: "t6_bare_9", display_name: "裸形态", onboarding_state: "pending" },
      { wecom_userid: "wecom_哈哈哈哈哈_2", display_name: "冒烟", onboarding_state: "pending" },
      // bind 长度/并发测试再生的两类漏网形态（live 探针实证）：短周期重复串、pid 尾缀
      { wecom_userid: "YuYuYuYuYuYuYu", display_name: "Yu老师", onboarding_state: "pending", plans_total: 1 },
      { wecom_userid: "王a王a王a王a王a王a王a王a王a王a王a王a王a王a王a王a王a王a王at6_lw_73542_28", display_name: "长名老师", onboarding_state: "pending" },
    ],
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  const handler = createAdminHandler({
    client: new LlmWikiApiClient({ baseUrl: BASE, fetchImpl }),
    getAdminToken: () => "tok-admin",
  })
  const result = await handler()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${BASE}/api/v1/training/overview`)
  assert.equal(calls[0]!.method, "GET")
  assert.equal(calls[0]!.headers["x-training-admin-token"], "tok-admin")
  assert.equal(calls[0]!.headers.Authorization, undefined, "admin 端点不走 Bearer")

  const text = result.content[0]!.text
  // 汇总行：真实 2（surveyed 1）、有活动 1；测试/过滤档案 5 折叠（含裸形态、
  // 周期串 Yu×7、pid 尾缀三类 live 探针实证形态）
  assert.match(text, /真实档案 2 个（surveyed 1、其余 1），有学习活动记录 1 位；测试\/过滤形态档案 5 个未逐行列出/)
  assert.match(text, /快照：2026-09-06T06:40:00Z/)
  // 真实教师逐行：display_name 优先，空回落 uid
  assert.match(text, /- ggtms\(TuoMaSiLong\) \[surveyed\] 计划 5｜条目 32\(看12\/完8\)｜近7d计划条目 6\(看3\/完1\)｜最近活跃 2026-09-06T06:31:00Z/)
  assert.match(text, /- wendy\(wendy\) \[pending\] 计划 0｜条目 0\(看0\/完0\)｜近7d计划条目 0\(看0\/完0\)｜最近活跃 无/)
  // 测试残渣不逐行出现（prefixed/裸/周期串/pid 尾缀四形态都拦）
  assert.ok(
    !text.includes("王老师") && !text.includes("冒烟") && !text.includes("裸形态")
      && !text.includes("Yu老师") && !text.includes("长名老师"),
    "test-residue rows must not be listed",
  )
})

test("renderOverview：空档案与畸形输入安全", () => {
  assert.match(renderOverview({ teachers: [] }), /真实档案 0 个.*\n\n（无真实教师档案）/s)
  assert.match(renderOverview({}), /真实档案 0 个/)
})

test("renderOverview：管理员（非测试形态）档案保留逐行——不过滤主人", () => {
  const text = renderOverview({
    teachers: [{ wecom_userid: "wecom_HuangZhengBo", onboarding_state: "pending", plans_total: 1 }],
  })
  assert.match(text, /- HuangZhengBo\(HuangZhengBo\) \[pending\] 计划 1/)
})

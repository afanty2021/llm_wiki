import { describe, expect, it } from "vitest"
import { buildTitleIndex, resolveTarget } from "@/lib/wiki-graph"
import { buildTitleIndex as buildTitleIndexRR, resolveTarget as resolveTargetRR } from "@/lib/graph-relevance"

// 归一化：小写 + 空白→连字符（与服务端 graph.rs normalize_stem 对齐）
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-")

describe("wiki-graph buildTitleIndex", () => {
  it("indexes unique titles by normalized key (incl. Chinese)", () => {
    const nodes = new Map([
      ["ppp-teaching-model", { id: "ppp-teaching-model", label: "PPP 教学模式" }],
      ["overview-notes", { id: "overview-notes", label: "Overview Notes" }],
    ])
    const idx = buildTitleIndex(nodes)
    expect(idx.get(norm("PPP 教学模式"))).toBe("ppp-teaching-model")
    expect(idx.get("overview-notes")).toBe("overview-notes")
  })

  it("excludes collision groups: exact same title on two pages", () => {
    const nodes = new Map([
      ["a", { id: "a", label: "学术英语" }],
      ["b", { id: "b", label: "学术英语" }],
    ])
    expect(buildTitleIndex(nodes).get(norm("学术英语"))).toBeUndefined()
  })

  it("excludes collision groups: same title after normalization", () => {
    const nodes = new Map([
      ["a", { id: "a", label: "PPP Teaching Model" }],
      ["b", { id: "b", label: "ppp teaching model" }],
    ])
    expect(buildTitleIndex(nodes).get("ppp-teaching-model")).toBeUndefined()
  })

  it("skips empty labels", () => {
    const nodes = new Map([["a", { id: "a", label: "   " }]])
    expect(buildTitleIndex(nodes).size).toBe(0)
  })
})

describe("wiki-graph resolveTarget with title index", () => {
  // 上游 v0.6.10 重构：resolveTarget(raw, targetIndex, titleIndex?)——第二参从
  // nodeMap 改为预构建别名索引 buildTargetIndex(nodeIds)（本测试内联构建同构）。
  const nodeIds = ["zoltan-dornyei", "academic-writing", "zh-note"]
  const targetIndex = new Map<string, string>([
    ["zoltan-dornyei", "zoltan-dornyei"],
    ["zoltan dornyei", "zoltan-dornyei"],
    ["Zoltan Dornyei".toLowerCase(), "zoltan-dornyei"],
    ["academic-writing", "academic-writing"],
    ["zh-note", "zh-note"],
  ])
  const titleIndex = new Map([
    [norm("学术写作基础"), "academic-writing"],
    [norm("随记"), "zh-note"],
  ])

  it("resolves [[中文标题]] bare links via the title index", () => {
    expect(resolveTarget("学术写作基础", targetIndex, titleIndex)).toBe("academic-writing")
  })

  it("still resolves slug-form links with case/space tolerance first", () => {
    expect(resolveTarget("Zoltan Dornyei", targetIndex, titleIndex)).toBe("zoltan-dornyei")
  })

  it("prefers id match over title index on key overlap", () => {
    // "zh-note" 既是节点 id 又是某页 title 的归一化键 → id 优先
    expect(resolveTarget("zh-note", targetIndex, titleIndex)).toBe("zh-note")
  })

  it("returns null for dangling links and collided titles", () => {
    expect(resolveTarget("nonexistent", targetIndex, titleIndex)).toBeNull()
    const collided = new Map([[norm("同名页"), "x"]])
    // 碰撞组根本不进索引 → 查不到
    expect(resolveTarget("同名页", targetIndex, collided)).toBe("x") // 索引有则能查
    const emptyIdx = buildTitleIndex(new Map([
      ["x", { id: "x", label: "同名页" }],
      ["y", { id: "y", label: "同名页" }],
    ]))
    expect(resolveTarget("同名页", targetIndex, emptyIdx)).toBeNull()
  })
})

describe("graph-relevance resolveTarget with title index", () => {
  const nodeIds = new Set(["ppp-teaching-model", "zoltan-dornyei"])
  const titleIndex = buildTitleIndexRR([
    { id: "ppp-teaching-model", title: "PPP 教学模式" },
    { id: "other", title: "其他页" },
    { id: "dup-a", title: "重复" },
    { id: "dup-b", title: "重复" },
  ])

  it("resolves Chinese bare links by title", () => {
    expect(resolveTargetRR("PPP 教学模式", nodeIds, titleIndex)).toBe("ppp-teaching-model")
  })

  it("keeps slug-form resolution and excludes collided titles", () => {
    expect(resolveTargetRR("Zoltan Dornyei", nodeIds, titleIndex)).toBe("zoltan-dornyei")
    expect(resolveTargetRR("重复", nodeIds, titleIndex)).toBeNull()
    expect(resolveTargetRR("dangling", nodeIds, titleIndex)).toBeNull()
  })
})

# OKF P1 — wikilink 双写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **项目规则提示：** 每个 commit step 执行前须请示用户批准（用户全局规则）。Plan 保留 commit step 作为流程结构，实际 commit 按用户指示。

**Goal:** 实现 OKF P1 wikilink 双写——导出时对 concept/index.md 的 body 里 `[[slug]]` 追加 bundle-relative 标准 link，让 OKF consumer 能抽关系边，保留原 `[[wikilink]]`（Obsidian 兼容）。

**Architecture:** 导出层独立建 `SlugIndex`（slug→path[]，排除 reserved）；纯函数 `doubleWriteWikilinks` 对 body 双写（唯一映射才双写，重名/悬空/自引用/相对路径不双写，fenced code block skip）；`convertConcept` 加可选 `slugIndex?` 参数（不传零回归）；两版编排层（tauri + node）接线建索引 + 传参 + index.md 双写。

**Tech Stack:** TypeScript, Vitest, Tauri（编排）

**依据 spec:** `docs/superpowers/specs/2026-06-17-okf-p1-wikilink-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/lib/okf-convert.ts` | 纯转换（client-safe） | 新增 `SlugIndex` 类型 + `buildSlugIndex` + `doubleWriteWikilinks` + `doubleWriteContent`；`convertConcept` 加 `slugIndex?` 参数 |
| `src/lib/okf-export.ts` | node 版编排 + 聚合 re-export | re-export 新增符号；`exportOkfBundle` 建索引 + concept 传参 + index.md 双写 |
| `src/lib/okf-export-tauri.ts` | Tauri 编排 | `exportOkfBundleTauri` 建索引 + concept 传参 + index.md 双写 |
| `src/lib/okf-export.test.ts` | 纯函数测试 | 加 buildSlugIndex/doubleWriteWikilinks/doubleWriteContent/convertConcept(slugIndex) 测试（import `./okf-convert`） |
| `src/lib/okf-export-tauri.test.ts` | 端到端测试 | 加双写集成测试 |

**复用现有：** `basename`（私有）、`RESERVED`（导出）、`splitStrictFence`（私有）均在 okf-convert.ts，无需新增。

---

## Task 1: `SlugIndex` 类型 + `buildSlugIndex`

**Files:**
- Modify: `src/lib/okf-convert.ts`（在 `RESERVED` 定义后加类型 + 函数）
- Test: `src/lib/okf-export.test.ts`（末尾加 describe 块，import 从 `./okf-convert`）

- [ ] **Step 1: 写失败测试**（追加到 `src/lib/okf-export.test.ts` 末尾）

```ts
// 文件顶部 import 块追加（在现有 from "./okf-export" 之外新增一行）
import { buildSlugIndex } from "./okf-convert"

// ──────────────────────────────────────────────────────────────────
// buildSlugIndex — §3 slug→path[] 索引
// ──────────────────────────────────────────────────────────────────
describe("buildSlugIndex", () => {
  it("maps slug → [relPath]，去 .md 后缀", () => {
    const idx = buildSlugIndex(["concepts/foo.md", "entities/bar.md"])
    expect(idx.get("foo")).toEqual(["concepts/foo.md"])
    expect(idx.get("bar")).toEqual(["entities/bar.md"])
  })

  it("排除 reserved（index.md / log.md，含子目录）", () => {
    const idx = buildSlugIndex(["index.md", "concepts/index.md", "log.md", "concepts/foo.md"])
    expect(idx.has("index")).toBe(false)
    expect(idx.has("log")).toBe(false)
    expect(idx.get("foo")).toEqual(["concepts/foo.md"])
  })

  it("重名 slug 收集为多 path 数组", () => {
    const idx = buildSlugIndex(["concepts/wikilink.md", "entities/wikilink.md"])
    expect(idx.get("wikilink")).toEqual(["concepts/wikilink.md", "entities/wikilink.md"])
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run src/lib/okf-export.test.ts -t "buildSlugIndex"`
Expected: FAIL — `buildSlugIndex is not a function`（或 import 失败）

- [ ] **Step 3: 实现**（`src/lib/okf-convert.ts`，在 `RESERVED` 定义之后插入）

```ts
// ──────────────────────────────────────────────────────────────────
// P1: slug→path 索引（wikilink 双写）
// ──────────────────────────────────────────────────────────────────

/** slug → 候选 path 列表（bundle-relative，如 "concepts/foo.md"，不含 wiki/ 前缀）。 */
export type SlugIndex = Map<string, string[]>

/**
 * 遍历 relPaths 建 slug → path[] 索引（§3）。
 * - slug = basename 去 .md（与 wiki-graph fileNameToId 语义一致，但独立实现避免耦合/信息丢失）。
 * - 排除 reserved（index.md/log.md 非概念链接目标；其自身 body 双写复用本索引）。
 * - 精确匹配，不 normalize 大小写/空格。
 */
export function buildSlugIndex(relPaths: string[]): SlugIndex {
  const index: SlugIndex = new Map()
  for (const relPath of relPaths) {
    const name = basename(relPath)
    if (RESERVED.has(name)) continue
    const slug = name.replace(/\.md$/i, "")
    let arr = index.get(slug)
    if (!arr) {
      arr = []
      index.set(slug, arr)
    }
    arr.push(relPath)
  }
  return index
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run src/lib/okf-export.test.ts -t "buildSlugIndex"`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/okf-convert.ts src/lib/okf-export.test.ts
git commit -m "feat(okf): P1 buildSlugIndex — slug→path[] 索引（排除 reserved）"
```

---

## Task 2: `doubleWriteWikilinks` — 解析 + 唯一双写 + dangling

**Files:**
- Modify: `src/lib/okf-convert.ts`（buildSlugIndex 后加）
- Test: `src/lib/okf-export.test.ts`

- [ ] **Step 1: 写失败测试**（import 追加 `doubleWriteWikilinks`）

```ts
import { buildSlugIndex, doubleWriteWikilinks } from "./okf-convert"

describe("doubleWriteWikilinks — 唯一映射双写", () => {
  it("[[foo]] 唯一映射 → 追加括号标准 link，保留原 wikilink", () => {
    const idx = buildSlugIndex(["concepts/foo.md"])
    const out = doubleWriteWikilinks("see [[foo]] here", idx, "concepts/bar.md", [])
    expect(out).toBe("see [[foo]] ([Foo](/concepts/foo.md)) here")
  })

  it("[[nope]] 无映射（dangling）→ 原样保留，无 warning", () => {
    const warnings: string[] = []
    const idx = buildSlugIndex(["concepts/foo.md"])
    const out = doubleWriteWikilinks("see [[nope]]", idx, "concepts/bar.md", warnings)
    expect(out).toBe("see [[nope]]")
    expect(warnings).toEqual([])
  })

  it("多个 wikilink 各自双写", () => {
    const idx = buildSlugIndex(["concepts/a.md", "concepts/b.md"])
    const out = doubleWriteWikilinks("[[a]] 和 [[b]]", idx, "concepts/c.md", [])
    expect(out).toBe("[[a]] ([A](/concepts/a.md)) 和 [[b]] ([B](/concepts/b.md))")
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run src/lib/okf-export.test.ts -t "唯一映射双写"`
Expected: FAIL — `doubleWriteWikilinks is not a function`

- [ ] **Step 3: 实现**（`src/lib/okf-convert.ts`，buildSlugIndex 后）

```ts
/**
 * 对 body 中的 [[wikilink]] 就地双写标准 link（§4/§5）。
 *
 * ⚠️ 契约：入参 `body` **必须**是已剥离 frontmatter 的正文——调用方负责
 * splitStrictFence 分离后只传 body。绝不可传完整 content（fm 字段值里的
 * `[[...]]` 会被双写致 YAML 损坏）。
 *
 * - unique：追加 ([Title](/path.md[#anchor]))，Title = alias ?? slug
 * - ambiguous/dangling/self：原样保留（ambiguous 记 warning）
 * - 含 "/" 的相对路径 wikilink：原样保留
 * - 已知限制：反引号 fenced code block 内 skip；~~~ tilde 围栏与行内代码内暂不 skip（见 §5.3）
 */
export function doubleWriteWikilinks(
  body: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string {
  // 按 fenced code block 切段：捕获组（代码块）跳过，只双写 prose 段
  const segments = body.split(/(```[\s\S]*?```)/g)
  return segments
    .map((seg, i) => (i % 2 === 1 ? seg : rewriteProseWikilinks(seg, slugIndex, currentRelPath, warnings)))
    .join("")
}

/** prose 段内的 [[wikilink]] 双写（不含代码块）。 */
function rewriteProseWikilinks(
  prose: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string {
  return prose.replace(/\[\[([^\[\]]+?)\]\]/g, (full, inner: string) => {
    // 含 "/" 的相对路径形式 → slug 模糊，不双写（§4）
    if (inner.includes("/")) return full
    // linkPart = target[#anchor]，aliasPart = 纯 display（Obsidian：anchor 在 | 前）
    const [linkPart, aliasPart] = inner.split("|")
    const [slugRaw, anchorRaw] = linkPart.split(/#/)
    const slug = slugRaw.trim()
    if (!slug) return full
    const paths = slugIndex.get(slug)
    if (!paths || paths.length === 0) return full // dangling
    if (paths.length > 1) {
      warnings.push(`ambiguous wikilink [[${slug}]] → ${paths.length} paths: ${JSON.stringify(paths)}`)
      return full // ambiguous：宁可丢边不造错边
    }
    const path = paths[0]
    if (path === currentRelPath) return full // self
    const title = (aliasPart ?? slug).trim()
    const anchor = anchorRaw && !anchorRaw.startsWith("^") ? `#${anchorRaw.trim()}` : ""
    return `${full} ([${title}](/${path}${anchor}))`
  })
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run src/lib/okf-export.test.ts -t "唯一映射双写"`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/okf-convert.ts src/lib/okf-export.test.ts
git commit -m "feat(okf): P1 doubleWriteWikilinks — 唯一映射双写 + dangling"
```

---

## Task 3: `doubleWriteWikilinks` 边界（alias / anchor / blockref / ambiguous / self / 相对路径）

**Files:**
- Test: `src/lib/okf-export.test.ts`（纯测试，无新实现——验证 Task 2 已覆盖）

- [ ] **Step 1: 写边界测试**（追加到 "唯一映射双写" describe 内或新 describe）

```ts
describe("doubleWriteWikilinks — 边界", () => {
  const idx = buildSlugIndex(["concepts/foo.md", "concepts/wikilink.md", "entities/wikilink.md"])

  it("alias：[[foo|My Foo]] → Title 用 alias", () => {
    const out = doubleWriteWikilinks("[[foo|My Foo]]", idx, "concepts/bar.md", [])
    expect(out).toBe("[[foo|My Foo]] ([My Foo](/concepts/foo.md))")
  })

  it("anchor：[[foo#Sec]] → 保留 #Sec", () => {
    const out = doubleWriteWikilinks("[[foo#Sec]]", idx, "concepts/bar.md", [])
    expect(out).toBe("[[foo#Sec]] ([Foo](/concepts/foo.md#Sec))")
  })

  it("anchor+alias 标准形式：[[foo#Sec|My Foo]] → slug foo, Title alias, anchor #Sec", () => {
    const out = doubleWriteWikilinks("[[foo#Sec|My Foo]]", idx, "concepts/bar.md", [])
    expect(out).toBe("[[foo#Sec|My Foo]] ([My Foo](/concepts/foo.md#Sec))")
  })

  it("block ref：[[foo#^blk]] → 丢弃 ^blk，不双写 anchor", () => {
    const out = doubleWriteWikilinks("[[foo#^blk]]", idx, "concepts/bar.md", [])
    expect(out).toBe("[[foo#^blk]] ([Foo](/concepts/foo.md))")
  })

  it("ambiguous：[[wikilink]] 重名 → 原样 + warning 含两 path", () => {
    const warnings: string[] = []
    const out = doubleWriteWikilinks("[[wikilink]]", idx, "concepts/bar.md", warnings)
    expect(out).toBe("[[wikilink]]")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("ambiguous")
    expect(warnings[0]).toContain("concepts/wikilink.md")
    expect(warnings[0]).toContain("entities/wikilink.md")
  })

  it("self：[[foo]] 在 concepts/foo.md 内 → 原样", () => {
    const out = doubleWriteWikilinks("[[foo]]", idx, "concepts/foo.md", [])
    expect(out).toBe("[[foo]]")
  })

  it("相对路径：[[../bar/foo]] 含 / → 原样不双写", () => {
    const out = doubleWriteWikilinks("[[../bar/foo]]", idx, "concepts/x.md", [])
    expect(out).toBe("[[../bar/foo]]")
  })
})
```

- [ ] **Step 2: 跑测试验证通过**（实现已在 Task 2 完成，应直接 PASS）

Run: `npx vitest run src/lib/okf-export.test.ts -t "边界"`
Expected: PASS（7 tests）。若有 FAIL，回到 Task 2 实现修正解析逻辑。

- [ ] **Step 3: Commit**

```bash
git add src/lib/okf-export.test.ts
git commit -m "test(okf): P1 doubleWriteWikilinks 边界（alias/anchor/blockref/ambiguous/self/相对路径）"
```

---

## Task 4: `doubleWriteWikilinks` fenced code block skip

**Files:**
- Test: `src/lib/okf-export.test.ts`（实现已在 Task 2 含 split 切段，本任务验证）

- [ ] **Step 1: 写测试**

```ts
describe("doubleWriteWikilinks — fenced code block skip", () => {
  const idx = buildSlugIndex(["concepts/foo.md", "concepts/y.md"])

  it("代码块内 [[x]] 原样，块外 [[y]] 双写", () => {
    const body = "before [[y]]\n\n```\nconst x = [[foo]]\n```\n\nafter [[y]]"
    const out = doubleWriteWikilinks(body, idx, "concepts/bar.md", [])
    expect(out).toContain("before [[y]] ([Y](/concepts/y.md))")
    expect(out).toContain("const x = [[foo]]")   // 块内未双写
    expect(out).not.toContain("[[foo]] ([Foo]")
    expect(out).toContain("after [[y]] ([Y](/concepts/y.md))")
  })
})
```

- [ ] **Step 2: 跑测试验证通过**

Run: `npx vitest run src/lib/okf-export.test.ts -t "fenced code block skip"`
Expected: PASS（1 test）。若 FAIL，检查 Task 2 的 `body.split(/(```[\s\S]*?```)/g)` 切段逻辑。

- [ ] **Step 3: Commit**

```bash
git add src/lib/okf-export.test.ts
git commit -m "test(okf): P1 doubleWriteWikilinks fenced code block skip"
```

---

## Task 5: `doubleWriteContent` + `convertConcept` 加 `slugIndex?` 参数

**Files:**
- Modify: `src/lib/okf-convert.ts`（加 `doubleWriteContent`；改 `convertConcept` 签名）
- Test: `src/lib/okf-export.test.ts`

- [ ] **Step 1: 写失败测试**（import 追加 `convertConcept` 已有 from ./okf-export；新测试用 convertConcept）

```ts
import { buildSlugIndex, doubleWriteWikilinks, doubleWriteContent } from "./okf-convert"
// convertConcept 已从 ./okf-export import（顶部）

describe("doubleWriteContent — fm/body 分离双写", () => {
  it("有 frontmatter：只双写 body，fm 不动", () => {
    const idx = buildSlugIndex(["concepts/foo.md"])
    const content = "---\ntype: concept\ntitle: 关于 [[foo]] 的笔记\n---\n\nsee [[foo]]"
    const out = doubleWriteContent(content, idx, "concepts/bar.md", [])
    // fm 内的 [[foo]] 不双写（YAML 不损坏）
    expect(out).toContain("title: 关于 [[foo]] 的笔记")
    expect(out).not.toContain("title: 关于 [[foo]] ([Foo]")
    // body 内的 [[foo]] 双写
    expect(out).toContain("see [[foo]] ([Foo](/concepts/foo.md))")
  })

  it("无 frontmatter（纯 body）：整体双写（也是 splitStrictFence 不匹配时的退化路径）", () => {
    // 退化说明：convertConcept 生产路径保证 fm 合规（missing-fence 修复 + truly-none 注入），
    // 故 splitStrictFence 必匹配；此用例兼测"纯 body / 退化"两条路径（行为一致：整体当 body）。
    const idx = buildSlugIndex(["concepts/foo.md"])
    const out = doubleWriteContent("see [[foo]]", idx, "concepts/bar.md", [])
    expect(out).toBe("see [[foo]] ([Foo](/concepts/foo.md))")
  })
})

describe("convertConcept — slugIndex 参数", () => {
  it("不传 slugIndex：行为不变（P0a 零回归，不双写）", () => {
    const content = "---\ntype: concept\n---\n\nsee [[foo]]"
    const out = convertConcept(content, "concepts/bar.md", new Date("2026-06-17"), [], undefined)
    expect(out).toContain("timestamp: 2026-06-17")  // injectTimestamp 仍生效
    expect(out).toContain("see [[foo]]")             // body 保留
    expect(out).not.toContain("([Foo]")              // 未传 slugIndex → 不双写
  })

  it("传 slugIndex：body 内 [[foo]] 双写，fm 保留 timestamp 注入", () => {
    const idx = buildSlugIndex(["concepts/foo.md"])
    const content = "---\ntype: concept\n---\n\nsee [[foo]]"
    const out = convertConcept(content, "concepts/bar.md", new Date("2026-06-17"), [], undefined, idx)
    expect(out).toContain("timestamp: 2026-06-17")  // fm 注入仍在
    expect(out).toContain("see [[foo]] ([Foo](/concepts/foo.md))")  // body 双写
  })

  it("self：convertConcept 处理 concepts/foo.md 时，自身 [[foo]] 不双写", () => {
    const idx = buildSlugIndex(["concepts/foo.md"])
    const content = "---\ntype: concept\n---\n\nself [[foo]]"
    const out = convertConcept(content, "concepts/foo.md", new Date("2026-06-17"), [], undefined, idx)
    expect(out).toContain("self [[foo]]")
    expect(out).not.toContain("([Foo]")
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run src/lib/okf-export.test.ts -t "doubleWriteContent"`
Expected: FAIL — `doubleWriteContent is not a function`

- [ ] **Step 3: 实现 `doubleWriteContent`**（`src/lib/okf-convert.ts`，doubleWriteWikilinks 后）

```ts
/**
 * 对可能含 frontmatter 的 content 双写 body（§6 契约统一入口）。
 * 有严格围栏 → 分离 fm/body，只双写 body，重组；无围栏 → 整体当 body 双写。
 * convertConcept（concept）与编排层（index.md）共用，保证 fm 绝不进双写。
 */
export function doubleWriteContent(
  content: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string {
  const split = splitStrictFence(content)
  if (!split) {
    return doubleWriteWikilinks(content, slugIndex, currentRelPath, warnings)
  }
  const rewritten = doubleWriteWikilinks(split.body, slugIndex, currentRelPath, warnings)
  return content.slice(0, content.length - split.body.length) + rewritten
}
```

- [ ] **Step 4: 改 `convertConcept` 签名 + 双写接入**

定位 `src/lib/okf-convert.ts` 的 `convertConcept`（约 line 263）。修改：

```ts
export function convertConcept(
  content: string,
  filename: string,
  nowFallback: Date,
  warnings: string[],
  fileMtime?: Date,
  slugIndex?: SlugIndex,   // 新增：P1，传入则对 body 双写
): string {
  const cls = classifyFrontmatter(content)
  let fixed: string
  switch (cls) {
    case "normal":
      fixed = content
      break
    case "leading-blank":
      fixed = stripLeadingBlank(content)
      break
    case "missing-fence":
      try {
        fixed = repairMissingFenceOrThrow(content)
      } catch (e) {
        if (e === NO_CLOSING_FENCE) {
          const injected = injectMinimalFrontmatter(content, filename, nowFallback, fileMtime, warnings)
          return slugIndex ? doubleWriteContent(injected, slugIndex, filename, warnings) : injected
        }
        throw e
      }
      break
    case "truly-none":
      fixed = injectMinimalFrontmatter(content, filename, nowFallback, fileMtime, warnings)
      return slugIndex ? doubleWriteContent(fixed, slugIndex, filename, warnings) : fixed
  }
  // normal / leading-blank / missing-fence：补 timestamp + 双写
  const withTs = injectTimestamp(fixed, nowFallback, fileMtime)
  return slugIndex ? doubleWriteContent(withTs, slugIndex, filename, warnings) : withTs
}
```

- [ ] **Step 5: 跑测试验证通过**

Run: `npx vitest run src/lib/okf-export.test.ts -t "doubleWriteContent" && npx vitest run src/lib/okf-export.test.ts -t "convertConcept — slugIndex 参数"`
Expected: PASS（全部）

- [ ] **Step 6: 回归现有 convertConcept 测试（确保 P0a 不破）**

Run: `npx vitest run src/lib/okf-export.test.ts`
Expected: PASS（所有现有 + 新增测试）

- [ ] **Step 7: Commit**

```bash
git add src/lib/okf-convert.ts src/lib/okf-export.test.ts
git commit -m "feat(okf): P1 convertConcept 加 slugIndex 参数 + doubleWriteContent（fm/body 分离）"
```

---

## Task 6: re-export + Tauri 编排层接线

**Files:**
- Modify: `src/lib/okf-export.ts`（re-export 新符号）
- Modify: `src/lib/okf-export-tauri.ts`（建索引 + concept 传参 + index.md 双写）

- [ ] **Step 1: re-export 新符号**（`src/lib/okf-export.ts`，现有 `export { ... } from "./okf-convert"` 块内追加）

在现有 re-export 列表（`isAbsoluteLike, classifyFrontmatter, ...`）追加：
```ts
  buildSlugIndex,
  doubleWriteWikilinks,
  doubleWriteContent,
```
并在 type re-export 行追加：
```ts
export type { ExportReport, SlugIndex } from "./okf-convert"
```

- [ ] **Step 2: Tauri 编排层建索引 + 传参**

定位 `src/lib/okf-export-tauri.ts` 的 `exportOkfBundleTauri`。修改 import（从 `@/lib/okf-convert` 追加 `buildSlugIndex`, `doubleWriteContent`）：

```ts
import {
  convertConcept,
  normalizeLogContent,
  convertBundleRootIndex,
  convertSubdirIndex,
  buildSlugIndex,       // 新增
  doubleWriteContent,   // 新增
  RESERVED,
  type ExportReport,
} from "@/lib/okf-convert"
```

在 `const files = await walkMarkdownTauri(wikiDir)` 后加索引：
```ts
  const files = await walkMarkdownTauri(wikiDir)
  const slugIndex = buildSlugIndex(files.map((f) => f.relPath))   // P1: 建 slug→path[] 索引
  const now = new Date()
```

修改循环内转换分支（concept 传 slugIndex；index.md 双写）：

```ts
    let converted: string

    if (isReserved) {
      report.reserved++
      if (name === "index.md") {
        const isRoot = dirname(relPath) === "."
        const idxConverted = isRoot ? convertBundleRootIndex(content) : convertSubdirIndex(content)
        // P1: index.md 双写（root/subdir 均经 doubleWriteContent 处理 fm/body）
        converted = doubleWriteContent(idxConverted, slugIndex, relPath, report.warnings)
      } else {
        // log.md：不双写（normalize 后是日期条目，无 wikilink）
        converted = normalizeLogContent(content)
      }
    } else {
      report.concepts++
      converted = convertConcept(content, relPath, now, report.warnings, fileMtime, slugIndex)
    }
```

- [ ] **Step 3: 更新文件顶部注释**

`src/lib/okf-export-tauri.ts:10` 的 `// 不实现：UI（P0b-2）、wikilink 双写（P1）、description/resource 派生（P2）。` 改为：
```ts
// 不实现：description/resource 派生（P2）。wikilink 双写（P1）已实现。
```

- [ ] **Step 4: typecheck + 现有 tauri 测试回归**

Run: `npm run typecheck && npx vitest run src/lib/okf-export-tauri.test.ts`
Expected: typecheck exit 0；现有 tauri 测试全 PASS（双写是新行为，现有断言不检查 link，应不破——若有断言检查 body 精确文本且该测试 fixture 含 wikilink，需更新断言）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/okf-export.ts src/lib/okf-export-tauri.ts
git commit -m "feat(okf): P1 Tauri 编排接线（建索引 + concept/index 双写）+ re-export"
```

---

## Task 7: Node 编排层接线

**Files:**
- Modify: `src/lib/okf-export.ts`（`exportOkfBundle` 端到端 node 版）

- [ ] **Step 1: 定位 `exportOkfBundle`**（`src/lib/okf-export.ts`，node:fs 版，与 Tauri 版逻辑等价）

读 `exportOkfBundle` 函数，确认其遍历 + 转换循环结构（应与 `exportOkfBundleTauri` 对称）。

- [ ] **Step 2: 建索引 + 传参 + index.md 双写**

在遍历得到 files 后加 `const slugIndex = buildSlugIndex(files.map(f => f.relPath))`；concept 转换传 `slugIndex`；index.md 转换后调 `doubleWriteContent`；log.md 不双写。改动与 Task 6 Step 2 完全对称（函数名 `exportOkfBundle`，路径工具用 node:path）。

参考 Task 6 Step 2 的转换分支代码，移植到 node 版（node 版用 `path.relative/basename`，转换调用相同）。

- [ ] **Step 2.5: 更新文件顶部注释**

`src/lib/okf-export.ts:5` 的 `// 不做 wikilink 双写（P1）、Tauri 命令（P0b）、description/resource 派生（P2）。` 改为：
```ts
// 不做 description/resource 派生（P2）。wikilink 双写（P1）已实现。
```

- [ ] **Step 3: typecheck + node 版测试回归**

Run: `npm run typecheck && npx vitest run src/lib/okf-export.test.ts`
Expected: typecheck exit 0；测试全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/lib/okf-export.ts
git commit -m "feat(okf): P1 node 编排层 exportOkfBundle 接线双写"
```

---

## Task 8: 端到端集成测试 + validator 验证

**Files:**
- Test: `src/lib/okf-export-tauri.test.ts`（加双写集成测试）

- [ ] **Step 1: 写端到端测试**（追加到 `src/lib/okf-export-tauri.test.ts`，复用其 mock helper：`state`/`resetState`/`addDir`/`writeFile`/`PAGE`/`WIKI`/`OUT`，mock 已在文件顶部 `vi.mock("@/commands/fs")` 设置好）

```ts
describe("exportOkfBundleTauri — P1 wikilink 双写", () => {
  beforeEach(() => resetState())

  it("concept body 的 [[slug]] 双写为标准 link，原 wikilink 保留；self 不双写", async () => {
    addDir(`${WIKI}/concepts`)
    writeFile(`${WIKI}/concepts/foo.md`, PAGE("type: concept\ntitle: Foo\nupdated: 2026-05-19", "# Foo\n\nself [[foo]]"))
    writeFile(`${WIKI}/concepts/bar.md`, PAGE("type: concept\ntitle: Bar\nupdated: 2026-05-19", "# Bar\n\nsee [[foo]]"))

    await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    // foo.md 自身的 [[foo]] 是 self → 不双写
    const foo = written.get(`${OUT}/concepts/foo.md`)!
    expect(foo).toContain("self [[foo]]")
    expect(foo).not.toContain("([Foo]")
    // bar.md 的 [[foo]] 唯一映射 → 双写
    expect(written.get(`${OUT}/concepts/bar.md`)!).toContain("see [[foo]] ([Foo](/concepts/foo.md))")
  })

  it("index.md 的 [[slug]] 双写，log.md 不双写", async () => {
    addDir(`${WIKI}/concepts`)
    writeFile(`${WIKI}/concepts/foo.md`, PAGE("type: concept\ntitle: Foo\nupdated: 2026-05-19", "# Foo"))
    writeFile(`${WIKI}/index.md`, PAGE("type: index", "# Index\n\n- [[foo]]"))
    writeFile(`${WIKI}/log.md`, "# Log\n\n## 2026-05-19\n\nsee [[foo]]\n")

    await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    expect(written.get(`${OUT}/index.md`)!).toContain("[[foo]] ([Foo](/concepts/foo.md))")
    expect(written.get(`${OUT}/log.md`)!).not.toContain("([Foo]")   // log 不双写
  })

  it("ambiguous wikilink 记入 report.warnings，不双写", async () => {
    addDir(`${WIKI}/concepts`)
    addDir(`${WIKI}/entities`)
    writeFile(`${WIKI}/concepts/wikilink.md`, PAGE("type: concept\ntitle: W1\nupdated: 2026-05-19", "# W1"))
    writeFile(`${WIKI}/entities/wikilink.md`, PAGE("type: concept\ntitle: W2\nupdated: 2026-05-19", "# W2"))
    writeFile(`${WIKI}/concepts/refs.md`, PAGE("type: concept\ntitle: Refs\nupdated: 2026-05-19", "see [[wikilink]]"))

    const report = await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    expect(written.get(`${OUT}/concepts/refs.md`)!).toContain("see [[wikilink]]")
    expect(written.get(`${OUT}/concepts/refs.md`)!).not.toContain("([W1]")
    expect(report.warnings.some((w) => w.includes("ambiguous") && w.includes("wikilink"))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试 + 按需补全 mock 桩**

Run: `npx vitest run src/lib/okf-export-tauri.test.ts -t "P1 wikilink 双写"`
Expected: PASS。若 mock 不全，按现有测试模式补 fs 桩。

- [ ] **Step 3: validator 端到端验证（真实 bundle）**

```bash
# 用 node 版导出 Invest 的 wiki 到临时目录（执行者按本地实际 wiki 路径替换 <INVEST_WIKI>）
npx tsx -e "import {exportOkfBundle} from './src/lib/okf-export'; exportOkfBundle('<INVEST_WIKI>', '/tmp/okf-p1-test').then(r => console.log(JSON.stringify(r)))"
# 对比双写前后：先记录 P0a（本任务前）的 §5 warn 数，实施后应显著下降
node scripts/validate-okf.mjs /tmp/okf-p1-test --soft
```
Expected: 硬性 C1/C2/C3 全过（退出码 0）；§5 link warn 数较双写前显著下降（唯一映射的 wikilink 不再被 consumer 忽略）。记录前后 warn 数对比。

- [ ] **Step 4: 全量回归**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exit 0；测试全 PASS（除已知预存的 3 个集成测试失败：mcp-server api-client/llm-client.real-llm，与本次无关）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/okf-export-tauri.test.ts
git commit -m "test(okf): P1 wikilink 双写端到端集成测试 + validator 验证"
```

---

## Self-Review

**1. Spec 覆盖：**
- §2 数据结构（SlugIndex）→ Task 1 ✅
- §3 索引构建（buildSlugIndex，排除 reserved，精确匹配）→ Task 1 ✅
- §4 wikilink 解析（全集形式 + 含 `/` 跳过）→ Task 2/3 ✅
- §5 双写规则（unique/ambiguous/dangling/self）→ Task 2/3 ✅
- §5.1 插入格式（括号、alias??slug、bundle-relative）→ Task 2 ✅
- §5.2 作用范围（concept + index.md，log 跳过）→ Task 6（index.md）/ Task 5（concept）✅
- §5.3 已知限制（fenced skip、行内暂不）→ Task 4（fenced 测试）+ Task 2 实现含 split ✅
- §6 代码改动点（convertConcept slugIndex?、doubleWriteContent 契约、编排层两版）→ Task 5/6/7 ✅
- §7 测试（10+ 用例）→ Task 1-5, 8 ✅
- 行内代码 skip 已知限制：spec §5.3 声明暂不实现，plan 无对应测试（已知限制，不阻塞）✅

**2. 占位符扫描：** 全部步骤含完整可执行代码，无 TBD/TODO/"similar to Task N"/"add error handling" 等占位符。Task 8 端到端测试已补全完整 mock helper（`addDir`/`writeFile`/`state.writeCalls`/`PAGE`）调用 + 精确断言。

**3. 类型一致性：** `SlugIndex`（Task 1）→ Task 2/5/6/7 一致；`doubleWriteWikilinks(body, slugIndex, currentRelPath, warnings)` 签名全 Task 一致；`doubleWriteContent(content, slugIndex, currentRelPath, warnings)` 一致；`convertConcept(..., slugIndex?)` Task 5 定义、Task 6/7 调用一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-okf-p1-wikilink.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每个 Task 派发独立 subagent，Task 间 review，快速迭代
**2. Inline Execution** — 本会话内批量执行，checkpoint 处 review

Which approach?

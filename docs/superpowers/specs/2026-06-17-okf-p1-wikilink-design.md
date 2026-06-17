# OKF P1 — wikilink 双写 详细设计

> **状态：设计定稿（决策已确认），待进入实施。**
> 依据：[OKF SPEC v0.1 §5](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)、`docs/superpowers/plans/2026-06-16-okf-compliance-plan.md` §5
> 前置：P0a（硬性转换）/ P0b（Tauri 编排 + UI）已完成
> 创建：2026-06-17

---

## 1. 目标

OKF consumer（SPEC §5.3）只从标准 markdown link `[T](path)` 抽关系边，**忽略 `[[wikilink]]`** → 关系图传不出去。P1 在导出时对每个 `[[slug]]` **追加**一个 bundle-relative 标准 link，让 consumer 能抽边；**保留原 `[[wikilink]]` 不删**（Obsidian 兼容）。

**铁律（§5.2）**：唯一映射才双写，重名/悬空不双写——**宁可丢边，不造错边**。

---

## 2. 数据结构

```ts
// slug → 候选 path 列表（bundle-relative，如 "concepts/foo.md"，不含 wiki/ 前缀）
type SlugIndex = Map<string, string[]>

// ⚠️ 内部辅助类型，不导出——doubleWriteWikilinks 的实现细节，非公开接口。
type ResolveResult =
  | { kind: "unique"; path: string; anchor?: string }
  | { kind: "ambiguous"; paths: string[] }
  | { kind: "dangling" }
  | { kind: "self" }   // unique 唯一 path === currentRelPath（解析到当前文件自身）
```

---

## 3. 索引构建（编排层，遍历后、转换前）

在 `exportOkfBundleTauri` / `exportOkfBundle` 拿到 `files` 后建一次索引：

```
for { relPath } of files:
  name = basename(relPath)
  if RESERVED.has(name): continue          // index.md / log.md 不入索引
  slug = name.replace(/\.md$/i, "")
  (slugIndex.get(slug) ?? slugIndex.set(slug, []).get(slug)).push(relPath)
```

- **独立实现**，不依赖 `wiki-graph.ts:fileNameToId`——后者丢子目录且 slug 可重复（正是 P1 要修的 §5.1 问题，实测 `concepts/wikilink.md` 与 `entities/wikilink.md` 并存）。
- slug = basename 去 `.md`（与 fileNameToId 语义一致，但保留 `path[]` 信息供歧义判定）。
- **精确匹配**，不 normalize 大小写/空格（避免误连；生产 wiki slug 与文件名约定一致，YAGNI）。`Map.get(slug)` 精确字符串查找，slug 含正则元字符（`$^` 等）亦安全。
- **reserved 排除安全**：`index.md`/`log.md` 文件名本身不是 concept 链接目标（语义上是导航/日志页）；且它们自身的 body 双写复用同一 `slugIndex`（如 index.md 里的 `[[foo]]` → `concepts/foo.md` 仍可解析），故排除不影响任何双写路径。

---

## 4. wikilink 解析（支持的 Obsidian 形式）

正则：`/\[\[([^\[\]]+?)\]\]/g`（非贪婪，不嵌套）。

| 形式 | slug | Title | anchor | 处理 |
|------|------|-------|--------|------|
| `[[foo]]` | `foo` | `foo` | — | 基础 |
| `[[foo\|alias]]` | `foo` | `alias` | — | alias 作文本 |
| `[[foo#sec]]` | `foo` | `foo` | `#sec` | 保留 anchor |
| `[[foo#^blk]]` | `foo` | `foo` | 丢弃 | 块引用无标准等价 |
| `[[foo#sec\|alias]]` | `foo` | `alias` | `#sec` | anchor 在 target 部分（标准 Obsidian 形式） |
| `[[../bar/foo]]`（含 `/`） | — | — | — | **跳过不双写**（相对路径 slug 模糊），原样保留 |

提取规则（anchor 在 target 部分 `|` 前，aliasPart 仅作 display 文本——Obsidian 语义）：
```
inner = 去 [[ ]]
if inner 含 "/": 跳过（相对路径形式）
[linkPart, aliasPart] = inner.split("|")   // linkPart = target[#anchor]，aliasPart = 纯 display
[slug, anchorRaw] = linkPart.split(/#/)     // anchor 来自 target 部分，不从 alias 提取
slug = slug.trim()
title = (aliasPart ?? slug).trim()
anchor = anchorRaw && !anchorRaw.startsWith("^") ? `#${anchorRaw}` : undefined
```

---

## 5. 双写规则（决策已确认）

对 body 中每个 `[[...]]`，查 `slugIndex`：

| 解析结果 | 处理 | warning |
|---------|------|---------|
| **unique** | 保留 `[[foo]]` + 就地追加标准 link（见格式） | 否 |
| **ambiguous**（重名） | 原样保留，不双写 | ✅ `ambiguous wikilink [[foo]] → N paths: [...]` |
| **dangling**（悬空） | 原样保留 | 否（源常态，§5.3 consumer 容忍断链） |
| **self**（unique 唯一 path === `currentRelPath`） | 原样保留 | 否（自环无关系意义） |

### 5.1 插入格式（✅ 确认：括号包裹）

```
[[foo]]  →  [[foo]] ([Foo](/concepts/foo.md))
```

- Title = **alias ?? slug**（✅ 确认）
- bundle-relative absolute：前导 `/`，**不含 wiki/ 前缀**（§4 Bundle 结构：`<out>/` 即 root）
- anchor 保留：`[[foo#sec]]` → `[[foo#sec]] ([Foo](/concepts/foo.md#sec))`
- consumer 从 `[Foo](/concepts/foo.md)` 抽边；`[[foo]]` 仍在，Obsidian 兼容不破

### 5.2 作用范围（✅ 确认：concept + index.md）

- **concept**（所有非 reserved .md）：双写（主线）
- **index.md**（bundle root + 子目录）：双写（常含 `[[link]]` 目录索引）
- **log.md**：跳过（normalize 后是日期条目，无 wikilink）

实现：reserved 分支里 index.md 转换后也调 `doubleWriteWikilinks`；log.md 不调。

### 5.3 已知限制：代码区内的 `[[...]]`

正则对 body 全局匹配，不天然区分代码区。处理策略：

| 场景 | 处理 | 理由 |
|------|------|------|
| fenced code block（` ``` ` 区块） | **skip**（prose-only：按 ` ``` ` 切段，只处理非代码段） | 代码示例里的 `[[example]]` 是字面文本，双写会破坏代码 |
| 行内代码（`` `[[x]]` ``） | **暂不 skip**（已知限制） | 行内配对识别复杂、生产场景罕见；首版不实现，记录待评估 |

> 若实测生产 wiki 的 concept body 在代码区频繁出现 `[[...]]`，再考虑行内代码 skip。当前 fenced block skip 已覆盖主要风险。

### 5.4 性能

584 concepts × body 正则全局替换，O(文件数 × 单文件长度) 线性，单文件毫秒级，整体秒级可接受。

---

## 6. 代码改动点

### 6.1 `src/lib/okf-convert.ts`（纯函数，client-safe）新增

```ts
export type SlugIndex = Map<string, string[]>

/** 遍历 relPaths 建 slug → path[] 索引（排除 reserved）。 */
export function buildSlugIndex(relPaths: string[]): SlugIndex

/**
 * 对 body 中的 [[wikilink]] 就地双写标准 link。
 *
 * ⚠️ 契约：入参 `body` **必须**是已剥离 frontmatter 的正文——调用方负责
 * `splitStrictFence` 分离 fm/body 后只传 body。绝不可传完整 content，
 * 否则 fm 字段值里的 `[[...]]`（如 `title: "关于 [[foo]]"`）会被双写致 YAML 损坏。
 *
 * - unique：追加 ([Title](/path.md[#anchor]))
 * - ambiguous/dangling/self：原样保留（ambiguous 记 warning）
 * - 含 "/" 的相对路径 wikilink：原样保留
 * - 已知限制：fenced code block（```）内 skip；行内代码（`）内暂不 skip（见 §5.3）
 */
export function doubleWriteWikilinks(
  body: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string
```

### 6.2 `convertConcept` 签名扩展（向后兼容）

```ts
export function convertConcept(
  content: string,
  filename: string,
  nowFallback: Date,
  warnings: string[],
  fileMtime?: Date,
  slugIndex?: SlugIndex,   // 新增：P1，传入则对 body 双写
): string
```

- 双写作用在 **body**（fm 之外）：`splitStrictFence` 分离 fm/body → **只把 body 传给 `doubleWriteWikilinks`** → 重组。fm payload 绝不进双写（防 YAML 损坏，见 §6.1 契约）。missing-fence/truly-none 在 convertConcept 内已先修复 fm，到双写时 body 已分离；index.md 经 `convertBundleRootIndex`/`convertSubdirIndex` 剥光 fm 留 body——三者均满足"只传 body"契约。
- `slugIndex` 未传 → 不双写（P0a 行为不变，现有测试零回归）。

### 6.3 编排层（`okf-export-tauri.ts` + `okf-export.ts`）

```ts
const files = await walkMarkdownTauri(wikiDir)
const slugIndex = buildSlugIndex(files.map(f => f.relPath))   // 新增
...
// concept
converted = convertConcept(content, relPath, now, warnings, fileMtime, slugIndex)
// index.md（双写）
converted = convertBundleRootIndex(content) / convertSubdirIndex(content)
converted = doubleWriteWikilinks(converted, slugIndex, relPath, warnings)  // 新增
// log.md（不双写）
converted = normalizeLogContent(content)
```

### 6.4 注释更新

`okf-export.ts:5` / `okf-export-tauri.ts:10` 的 "不做 wikilink 双写（P1）" 移除/改注。

---

## 7. 测试

### 7.1 单元（`doubleWriteWikilinks` + `buildSlugIndex`）

| 用例 | 输入 | 期望 |
|------|------|------|
| unique | `[[foo]]` + `{foo:["concepts/foo.md"]}` | `[[foo]] ([Foo](/concepts/foo.md))` |
| alias | `[[foo\|My Foo]]` | `[[foo\|My Foo]] ([My Foo](/concepts/foo.md))` |
| anchor | `[[foo#Sec]]` | `[[foo#Sec]] ([Foo](/concepts/foo.md#Sec))` |
| block ref | `[[foo#^blk]]` | `[[foo#^blk]] ([Foo](/concepts/foo.md))` |
| ambiguous | `[[foo]]` + 2 个 foo.md | 原样 + warning 含两 path |
| dangling | `[[nope]]` 无映射 | 原样，无 warning |
| self | `[[foo]]` 在 `concepts/foo.md` 内 | 原样 |
| 相对路径 | `[[../bar/foo]]` | 原样（不双写） |
| 多链接 | `[[a]] 和 [[b]]` | 各自双写 |
| **fenced code block** | ` ``` ` 内 `[[x]]`、外有 `[[y]]` | 仅 `[[y]]` 双写，块内 `[[x]]` 原样 |
| **行内代码**（已知限制） | `` `[[x]]` `` | 当前会误双写（断言已知行为，待 §5.3 评估） |
| 保留原 wikilink | 任意 | `[[...]]` 未删除（Obsidian 兼容断言） |
| buildSlugIndex | 含 index.md/log.md/concepts/foo.md | reserved 排除，foo 收集 |

### 7.2 回归

- English-Teaching / Invest 导出后 `validate-okf.mjs --soft` §5 link warn = 0（硬性 C1/C2/C3 不退化）
- `npm run test:mocks` 全过（零侵入 ingest/wiki-graph）
- 抽样：OKF visualizer 关系图边数增长、节点非孤立

---

## 8. 决策记录（已确认）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| A | 双写范围 | **concept + index.md**（log 跳过） | index 含目录 wikilink；log 无 link |
| B | wikilink 形式 | 全集（§4 表），含 `/` 跳过 | 覆盖 Obsidian 常见；不猜相对路径 |
| C | Title 来源 | **alias ?? slug**（不读目标 fm.title） | 零额外 IO；alias 已是作者意图 |
| D | 插入格式 | **`[[foo]] ([Foo](/path.md))` 括号** | 视觉明确、consumer 可抽边 |
| E | slug 匹配 | **精确**（不 normalize 大小写/空格） | 避免误连；YAGNI |
| — | 悬空 warning | 不记 | 源常态，避免噪音 |
| — | 重名 | 不双写 + 日志 | §5.2 宁可丢边不造错边 |

---

## 9. 任务拆分（~1 天）

1. `okf-convert.ts`：`buildSlugIndex` + `doubleWriteWikilinks` + `convertConcept` 加 `slugIndex?` 参数
2. 编排层（tauri + node 两版）：构建索引 + concept 传参 + index.md 双写
3. 单元测试（§7.1 全用例）
4. 端到端：导出 English-Teaching/Invest → `validate-okf.mjs --soft` §5 warn 清零
5. 注释更新（§6.4）

---

## 10. 风险与回滚

- **风险低**：双写是导出层只读转换的增量，源 wiki 不动；`slugIndex` 可选参数，不传即 P0a 行为。
- **重名误判**：精确 slug 匹配 + 重名不双写 + 日志，避免错边。
- **回滚**：`convertConcept` 不传 `slugIndex` / 编排层不建索引即回退 P0a；删除新增函数完全回滚。

// docs/superpowers/deploy/lib/normalize-core.mjs
//
// 非 slug 历史 wiki 页收编工具纯函数库（m3-impl-review W2 遗留项）。
// 职责：slug 计算（英文机械化 / 中文标记走 LLM 短语）、孪生页五级探测
// （exact-dir / exact-crossdir / stem-equiv / paren-stripped / title）、
// rename vs merge 决策表（多胞胎迭代合并、目标撞车 -2 去重）、
// 入链改写（复用 translate-core 的 mask/unmask 与解析上下文）、
// 图边数/悬空链接模拟（复刻 src-server graph.rs 解析语义的近似）。
//
// 约束：零 fs/网络依赖（LLM 调用与 REST 在 ../normalize-wiki-paths.mjs），
// 输入进输出出；node --test / vitest 均可直接 import 测试（双 runner shim
// 见 normalize-core.test.mjs）。导入 translate-core.mjs（同为纯函数库）。

import {
  RESERVED_PAGES, normKey, pathStem, maskWikilinks, slotToken, resolveTargetPath,
} from "./translate-core.mjs";

// ── path 形态判定 ──

/** 与服务端 ingest_pipeline.rs is_valid_wiki_path 同一允许集（ASCII slug）。 */
export const SLUG_PATH_RE = /^[a-z0-9/_\.\-]+$/;
export const isSlugPath = (path) => typeof path === "string" && path !== "" && SLUG_PATH_RE.test(path);

export const dirOf = (path) => {
  const i = String(path ?? "").lastIndexOf("/");
  return i === -1 ? "" : String(path).slice(0, i);
};

export const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(s ?? ""));

/** 非 slug 收编目标集：非 slug path、排除 transcripts/（CLI 直写不走校验）与 reserved 三页。 */
export function selectNonSlugPages(pages) {
  return pages.filter((p) =>
    !p.path.startsWith("transcripts/") &&
    !RESERVED_PAGES.has(p.path) &&
    !isSlugPath(p.path),
  );
}

/** 孪生候选池：slug 页、排除 transcripts/ 与 reserved。 */
export function selectTwinCandidates(pages) {
  return pages.filter((p) =>
    !p.path.startsWith("transcripts/") &&
    !RESERVED_PAGES.has(p.path) &&
    isSlugPath(p.path),
  );
}

// ── slug 计算 ──

/**
 * 机械化 slug（对齐工具规格：小写、去标点保留字母数字空格、空格段→连字符、
 * 压缩连续连字符）。CJK 字符按"非字母数字"被剔除（含 CJK 的输入应先走 LLM
 * 翻译成英文短语——needsLlmSlug 负责路由）。
 *   "Meaning vs. Form" → "meaning-vs-form"
 *   "PPP (Presentation, Practice, Production)" → "ppp-presentation-practice-production"
 */
export function mechanicalSlugStem(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 去括号组（半角/全角），括号内容视为修饰语丢弃（"TBLT (Task…)" → "TBLT"）。 */
export function stripParens(s) {
  return String(s ?? "")
    .replace(/\([^()]*\)/g, " ")
    .replace(/（[^（）]*）/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 词序无关 token 集键：slug 化→拆词→排序（孪生探测第 5 级用；括号折叠为分隔符，
 *  括号内词保留参与匹配——"New Concept English (Youth Edition)" ≡ "New Concept English Youth Edition"）。 */
export function tokenKey(s) {
  return mechanicalSlugStem(s).split("-").filter(Boolean).sort().join("-");
}

/** 该页是否需要 LLM 翻译标题再 slug 化：stem 含 CJK，或机械化后为空（纯标点）。 */
export function needsLlmSlug(page) {
  const stem = pathStem(page.path);
  return hasCJK(stem) || mechanicalSlugStem(stem) === "";
}

/**
 * 组装 slug 探测信息。
 * @param page      非 slug 页（REST GET /pages 条目）
 * @param llmPhrase 中文标题的 LLM 英文短语（needsLlmSlug 时必填，否则忽略）
 * @returns {slug, strippedSlug, titleKey, tokenKey, source, phrase}
 *   - slug          机械化 slug（英文形态来自 stem；中文形态来自 LLM 短语）
 *   - strippedSlug  去括号后的 slug（第 4 级 paren-stripped 用）
 *   - titleKey/tokenKey 标题侧键（英文形态用页 title；中文形态用 LLM 短语）
 */
export function buildSlugInfo(page, llmPhrase = null) {
  const stem = pathStem(page.path);
  const llm = needsLlmSlug(page) ? String(llmPhrase ?? "").trim() : null;
  const base = llm ?? stem;
  let slug = mechanicalSlugStem(base);
  if (slug === "" && page.title != null) slug = mechanicalSlugStem(stripParens(page.title)); // 兜底：stem 纯标点时取 title
  const strippedBase = stripParens(base);
  const titleSrc = llm ?? page.title ?? "";
  return {
    slug,
    strippedSlug: strippedBase === base ? slug : mechanicalSlugStem(strippedBase),
    titleKey: normKey(titleSrc),
    tokenKey: tokenKey(titleSrc),
    source: llm != null ? "llm" : "mechanical",
    phrase: llm,
  };
}

// ── 孪生探测（六级 + curated 覆盖，逐级收紧歧义保护） ──

/**
 * curated 孪生钉死表（2026-08-21 dry-run 核实，见 task-normalize-wiki-paths-report.md）：
 * 标题级孪生（title/token-set/fuzzy 基）在翻译 v2 完成后可能漂移——twin 的英文标题会被
 * 译成中文，短语/标题比对失效导致误判 rename 造重复页。path 基（exact/stem-equiv/
 * paren-stripped）不受影响。两处标题基决策钉死如下（同 translate-core
 * LEGACY_LINK_RECOVERY 的 curated 先例）：
 *   青少版新概念英语 ↔ entities/new-concept-english.md（"Youth Version" vs "(Youth Edition)"）
 *   entities/Flipped Classroom.md ↔ concepts/flip-classroom.md（title 基）
 */
export const TWIN_OVERRIDES = {
  "entities/青少版新概念英语.md": "entities/new-concept-english.md",
  "entities/Flipped Classroom.md": "concepts/flip-classroom.md",
};

const STEM_KEY_CACHE = new WeakMap();
/** 页 stem 的折叠键（大小写/下划线/标点差异折叠："british_council"≡"British Council"）。 */
function stemKeyOf(twin) {
  let k = STEM_KEY_CACHE.get(twin);
  if (k === undefined) {
    k = mechanicalSlugStem(pathStem(twin.path));
    STEM_KEY_CACHE.set(twin, k);
  }
  return k;
}

/**
 * 在 slug 候选池中为非 slug 页找孪生。curated 覆盖 + 六级链（前一级命中即止）：
 *  A exact-dir       同目录 + 计算 slug 精确存在（concepts/Pinterest.md → concepts/pinterest.md）
 *  B exact-crossdir  跨目录 + 计算 slug 精确存在（entities/Second Conditional.md → concepts/second-conditional.md）
 *  C stem-equiv      stem 折叠键相等（下划线/大小写变体：concepts/British Council.md → concepts/british_council.md）
 *  D paren-stripped  去括号后相等（concepts/Teachers Pay Teachers (TpT).md → concepts/teachers_pay_teachers.md；
 *                    entities/TBLT (Task Based Language Teaching).md → concepts/tblt.md）
 *  E title           标题侧匹配：normKey（第 5a）→ 词序无关 token 集相等（第 5b，中文 LLM 短语 ↔
 *                    "New Concept English (Youth Edition)"）
 *  F fuzzy           token 交并比 ≥0.6 且公共 token ≥3 的唯一最优（余量 ≥0.2）——同义变体兜底
 *                    （"Youth Version New Concept English" ↔ "New Concept English (Youth Edition)"）
 * 每级仅在「恰好一个不同目标」时采纳；多个不同目标 → 歧义，跳过该级继续（宁 rename 不错并）。
 * @returns {{path, basis, crossDir}|null}
 */
export function findTwin(page, info, twins, log = () => {}) {
  const dir = dirOf(page.path);
  const take = (candidates, basis) => {
    const uniq = [...new Map(candidates.map((t) => [t.path, t])).values()];
    if (uniq.length === 1) {
      return { path: uniq[0].path, basis, crossDir: dirOf(uniq[0].path) !== dir };
    }
    if (uniq.length > 1) log(`  孪生歧义(${basis}): ${page.path} → ${uniq.map((t) => t.path).join(", ")}，跳过该级`);
    return null;
  };
  // curated 覆盖优先（目标不在候选池 → 告警并继续常规链）
  const ov = TWIN_OVERRIDES[page.path];
  if (ov != null) {
    const t = twins.find((x) => x.path === ov);
    if (t) return { path: t.path, basis: "override", crossDir: dirOf(t.path) !== dir };
    log(`  覆盖目标不在候选池: ${page.path} → ${ov}，回落常规探测`);
  }
  if (info.slug === "") return null; // 无可用 slug（调用方应判 needsReview）
  const tk = info.tokenKey.split("-").filter(Boolean);
  const jaccard = (t) => {
    const tt = new Set(tokenKey(t.title ?? "").split("-").filter(Boolean));
    if (tt.size === 0 || tk.length < 3) return -1;
    let inter = 0;
    for (const x of tk) if (tt.has(x)) inter++;
    return inter >= 3 ? inter / new Set([...tk, ...tt]).size : -1;
  };
  let r =
    take(twins.filter((t) => t.path === `${dir}/${info.slug}.md`), "exact-dir") ??
    take(twins.filter((t) => pathStem(t.path) === info.slug), "exact-crossdir") ??
    take(twins.filter((t) => stemKeyOf(t) === info.slug), "stem-equiv") ??
    take(twins.filter((t) => {
      const k = stemKeyOf(t);
      const ks = mechanicalSlugStem(stripParens(pathStem(t.path)));
      return info.strippedSlug !== "" && (info.strippedSlug === k || info.strippedSlug === ks) ||
             ks !== "" && info.slug === ks;
    }), "paren-stripped") ??
    take(twins.filter((t) => t.title != null && normKey(t.title) === info.titleKey && info.titleKey !== ""), "title") ??
    take(twins.filter((t) => t.title != null && tokenKey(t.title) === info.tokenKey && info.tokenKey !== ""), "token-set");
  if (r == null && tk.length >= 3) {
    const scored = twins
      .map((t) => ({ t, j: jaccard(t) }))
      .filter((x) => x.j >= 0.6)
      .sort((a, b) => b.j - a.j || a.t.path.localeCompare(b.t.path));
    if (scored.length >= 1 && (scored.length === 1 || scored[0].j - scored[1].j >= 0.2)) {
      r = take([scored[0].t], "fuzzy");
    }
  }
  return r;
}

// ── 决策表 ──

export function mergeSources(...arrays) {
  const out = [];
  const seen = new Set();
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (typeof s === "string" && !seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  return out;
}

/**
 * 全量决策：逐页 rename/merge + 撞车去重 + 多胞胎分组。
 * @param pages          全部页（REST 快照）
 * @param slugInfoByPath Map<path, buildSlugInfo 结果>（中文页已含 LLM 短语）
 * @returns {decisions, groups, warnings}
 *   decisions: [{path, title, contentLen, decision, target, basis, slugSource, phrase, reason}]
 *   groups:    Map<targetPath, {target, members[], winnerPath, dropped[{path,len}], sources, title}>
 *              members 含目标页自身（dropped 记录落败者含目标页旧正文）
 */
export function computeDecisions(pages, slugInfoByPath, { log = () => {} } = {}) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const nonSlug = selectNonSlugPages(pages);
  const twins = selectTwinCandidates(pages);
  const warnings = [];
  const decisions = [];
  const planned = new Set(); // 本轮已分配的 rename 目标（撞车去重用）

  for (const p of nonSlug) {
    const info = slugInfoByPath.get(p.path);
    const contentLen = (p.content ?? "").length;
    if (!info) {
      decisions.push({ path: p.path, title: p.title, contentLen, decision: "needs-review", target: null, basis: null, slugSource: null, phrase: null, reason: "缺 slugInfo（调用方未提供）" });
      warnings.push(`${p.path}: 缺 slugInfo，标记 needs-review`);
      continue;
    }
    if (info.slug === "") {
      decisions.push({ path: p.path, title: p.title, contentLen, decision: "needs-review", target: null, basis: null, slugSource: info.source, phrase: info.phrase, reason: "机械化 slug 为空（LLM 短语缺失或无效）" });
      warnings.push(`${p.path}: slug 为空，标记 needs-review`);
      continue;
    }
    const twin = findTwin(p, info, twins, log);
    if (twin) {
      decisions.push({
        path: p.path, title: p.title, contentLen,
        decision: "merge", target: twin.path, basis: twin.basis,
        slugSource: info.source, phrase: info.phrase,
        reason: `孪生 ${twin.path}（${twin.basis}${twin.crossDir ? "，跨目录" : ""}）——正文长者胜、sources 并集、title 保留孪生现值`,
      });
      continue;
    }
    // rename：目标撞现存页或本轮已分配目标 → -2/-3 去重
    const dir = dirOf(p.path);
    let slug = info.slug;
    let n = 2;
    while (byPath.has(`${dir}/${slug}.md`) || planned.has(`${dir}/${slug}.md`)) {
      const clash = `${dir}/${slug}.md`;
      const next = `${dir}/${info.slug}-${n}.md`;
      warnings.push(`slug 目标撞车: ${p.path} → ${clash}${byPath.has(clash) ? "（现存页）" : "（本轮已分配）"}，改用 ${next}`);
      slug = `${info.slug}-${n++}`;
    }
    const target = `${dir}/${slug}.md`;
    planned.add(target);
    decisions.push({
      path: p.path, title: p.title, contentLen,
      decision: "rename", target, basis: null,
      slugSource: info.source, phrase: info.phrase,
      reason: `无孪生 → 迁移到新 slug 路径（frontmatter/title/content/sources 沿用）`,
    });
  }

  // 多胞胎分组：同 target 的 merge 决策迭代合并到同一 slug 目标（成员含目标页自身——
  // 其正文同样参与"长者胜"竞争，落败记入 dropped 供备份与报告）
  const groups = new Map();
  for (const d of decisions) {
    if (d.decision !== "merge") continue;
    let g = groups.get(d.target);
    if (!g) {
      const targetPage = byPath.get(d.target);
      g = {
        target: d.target,
        targetPage,
        members: targetPage ? [targetPage] : [], // [targetPage, ...非 slug 成员]，winner 为 contentLen 最大者（并列取 path 序）
        dropped: [],
        sources: Array.isArray(targetPage?.sources) ? [...targetPage.sources] : [],
        title: targetPage?.title ?? null,
      };
      groups.set(d.target, g);
    }
    g.members.push(byPath.get(d.path));
    g.sources = mergeSources(g.sources, byPath.get(d.path)?.sources);
    if (g.title == null && d.title != null) g.title = d.title; // 孪生 title 为空 → 取非 slug 页的
  }
  for (const g of groups.values()) {
    g.members.sort((a, b) => (b.content ?? "").length - (a.content ?? "").length || a.path.localeCompare(b.path));
    g.winnerPath = g.members[0]?.path ?? g.target;
    g.dropped = g.members.filter((m) => m.path !== g.winnerPath)
      .map((m) => ({ path: m.path, len: (m.content ?? "").length }));
    if (g.members.length > 2) {
      log(`  多胞胎合并: ${g.target} ← ${g.members.length - 1} 个非 slug 页（winner ${g.winnerPath}）`);
    }
  }
  return { decisions, groups, warnings };
}

// ── 入链改写（复用 translate-core 的 mask/unmask 与解析上下文） ──

/**
 * 把正文中「解析到本次收编旧 path」的 [[...]] 改写为 [[新slug|现标题]]。
 * 其他链接一律原样（含悬空、指向 slug 页的——最小 diff）；fence 内不动（mask 保证）；
 * 已有 alias 保留（作者选择的显示文本），锚点保留（translate-core renderWikilink 同款）。
 * @param ctx        buildLinkCtx(当前页表, {}, []) —— 解析当前指向
 * @param finalPath  Map<旧path, 存活path>（merge→孪生 path；rename→新 slug path）
 * @param finalTitle Map<存活path, 现标题>（rename 页沿用自身 title；merge 取孪生 title）
 * @returns {content, changes:[{from,to}]}
 */
export function rewriteLinksToPlan(body, ctx, finalPath, finalTitle) {
  const { masked, slots } = maskWikilinks(body);
  let out = masked;
  const changes = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    let rep = s.raw;
    if (s.kind === "wl") {
      const tgt = resolveTargetPath(ctx, s.target);
      const dest = tgt != null ? finalPath.get(tgt) : undefined;
      if (dest != null && dest !== tgt) {
        const stem = pathStem(dest);
        const label = finalTitle.get(dest) ?? ctx.effTitle.get(dest) ?? s.target;
        if (!/[|\[\]\n]/.test(stem)) { // 异常 slug 不硬写（translate-core 同款护栏）
          const alias = (s.alias !== undefined && s.alias !== "")
            ? s.alias
            : (/[|\[\]\n]/.test(label) ? s.target : label);
          rep = `[[${stem}${s.anchor ?? ""}|${alias}]]`;
        }
      }
    }
    if (rep !== s.raw) changes.push({ from: s.raw, to: rep });
    out = out.split(slotToken(s, i)).join(rep);
  }
  return { content: out, changes };
}

// ── 图边数/悬空链接模拟（复刻 graph.rs 解析语义的确定性近似） ──

/** graph.rs normalize_stem 语义：小写 + 每个空格字符→连字符（空白 run 不折叠）。 */
export const graphNorm = (s) => String(s ?? "").trim().toLowerCase().split(" ").join("-");
const GRAPH_LINK_RE = /\[\[([^\]|\n]+?)(?:\|[^\]]+)?\]\]/g;

/** graph.rs extract_wikilinks 同款（target 含锚点——锚点使其不可解析，忠实复刻）。 */
export function extractGraphWikilinks(content) {
  const out = [];
  for (const m of String(content ?? "").matchAll(GRAPH_LINK_RE)) out.push(m[1].trim());
  return out;
}

/**
 * 图谱统计近似：nodes（非 query 页）、无向去重边数、可解析/悬空链接种数。
 * 与 graph.rs 的差异（近似声明）：stem 表 first-wins 按 path 字典序（服务端按 DB 行序，
 * 本身不稳定）；其余语义（title 碰撞整组除名、自环跳过、无向对去重）一致。
 */
export function simulateGraphStats(pages) {
  const ps = pages
    .filter((p) => (p.page_type ?? "") !== "query")
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));
  const stemMap = new Map(); // graphNorm(stem) → path，first-wins
  for (const p of ps) {
    const k = graphNorm(pathStem(p.path));
    if (!stemMap.has(k)) stemMap.set(k, p.path);
  }
  const titleGroups = new Map(); // graphNorm(title) → [path]
  for (const p of ps) {
    if (p.title == null || String(p.title).trim() === "") continue;
    const k = graphNorm(p.title);
    const list = titleGroups.get(k) ?? [];
    list.push(p.path);
    titleGroups.set(k, list);
  }
  const titleMap = new Map();
  for (const [k, list] of titleGroups) if (list.length === 1) titleMap.set(k, list[0]); // 碰撞整组除名

  const edges = new Set();
  let resolvedLinks = 0, danglingLinks = 0;
  for (const p of ps) {
    for (const raw of extractGraphWikilinks(p.content)) {
      const key = graphNorm(raw);
      const tgt = stemMap.get(key) ?? titleMap.get(key);
      if (tgt == null) { danglingLinks++; continue; }
      resolvedLinks++;
      if (tgt === p.path) continue; // 自环跳过
      edges.add(p.path < tgt ? `${p.path}\n${tgt}` : `${tgt}\n${p.path}`);
    }
  }
  return { nodes: ps.length, edges: edges.size, resolvedLinks, danglingLinks };
}

/**
 * 组装「执行后」虚拟页表（stats 用）：旧 23 页移除；rename 页以新 path/改写后正文出现；
 * merge 目标页换合并正文与最终 title；其余存活页换改写后正文。
 * @param rewrite (pageLike) => string 内容改写回调（注入 ctx/finalPath/finalTitle 的闭包）
 */
export function composePostPlanPages(pages, decisions, groups, rewrite) {
  const oldPaths = new Set(decisions.map((d) => d.path));
  const renameByPath = new Map(decisions.filter((d) => d.decision === "rename").map((d) => [d.path, d]));
  const out = [];
  for (const p of pages) {
    if (oldPaths.has(p.path)) continue;
    const g = groups.get(p.path);
    if (g) {
      const winner = g.members.find((m) => m.path === g.winnerPath) ?? p;
      out.push({ ...p, title: g.title ?? p.title ?? null, content: rewrite({ ...winner, path: g.target }) });
      continue;
    }
    const rewritten = rewrite(p);
    out.push(rewritten === p.content ? p : { ...p, content: rewritten });
  }
  for (const [oldPath, d] of renameByPath) {
    const src = pages.find((p) => p.path === oldPath);
    if (src) out.push({ ...src, path: d.target, content: rewrite({ ...src, path: d.target }) });
  }
  return out;
}

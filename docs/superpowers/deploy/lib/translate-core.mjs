// docs/superpowers/deploy/lib/translate-core.mjs
//
// wiki 翻译脚本纯函数库（m3-impl-review W4 抽取自 ../translate-wiki-pages.mjs，纯重构——
// 函数体逐行等价，仅把模块级 PROGRESS 依赖（titleMap/collisions/completed）与 log 改为参数注入）。
// 约束：零 fs/网络/进度文件依赖（输入进、输出出），node --test / vitest 均可直接 import 测试。
// 正在跑的翻译进程不受影响（node 启动时已加载旧内联版）；未来重跑由
// translate-wiki-pages.mjs import 本模块，行为与内联版一致。

/** reserved 页：ingest 每轮重建，翻译会被覆盖 → 跳过 */
export const RESERVED_PAGES = new Set(["wiki/index.md", "wiki/log.md", "wiki/overview.md"]);
/** 中文字符占比阈值：> 0.60 视为已是中文页，跳过 */
export const ZH_RATIO_SKIP = 0.6;

export function zhRatio(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const nonSpace = (s.match(/\S/g) ?? []).length;
  return nonSpace === 0 ? 0 : cjk / nonSpace;
}
/** 中文占比排除：正文已 ≥ 阈值视为中文页，跳过翻译（对齐主循环 ZH_RATIO_SKIP 判定） */
export const isChinesePage = (content) => zhRatio(content) > ZH_RATIO_SKIP;

/** 归一化链接键：小写 + 空白→连字符（与服务端 graph.rs normalize_stem 对齐） */
export const normKey = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-");
/** path 末段去 .md（= 图谱 stem 表的键） */
export const pathStem = (p) => String(p ?? "").split("/").pop().replace(/\.md$/, "");

/** 历史遗留恢复映射：前任运行（已 kill）把已完成页链接目标改写为【译后中文标题】，
 *  其中指向 I4 碰撞组的中文值随恒等化从 titleMap 丢失（collisions 记录亦被后续运行
 *  覆盖）。以下 pairs 由首发备份 translate-backup-20260821.jsonl 与当前内容按序
 *  配对回溯得到（2026-08-21 核实，共 6 对），仅用于反查链兜底。 */
export const LEGACY_LINK_RECOVERY = {
  "IELTS阅读": "IELTS Reading",
  "KWL图表": "KWL Chart",
  "合作学习": "Cooperative Learning",
  "听力微技能": "Listening Sub-skills",
  "学生档案袋": "Student Portfolio",
  "教师语言支架": "Scaffolding Through Teacher Language",
};

// ── 链接解析上下文（C1：title 表 + stem 表 + effTitle，全部页表建，不只目标集） ──
// titleMap/collisions 由调用方注入（脚本传 PROGRESS.titleMap / PROGRESS.collisions）。
// 返回的 ctx 携带 titleMap 引用，供 resolveTargetPath 反查——与内联版读模块级 PROGRESS 等价。
export function buildLinkCtx(pages, titleMap, collisions = []) {
  const exact = new Map();    // 精确 title → path；同 title 多页 → null（歧义）
  const normTitle = new Map(); // 归一化 title → path；归一化碰撞 → null（歧义）
  for (const p of pages) {
    if (!p.title) continue;
    const prev = exact.get(p.title);
    exact.set(p.title, prev === undefined ? p.path : null);
    const k = normKey(p.title);
    const prevN = normTitle.get(k);
    normTitle.set(k, prevN === undefined ? p.path : null);
  }
  const normStem = new Map(); // 归一化 stem → path；重复 stem 取首个（对齐服务端 build_stem_to_path）
  for (const p of pages) {
    const k = normKey(pathStem(p.path));
    if (!normStem.has(k)) normStem.set(k, p.path);
  }
  const effTitle = new Map(); // path → 最终标题（titleMap 有则中文，无/碰撞则原英文）
  for (const p of pages) {
    if (!p.title) continue;
    effTitle.set(p.path, titleMap[p.title] ?? p.title);
  }
  // 反查表：titleMap 值(中文) → 键(原英文标题)。I4 碰撞组已恒等化，值理应唯一；
  // 万一仍有重复值 → null（歧义不解析）。
  const revTitle = new Map();
  for (const [k, v] of Object.entries(titleMap)) {
    const prev = revTitle.get(v);
    revTitle.set(v, prev === undefined ? k : null);
  }
  // 碰撞组的译后中文值已被 I4 恒等化覆盖，从 progress.collisions 记录的
  // translated（覆盖前终值）补建反查——历史 [[中文标题]] 链接仍可回溯到英文标题。
  for (const c of collisions ?? []) {
    for (const m of c.pages ?? []) {
      if (typeof m?.translated === "string" && typeof m?.title === "string" && m.translated !== m.title) {
        const prev = revTitle.get(m.translated);
        if (prev === undefined) revTitle.set(m.translated, m.title);
        else if (prev !== m.title) revTitle.set(m.translated, null); // 同中文值对应多个英文标题 → 歧义
      }
    }
  }
  for (const [zh, en] of Object.entries(LEGACY_LINK_RECOVERY)) {
    if (!revTitle.has(zh)) revTitle.set(zh, en);
  }
  return { exact, normTitle, normStem, effTitle, revTitle, titleMap };
}

/** 链接目标文本 → 目标页 path（对齐图谱双表解析：stem 优先、title 兜底）。悬空 → null。 */
export function resolveTargetPath(ctx, rawTitle) {
  const t = String(rawTitle ?? "").trim();
  if (!t) return null;
  const ex = ctx.exact.get(t);
  if (ex) return ex;
  const nk = normKey(t);
  const nt = ctx.normTitle.get(nk);
  if (nt) return nt;
  const st = ctx.normStem.get(nk);
  if (st) return st;
  // 目标页已被翻译（DB 标题已是中文）：经 titleMap 旧标题→新标题 反查
  const mapped = ctx.titleMap[t];
  if (mapped && mapped !== t) {
    const m = ctx.exact.get(mapped);
    if (m) return m;
    const mn = ctx.normTitle.get(normKey(mapped));
    if (mn) return mn;
  }
  // 历史遗留：前任脚本把链接改写成了目标页的【译后中文标题】，而目标页本体尚未翻译
  // （DB 标题仍英文）——经反查表 中文→原英文 再解析
  const rev = ctx.revTitle.get(t);
  if (rev && rev !== t) {
    const r = ctx.exact.get(rev);
    if (r) return r;
    const rn = ctx.normTitle.get(normKey(rev));
    if (rn) return rn;
    const rs = ctx.normStem.get(normKey(rev));
    if (rs) return rs;
  }
  return null;
}

/** 渲染别名形式链接：[[slug#锚点|alias或中文标签]]。悬空/异常内容 → 原样返回。 */
export function renderWikilink(slot, ctx) {
  const path = resolveTargetPath(ctx, slot.target);
  if (!path) return slot.raw; // 悬空链接保持原样
  const slug = pathStem(path);
  if (/[|\[\]\n]/.test(slug)) return slot.raw; // 异常 slug 不硬写
  const label = ctx.effTitle.get(path) ?? slot.target;
  const alias = (slot.alias !== undefined && slot.alias !== "")
    ? slot.alias // 已有 alias 是作者选择的显示文本，保留
    : (/[|\[\]\n]/.test(label) ? slot.target : label);
  return `[[${slug}${slot.anchor ?? ""}|${alias}]]`;
}

// ── wikilink / 代码块占位符 ──
const LINK_RE = /\[\[([^\[\]]+?)\]\]/g;
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;

/** 把正文里所有 [[...]] 与 ```代码块``` 换成 ⟦WLn⟧/⟦Cn⟧ 占位符。返回 {masked, slots}。 */
export function maskWikilinks(body) {
  const slots = [];
  const push = (kind, raw, target, anchor, alias) => {
    const idx = slots.length;
    slots.push({ kind, raw, target, anchor, alias });
    return `${kind === "wl" ? "\u27e6WL" : "\u27e6C"}${idx}\u27e7`;
  };
  // 先 fence 后 wikilink（fence 里的 [[..]] 不该动；fence 整体被 mask 后无 [[]] 残留）
  let masked = body.replace(FENCE_RE, (m) => push("code", m));
  masked = masked.replace(LINK_RE, (m) => {
    const inner = m.slice(2, -2);
    const [head, alias] = inner.split("|");
    const hashIdx = head.indexOf("#");
    const target = (hashIdx === -1 ? head : head.slice(0, hashIdx)).trim();
    const anchor = hashIdx === -1 ? "" : head.slice(hashIdx);
    return push("wl", m, target, anchor, alias);
  });
  return { masked, slots };
}
export const slotToken = (s, i) => `${s.kind === "wl" ? "\u27e6WL" : "\u27e6C"}${i}\u27e7`;

/** 译文里还原占位符：wl 按解析结果改写为别名形式（悬空原样），code 原样还原。
 *  占位符丢失（LLM 改动了受保护内容）→ throw（调用方拒写该页）。 */
export function unmaskWikilinks(translated, slots, ctx) {
  let out = translated;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const replacement = s.kind === "code" ? s.raw : renderWikilink(s, ctx);
    if (!out.includes(slotToken(s, i))) throw new Error(`译文丢失占位符 ${slotToken(s, i)}（LLM 改动了受保护内容）`);
    out = out.split(slotToken(s, i)).join(replacement);
  }
  // 容错：LLM 偶尔会把 ⟦WLn⟧ 写成 [[WLn]] 等
  out = out.replace(/\[\[WL(\d+)\]\]/g, (_, n) => slots[Number(n)]?.raw ?? _);
  return out;
}

/** 确定性链接改写（修复 pass 用，不经 LLM）：全部 [[...]] 按别名形式重写，fence 不动。 */
export function rewriteLinksInBody(body, ctx) {
  const { masked, slots } = maskWikilinks(body);
  let out = masked;
  for (let i = 0; i < slots.length; i++) {
    out = out.split(slotToken(slots[i], i)).join(slots[i].kind === "code" ? slots[i].raw : renderWikilink(slots[i], ctx));
  }
  return out;
}

// ── I4：标题碰撞检测——碰撞组全部保持英文标题不翻 ──
// 纯版：titleMap 由调用方注入并被就地恒等化（碰撞组 title→原 title）；log 注入（默认静默）。
// 返回 collisions 清单；调用方（脚本）负责写入 progress.collisions。
export function detectTitleCollisions(pages, titleMap, log = () => {}) {
  const groups = new Map(); // normKey(最终标题) → [{path, title}]
  for (const p of pages) {
    if (!p.title) continue;
    const eff = titleMap[p.title] ?? p.title;
    const k = normKey(eff);
    const list = groups.get(k) ?? [];
    list.push({ path: p.path, title: p.title, eff });
    groups.set(k, list);
  }
  const collisions = [];
  for (const [k, members] of groups) {
    if (members.length <= 1) continue;
    for (const m of members) titleMap[m.title] = m.title; // 保持英文标题
    collisions.push({ normalizedTitle: k, pages: members.map((m) => ({ path: m.path, title: m.title, translated: m.eff })) });
    log(`I4 碰撞: 标题 "${members[0].eff}" 归一化后为 "${k}"，被 ${members.length} 页共享——整组保持英文标题:`);
    for (const m of members) log(`    ${m.path} (原 title: ${m.title})`);
  }
  if (collisions.length > 0) log(`I4: 共 ${collisions.length} 组标题碰撞，清单已记入进度文件 .collisions`);
  return collisions;
}

// ── 目标页过滤：非 transcripts/、非 reserved、未完成、非空、title 非 null（M2） ──
// completed（PROGRESS.completed Set）由调用方注入；返回 {targets, nullTitle}。
export function selectTranslationTargets(pages, { completed = new Set(), reservedPages = RESERVED_PAGES } = {}) {
  const candidates = pages.filter((p) =>
    !p.path.startsWith("transcripts/") &&
    !reservedPages.has(p.path) &&
    !completed.has(p.path) &&
    (p.content ?? "").trim() !== "",
  );
  return {
    targets: candidates.filter((p) => p.title != null),
    nullTitle: candidates.filter((p) => p.title == null),
  };
}

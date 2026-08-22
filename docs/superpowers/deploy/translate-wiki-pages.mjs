#!/usr/bin/env node
// docs/superpowers/deploy/translate-wiki-pages.mjs
//
// 存量 wiki 页面批量中文化（LT 师训 · project 614，~600 LLM 生成英文页）。
// Node ≥ 20（原生 fetch），零外部依赖；不进 src-server 构建。
//
// 用法：
//   node translate-wiki-pages.mjs [--limit N] [--project 614]
//        [--api http://127.0.0.1:8080] [--omlx http://127.0.0.1:8001]
//        [--bootstrap <path/to/bootstrap.env>] [--model NAME]
//
// 设计要点（详见 task-zh-batch-report.md）：
// - 翻译引擎：本地 omlx /v1/chat/completions，模型名从 GET /v1/models 动态取（Qwen 优先）。
// - 写入通道：src-server REST PUT /api/v1/projects/:id/page（If-Match 乐观锁），
//   绝不直连 DB——PUT 会触发 re-embed（pages.rs update_page → embed_page），保检索干净。
// - 鉴权：svc-transcriber 服务账号，凭据从 tools/transcriber/out/bootstrap.env 读
//   （或 env SVC_USERNAME/SVC_PASSWORD 覆盖），密码不落日志不落 commit。
// - wikilink 别名形式（Fix round 2 C1）：链接一律重写为 [[english-slug|中文标签]]——
//   slug = 目标页 path 末段（与图谱解析的 stem 表对齐），标签 = 目标页最终标题
//   （titleMap 有则中文，无/碰撞则原英文）。悬空链接（目标不在页表）保持原样；
//   链接里已有的 alias 与 #锚点 保留。启动时对已完成页跑链接修复 pass（历史
//   [[中文标题]] 裸链接改写为别名形式）。
// - 并发安全（I1）：If-Match 用主循环 GET 时刻的 updated_at；PUT 409 → 重新 GET +
//   重新翻译该页（不复用旧译文），上限 PUT_ROUNDS 轮。
// - 备份（I2）：每次启动无条件全量快照全部页面（path/title/updated_at/content/
//   frontmatter 全字段）到当日新文件（同名已存在则 -2/-3 递增），tmp+rename 原子写。
// - 进度（I3）：~/.llm-wiki-mcp/translate-progress.json 每页落盘，tmp+rename 原子写。
// - 碰撞（I4）：Pass1 后检测不同 path 的标题译后同中文/同归一化——碰撞组全部保持
//   英文标题不翻，告警清单记日志与进度文件（.collisions）。
// - title 为 null 的页跳过翻译（M2）；PUT frontmatter 以读取到的为准回填
//   type/sources/images，仅译 title 值与正文（M3）。
// - path 是内容寻址锚：绝不翻译（concepts/xxx.md 保持英文 slug）。
// - 可恢复：重跑跳过 completed；可回滚：备份 jsonl 仓外。
// - 串行逐页（omlx 内存压力前科，不并发）；LLM 失败重试 2 次；507/Cannot load
//   快速终止（不落恒等映射、不空烧重试）。
// - 思考模式（Fix round 3）：LLM 调用恒带 chat_template_kwargs.enable_thinking=false
//   （Pass1 标题 + Pass2 正文共用 llm()）——Qwen serving 否则会以纯文本吐
//   "Here's a thinking process:" 前导+prompt 回显当正文（非 <think> 标签，stripThink
//   救不了）。双保险：PUT 前输出闸，译文含 thinking 痕迹或还原后残留 ⟦/⟧ → 拒写记 FAIL。
//
// 禁改范围（本脚本天然遵守）：transcripts/%（转写页，中文）、wiki/index|log|overview.md
// （reserved，ingest 重建）、learning_plans/learning_items（本脚本只碰 wiki_pages，经 API）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// W4：纯函数抽至 lib/translate-core.mjs（行为零变化的纯重构；测试见 lib/translate-core.test.mjs）。
// 进度态（titleMap/collisions/completed）与 log 在调用点注入，函数体与内联版逐行等价。
import {
  ZH_RATIO_SKIP, zhRatio, isChinesePage, buildLinkCtx, detectTitleCollisions,
  selectTranslationTargets, maskWikilinks, unmaskWikilinks, rewriteLinksInBody,
  hasThinkingLeakOrSlotResidue,
} from "./lib/translate-core.mjs";

// ── CLI ──
function parseArgs(argv) {
  const out = { limit: Infinity, project: null, api: "http://127.0.0.1:8080", omlx: "http://127.0.0.1:8001", bootstrap: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--project") out.project = Number(argv[++i]);
    else if (a === "--api") out.api = argv[++i];
    else if (a === "--omlx") out.omlx = argv[++i];
    else if (a === "--bootstrap") out.bootstrap = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else { console.error(`未知参数: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}
const USAGE = `用法: node translate-wiki-pages.mjs [--limit N] [--project 614] [--api URL] [--omlx URL] [--bootstrap FILE] [--model NAME]`;

const ARGS = parseArgs(process.argv.slice(2));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const BOOTSTRAP_PATH = ARGS.bootstrap ?? join(REPO_ROOT, "tools/transcriber/out/bootstrap.env");

const MCP_HOME = join(homedir(), ".llm-wiki-mcp");
const PROGRESS_PATH = join(MCP_HOME, "translate-progress.json");
const AUTH_PATH = join(MCP_HOME, "translate-auth.json");

/** reserved 页 / 中文占比阈值 / wikilink 工具族 → lib/translate-core.mjs（W4） */
/** 标题批量翻译：每请求条数 */
const TITLE_CHUNK = 40;
/** LLM 单次调用失败重试次数（不含首发） */
const LLM_RETRIES = 2;
/** PUT If-Match 冲突重试环上限（409 → 重新 GET + 重新翻译/重写） */
const PUT_ROUNDS = 3;

// ── bootstrap.env（凭据只进内存，绝不打印） ──
function readBootstrapEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, "");
    }
  } catch { /* 文件缺失 → 走 env / 默认值 */ }
  return out;
}
const BOOT = readBootstrapEnv(BOOTSTRAP_PATH);
const PROJECT_ID = ARGS.project ?? Number(process.env.TRAINING__PROJECT_ID ?? BOOT.PROJECT_ID ?? 614);
const USERNAME = process.env.SVC_USERNAME ?? BOOT.SVC_USERNAME ?? "svc-transcriber";
const PASSWORD = process.env.SVC_PASSWORD ?? BOOT.SVC_PASSWORD;
if (!Number.isInteger(PROJECT_ID)) die(`PROJECT_ID 无效: ${PROJECT_ID}`);
if (!PASSWORD) die(`SVC_PASSWORD 缺失（${BOOTSTRAP_PATH} 无 SVC_PASSWORD 且 env 未设）`);

// ── 原子写（I2/I3：tmp + rename，读者永远看到完整文件） ──
function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
/** 当日新备份文件名；同名已存在则 -2/-3 递增（I2：每次启动无条件新文件） */
function newBackupPath() {
  const base = `translate-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  let p = join(MCP_HOME, `${base}.jsonl`);
  let n = 2;
  while (existsSync(p)) p = join(MCP_HOME, `${base}-${n++}.jsonl`);
  return p;
}

// ── 进度文件（I3：原子写） ──
function loadProgress() {
  try {
    const j = JSON.parse(readFileSync(PROGRESS_PATH, "utf-8"));
    return { completed: new Set(j.completed ?? []), failed: j.failed ?? {}, titleMap: j.titleMap ?? {}, collisions: j.collisions ?? [], model: j.model ?? null };
  } catch { return { completed: new Set(), failed: {}, titleMap: {}, collisions: [], model: null }; }
}
function saveProgress(p) {
  mkdirSync(MCP_HOME, { recursive: true });
  const j = { completed: [...p.completed], failed: p.failed, titleMap: p.titleMap, collisions: p.collisions, model: p.model, saved_at: new Date().toISOString() };
  atomicWrite(PROGRESS_PATH, JSON.stringify(j, null, 2));
}
const PROGRESS = loadProgress();

// ── 工具 ──
function die(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
function stripThink(s) { return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); }

// ── src-server API 客户端（login / 401 重登 / GET+PUT If-Match） ──
let accessToken = null;
async function apiLogin() {
  const res = await fetch(`${ARGS.api}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("login 响应缺 access_token");
  accessToken = j.access_token;
  try {
    mkdirSync(MCP_HOME, { recursive: true });
    atomicWrite(AUTH_PATH, JSON.stringify({ access_token: accessToken, saved_at: new Date().toISOString() }));
    chmodSync(AUTH_PATH, 0o600);
  } catch { /* 持久化失败不致命 */ }
  return accessToken;
}
async function apiFetch(path, init = {}, allowRelogin = true) {
  const url = path.startsWith("http") ? path : `${ARGS.api}${path}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  let res;
  try { res = await fetch(url, { ...init, headers }); }
  catch (e) { throw new Error(`网络错误 ${url}: ${e.message}`); }
  if (res.status === 401 && allowRelogin) {
    await apiLogin();
    return apiFetch(path, init, false);
  }
  return res;
}
async function apiJson(res, what) {
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* 保留原文 */ }
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
function pageUrl(path) { return `/api/v1/projects/${PROJECT_ID}/page?path=${encodeURIComponent(path)}`; }

/** PUT 409（If-Match 过期 / 页不存在）——调用方应重新 GET 并重做（I1：不复用旧译文）。 */
class ConflictError extends Error {}

/** PUT 页面。If-Match 必须用「读取内容那一刻」的 updated_at（I1）；409 抛 ConflictError。 */
async function putPageIfMatch(path, body, ifMatch) {
  const put = await apiFetch(pageUrl(path), {
    method: "PUT",
    headers: { "if-match": ifMatch },
    body: JSON.stringify({ ...body, path }),
  });
  if (put.status === 409) throw new ConflictError(`PUT ${path}: If-Match 冲突（内容已被并发修改）`);
  return apiJson(put, `PUT ${path}`);
}

// ── omlx LLM 客户端 ──
/** 模型偏好序（内存实测 2026-08-21：6bit 27B 装不下（metal 42GB 上限，他模型已 committed ~20GB），
 *  4bit 均可载入；35B-A3B 为 MoE（激活 3B）串行吞吐最佳）。--model 显式指定则直接用。 */
const MODEL_PREFERENCE = [
  "Qwen3.6-35B-A3B-4bit", // MoE，串行 600 页吞吐优先
  "Qwen3.8-27B-4bit",
  "Qwen3.6-27B-4bit",
];
let OMLX_MODEL = ARGS.model ?? PROGRESS.model;
/** 模型加载失败（507/Cannot load）——重试无意义（换模型才可能救），标 fatal 快速终止。 */
class FatalLlmError extends Error {}
async function pickModel() {
  if (OMLX_MODEL) return OMLX_MODEL;
  const res = await fetch(`${ARGS.omlx}/v1/models`);
  if (!res.ok) throw new Error(`GET /v1/models HTTP ${res.status}`);
  const j = await res.json();
  const ids = (j.data ?? []).map((m) => m.id).filter(Boolean);
  OMLX_MODEL = MODEL_PREFERENCE.find((p) => ids.includes(p)) ?? ids.find((id) => /qwen/i.test(id)) ?? ids[0];
  if (!OMLX_MODEL) throw new Error("/v1/models 返回空");
  PROGRESS.model = OMLX_MODEL;
  saveProgress(PROGRESS);
  return OMLX_MODEL;
}
/** 单次 chat（非流式）。失败重试 LLM_RETRIES 次（3s/10s 退避）；模型加载类错误抛 FatalLlmError 不重试。 */
async function llm(messages, { temperature = 0.2, maxTokens = 8192 } = {}) {
  const model = await pickModel();
  let lastErr;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 3000 : 10000);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      const res = await fetch(`${ARGS.omlx}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        signal: controller.signal,
        // enable_thinking:false 关 Qwen 思考模式——本 serving 否则会以纯文本吐
        // "Here's a thinking process:" 前导+prompt 回显当正文（非 <think> 标签，
        // stripThink 救不了；同 normalize-wiki-paths.mjs 已修坑。Fix round 3）
        body: JSON.stringify({
          model, messages, temperature, max_tokens: maxTokens, stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const bodyText = (await res.text()).slice(0, 200);
        if (res.status === 507 || /cannot load/i.test(bodyText)) {
          throw new FatalLlmError(`模型 ${model} 无法加载（HTTP ${res.status}: ${bodyText.slice(0, 120)}）——请用 --model 换小模型`);
        }
        throw new Error(`HTTP ${res.status}: ${bodyText}`);
      }
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error("响应缺 choices[0].message.content");
      return stripThink(content);
    } catch (e) {
      if (e instanceof FatalLlmError) throw e;
      lastErr = e;
      log(`  LLM 调用失败 (${attempt + 1}/${LLM_RETRIES + 1}): ${e.message}`);
    }
  }
  throw lastErr;
}

// ── Pass 1：批量翻译标题 → 全局 oldTitle→newTitle 映射 ──
async function translateTitles(titles) {
  const need = titles.filter((t) => PROGRESS.titleMap[t] === undefined);
  if (need.length === 0) return;
  log(`Pass1: 待翻译标题 ${need.length} 个（已有映射 ${Object.keys(PROGRESS.titleMap).length}）`);
  for (let i = 0; i < need.length; i += TITLE_CHUNK) {
    const chunk = need.slice(i, i + TITLE_CHUNK);
    // 已是中文的标题直接恒等映射，省 LLM
    const todo = chunk.filter((t) => zhRatio(t) <= ZH_RATIO_SKIP);
    for (const t of chunk) if (zhRatio(t) > ZH_RATIO_SKIP) PROGRESS.titleMap[t] = t;
    if (todo.length === 0) { saveProgress(PROGRESS); continue; }

    const sys = "你是知识库术语翻译器。把英文知识条目标题译成简体中文标题：简洁、符合教育学/语言学术语惯例；专有名词、品牌与常见缩写（如 TKT、TBLT、IELTS、BBC、PPP）保留原文。只输出 JSON 对象，键为原标题（原样保留），值为中文标题，不要输出任何其他文字。";
    const user = `把下列标题译成简体中文（共 ${todo.length} 个，全部出现在输出 JSON 中）：\n${JSON.stringify(todo)}`;
    let mapped = 0;
    try {
      const raw = await llm([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.1, maxTokens: 8192 });
      const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ""));
      if (!m) throw new Error("输出无 JSON 对象");
      const obj = JSON.parse(m[0]);
      for (const t of todo) {
        const v = obj[t];
        if (typeof v === "string" && v.trim()) { PROGRESS.titleMap[t] = v.trim(); mapped++; }
      }
    } catch (e) {
      if (e instanceof FatalLlmError) throw e; // 模型级故障：终止整轮，不落恒等映射
      log(`  标题批次失败（${e.message}），逐个重试`);
    }
    // 批次内漏译的 → 单个重试；再失败 → 恒等映射（该页标题保持英文，不阻塞整轮）
    for (const t of todo) {
      if (PROGRESS.titleMap[t] !== undefined) continue;
      try {
        const raw = await llm([
          { role: "system", content: "把英文知识条目标题译成简体中文标题，简洁、符合术语惯例，专有名词/缩写保留原文。只输出中文标题本身。" },
          { role: "user", content: t },
        ], { temperature: 0.1, maxTokens: 256 });
        const v = raw.replace(/^["'\s]+|["'\s]+$/g, "").split(/\r?\n/)[0];
        PROGRESS.titleMap[t] = v || t;
      } catch (e) {
        if (e instanceof FatalLlmError) throw e;
        PROGRESS.titleMap[t] = t;
        log(`  标题单个重试仍失败，恒等映射: ${t}`);
      }
    }
    saveProgress(PROGRESS);
    log(`Pass1: ${Math.min(i + TITLE_CHUNK, need.length)}/${need.length}（本批 LLM 命中 ${mapped}/${todo.length}）`);
  }
}

// ── 链接解析上下文（C1）与 wikilink 占位符族 → lib/translate-core.mjs（W4） ──
// LEGACY_LINK_RECOVERY 历史遗留映射亦在 lib（由 buildLinkCtx 注入反查链兜底）。
// 此处注入进度态：titleMap/collisions 传 PROGRESS 值，ctx 携带 titleMap 引用
// （与内联版读模块级 PROGRESS 等价）。

// ── I4：标题碰撞检测——碰撞组全部保持英文标题不翻（核心在 lib，进度落盘留在此处） ──
function detectAndApplyTitleCollisions(pages) {
  const collisions = detectTitleCollisions(pages, PROGRESS.titleMap, log);
  PROGRESS.collisions = collisions;
  return collisions;
}

// ── Pass 2：单页翻译（只组装 PUT body，不发送——I1 由主循环持有 GET 时刻的 If-Match） ──
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function rewriteFrontmatterTitle(fmText, newTitle) {
  const lines = fmText.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^title:\s*/.test(lines[i])) { lines[i] = `title: ${JSON.stringify(newTitle)}`; found = true; break; }
  }
  if (!found) lines.unshift(`title: ${JSON.stringify(newTitle)}`);
  return lines.join("\n");
}

/** M3：PUT frontmatter 以读取到的为准——保留原键，回填缺失的 type/sources/images（DB 列值），
 *  仅 title 值被替换。防止 denormalize 默认值悄悄改写 page_type/sources。 */
function normalizedFrontmatter(page, newTitle) {
  const fm = (page.frontmatter && typeof page.frontmatter === "object" && !Array.isArray(page.frontmatter))
    ? { ...page.frontmatter }
    : {};
  if (newTitle != null) fm.title = newTitle;
  if (fm.type === undefined) fm.type = page.page_type ?? "concept";
  if (fm.sources === undefined) fm.sources = page.sources ?? [];
  if (fm.images === undefined) fm.images = page.images ?? [];
  return fm;
}

async function composePageUpdate(page, ctx) {
  if (!page.title) throw new Error("title 为 null（M2 应在主循环跳过）");
  const content = page.content ?? "";
  const newTitle = PROGRESS.titleMap[page.title] ?? page.title;
  const m = FM_RE.exec(content);
  const fmText = m ? m[1] : null;
  let body = m ? content.slice(m[0].length) : content;

  // H1 与新标题对齐（确定性替换，不依赖 LLM）
  const bodyLines = body.split(/\r?\n/);
  const h1Idx = bodyLines.findIndex((l) => l.trim() !== "");
  if (h1Idx >= 0 && /^#\s+/.test(bodyLines[h1Idx].trim())) {
    bodyLines[h1Idx] = `# ${newTitle}`;
    body = bodyLines.join("\n");
  }

  const { masked, slots } = maskWikilinks(body);
  const sys = [
    "你是专业的英文→简体中文 Markdown 翻译，为一位中文教师的个人知识库翻译维基页面。",
    "要求：",
    "1. 译文自然、术语准确（教育学/英语教学领域），符合简体中文表达习惯；专有名词、品牌、常见缩写（如 TKT、TBLT、IELTS、PPP）保留原文。",
    "2. 所有 Markdown 标题（#、##、### 等）必须译成简体中文，只有专有名词/考试名/任务名（如 IELTS、Task 2）可保留；列表、表格、粗斜体、引用等结构一律保留。",
    "3. 形如 ⟦WLn⟧ / ⟦Cn⟧ 的占位符是受保护内容，必须原样保留在原位置，绝不能翻译、删除、改写或增减。",
    "4. 只输出翻译后的 Markdown 正文，不要任何前言、解释或代码围栏包裹。",
  ].join("\n");
  const translated = await llm([{ role: "system", content: sys }, { role: "user", content: masked }]);
  const newBody = unmaskWikilinks(translated, slots, ctx);
  // 输出闸（Fix round 3）：thinking 痕迹 / 还原后残留 ⟦⟧ → throw 拒写（与占位符丢失
  // 同一失败路径：fail-safe 不落库、progress.failed 记 FAIL、可重跑补）
  if (hasThinkingLeakOrSlotResidue(newBody)) {
    throw new Error("译文含 thinking 痕迹或残留占位符 ⟦/⟧（输出闸拒写，疑思考模式泄漏）");
  }

  const newContent = fmText !== null
    ? `---\n${rewriteFrontmatterTitle(fmText, newTitle)}\n---\n\n${newBody.replace(/^\s+/, "")}\n`
    : `${newBody.replace(/^\s+/, "")}\n`;

  return { title: newTitle, content: newContent, frontmatter: normalizedFrontmatter(page, newTitle) };
}

// ── C1 修复 pass：已完成页的 [[中文标题]] 裸链接 → [[slug|中文标签]] 别名形式 ──
async function repairCompletedLinks(pages, ctx) {
  const list = pages.filter((p) => PROGRESS.completed.has(p.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (list.length === 0) { log("链接修复 pass：无已完成页"); return; }
  log(`链接修复 pass：${list.length} 页（[[中文标题]] → [[slug|中文标签]]，幂等）`);
  let fixed = 0, untouched = 0, failed = 0;
  for (const p of list) {
    try {
      for (let round = 0; round < PUT_ROUNDS; round++) {
        const fresh = await apiJson(await apiFetch(pageUrl(p.path)), `GET ${p.path}`);
        const content = fresh.content ?? "";
        if (!content.trim()) { untouched++; break; }
        const newContent = rewriteLinksInBody(content, ctx);
        if (newContent === content) { untouched++; break; }
        try {
          const body = { content: newContent, frontmatter: normalizedFrontmatter(fresh, fresh.title) };
          if (fresh.title != null) body.title = fresh.title;
          await putPageIfMatch(p.path, body, fresh.updated_at);
          fixed++;
          log(`  已修复 ${p.path}`);
          break;
        } catch (e) {
          if (e instanceof ConflictError && round < PUT_ROUNDS - 1) { log(`  409，重取重写 (${round + 1}/${PUT_ROUNDS}): ${p.path}`); continue; }
          throw e;
        }
      }
    } catch (e) {
      failed++;
      log(`  修复失败 ${p.path}: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }
  log(`链接修复 pass 完成：改写 ${fixed} / 无需改动 ${untouched} / 失败 ${failed}`);
}

// ── I2：无条件全量备份（每次启动新文件，全字段，tmp+rename 原子写） ──
function backupAllPages(pages) {
  const file = newBackupPath();
  const lines = pages.map((p) =>
    JSON.stringify({ path: p.path, title: p.title, updated_at: p.updated_at, content: p.content, frontmatter: p.frontmatter }),
  ).join("\n") + "\n";
  atomicWrite(file, lines);
  log(`备份 ${pages.length} 页（path/title/updated_at/content/frontmatter 全字段）→ ${file}`);
  return file;
}

// ── 主流程 ──
async function main() {
  const started = Date.now();
  log(`启动: project=${PROJECT_ID} api=${ARGS.api} omlx=${ARGS.omlx} limit=${ARGS.limit === Infinity ? "∞" : ARGS.limit} progress.completed=${PROGRESS.completed.size}`);
  await apiLogin();
  log(`已登录 ${USERNAME}（token 缓存 ${AUTH_PATH}）`);
  await pickModel();
  log(`omlx 模型: ${OMLX_MODEL}`);

  const pages = await apiJson(await apiFetch(`/api/v1/projects/${PROJECT_ID}/pages`), "GET pages");
  log(`项目共 ${pages.length} 页`);

  // 目标集：非 transcripts/、非 reserved、未完成、非空、title 非 null（M2）
  // （过滤逻辑在 lib.selectTranslationTargets，注入 PROGRESS.completed）
  const { targets, nullTitle } = selectTranslationTargets(pages, { completed: PROGRESS.completed });
  log(`目标集 ${targets.length} 页（排除 transcripts/reserved/已完成/空内容${nullTitle.length ? `；M2: ${nullTitle.length} 页 title 为 null 跳过翻译` : ""}）`);
  if (nullTitle.length > 0) for (const p of nullTitle) log(`  M2 SKIP ${p.path}: title 为 null`);

  // I2：无条件全量快照备份（每次启动新文件）
  backupAllPages(pages);

  // Pass 1：全量标题映射（--limit 也全量建映射，保证干跑页的链接也能替换）
  await translateTitles(targets.map((p) => p.title));

  // I4：标题碰撞检测——碰撞组保持英文标题
  detectAndApplyTitleCollisions(pages);
  saveProgress(PROGRESS);

  // C1：链接解析上下文（备份/映射定型后构建；titleMap/collisions 注入 lib.buildLinkCtx）
  const ctx = buildLinkCtx(pages, PROGRESS.titleMap, PROGRESS.collisions);

  // C1：已完成页链接修复 pass（幂等，重跑无改动即跳过）
  await repairCompletedLinks(pages, ctx);

  // Pass 2：逐页串行（I1：If-Match 用 GET 时刻 updated_at；409 → 重新 GET + 重新翻译）
  const order = targets.slice().sort((a, b) => a.path.localeCompare(b.path));
  const queue = order.slice(0, ARGS.limit);
  let ok = 0, skipped = 0, failed = 0;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const progress = `[${i + 1}/${queue.length}]`;
    try {
      let done = false;
      for (let round = 0; round < PUT_ROUNDS && !done; round++) {
        // 每轮重新 GET：拿翻译基线内容 + If-Match（同一时刻）
        const fresh = await apiJson(await apiFetch(pageUrl(p.path)), `GET ${p.path}`);
        if (fresh.title == null) {
          skipped++; PROGRESS.completed.add(p.path);
          log(`${progress} SKIP ${p.path}: title 为 null`);
          break;
        }
        if (!(fresh.content ?? "").trim()) {
          skipped++; PROGRESS.completed.add(p.path);
          log(`${progress} SKIP ${p.path}: 空内容`);
          break;
        }
        if (isChinesePage(fresh.content)) {
          skipped++; PROGRESS.completed.add(p.path);
          log(`${progress} SKIP ${p.path}: 中文占比 ${Math.round(zhRatio(fresh.content) * 100)}%`);
          break;
        }
        const body = await composePageUpdate(fresh, ctx);
        try {
          await putPageIfMatch(p.path, body, fresh.updated_at);
          ok++; PROGRESS.completed.add(p.path); delete PROGRESS.failed[p.path];
          log(`${progress} OK   ${p.path} -> ${body.title} (中文 ${Math.round(zhRatio(body.content) * 100)}%)`);
          done = true;
        } catch (e) {
          if (e instanceof ConflictError && round < PUT_ROUNDS - 1) {
            log(`${progress} 409 冲突，重新 GET + 重新翻译 (${round + 1}/${PUT_ROUNDS}): ${p.path}`);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      failed++; PROGRESS.failed[p.path] = String(e.message ?? e).slice(0, 300);
      log(`${progress} FAIL ${p.path}: ${PROGRESS.failed[p.path]}`);
    }
    saveProgress(PROGRESS);
  }

  const mins = Math.round((Date.now() - started) / 60000);
  log(`完成: ok=${ok} skip=${skipped} fail=${failed} 用时 ${mins}min；进度 ${PROGRESS.completed.size} 完成 / 碰撞组 ${PROGRESS.collisions.length}`);
  if (failed > 0) { log(`失败清单见 ${PROGRESS_PATH} .failed`); process.exitCode = 1; }
}

main().catch((e) => { log(`FATAL: ${e?.stack ?? e}`); process.exit(1); });

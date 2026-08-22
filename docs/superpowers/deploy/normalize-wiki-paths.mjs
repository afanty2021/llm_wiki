#!/usr/bin/env node
// docs/superpowers/deploy/normalize-wiki-paths.mjs
//
// 23 个历史非 slug wiki 页收编工具（LT 师训 · project 614 · m3-impl-review W2 遗留项）。
// Node ≥ 20（原生 fetch），零外部依赖；不进 src-server 构建。与 translate-wiki-pages.mjs /
// restore-from-backup.mjs 同族（REST + If-Match + 原子写 + 仓外备份）。
//
// 用法：
//   node normalize-wiki-paths.mjs                    # dry-run（默认；零写入，只产备份+plan+报告数据）
//   node normalize-wiki-paths.mjs --apply            # 实执行（⚠️ 须等翻译 v2 结束后由控制器执行）
//        [--project 614] [--api http://127.0.0.1:8080] [--omlx http://127.0.0.1:8001]
//        [--bootstrap FILE] [--model NAME]
//
// 流程：
//  1. 枚举：REST 拉全部页，筛非 slug（^[a-z0-9/_\.\-]+$，排除 transcripts/ 与 reserved 三页）。
//  2. slug 计算：英文形态机械化（lib/normalize-core.mjs mechanicalSlugStem）；
//     中文/混合 stem → omlx LLM 起英文短语再 slug 化（507 fail-fast）；
//     SLUG_OVERRIDES 命中页（fix round 1 F2）直接以 curated 表值为目标、不调 LLM。
//  3. 逐页决策（lib computeDecisions）：五级孪生探测——命中 → merge（目标=孪生 slug 页，
//     正文长者胜、sources 并集、title 保留孪生现值；多胞胎迭代合并到同一目标）；
//     未命中 → rename（POST 新 slug 页沿用 frontmatter/title/content/sources + DELETE 旧页）。
//     rename 目标撞现存页/本轮已分配 → -2 后缀去重并告警。
//  4. 入链改写：全库扫描解析到旧 path 的 [[...]]，改写为 [[新slug|现标题]]（复用
//     translate-core 的 mask/unmask/buildLinkCtx；fence 不动、悬空不动、alias/锚点保留）；
//     新建/合并页正文同样过一遍改写。apply 时 PUT If-Match（409 → 重取重改 ≤3 轮）；
//     rename 的 POST 409 亦自愈（中断续跑 / 并发撞车 -2 改投，见 B 分支注释）。
//  5. 卫生：执行前全字段备份 ~/.llm-wiki-mcp/normalize-backup-<date>.jsonl（原子写，
//     条目形状与 translate v2 备份兼容——restore-from-backup.mjs --backup 可直接恢复）；
//     决策清单 ~/.llm-wiki-mcp/normalize-plan.json（dry-run 也产出，供评审）。
//  6. 图边数/悬空链接：执行前后各模拟一次（lib simulateGraphStats，graph.rs 解析语义近似）。
//
// 凭据：svc-transcriber 服务账号（admin 角色，DELETE 需要），bootstrap.env 同翻译脚本模式，
// 密码不落日志不落 commit。dry-run 不落 token 缓存。
//
// 禁改范围：transcripts/%（转写页）、wiki/index|log|overview.md（reserved，ingest 重建）、
// learning_plans/learning_items（本工具只碰 wiki_pages，经 API）。绝不与正在跑的翻译进程
// 并发 --apply（dry-run 只读 REST + 3 次 omlx 短语调用，无写入竞争）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSlugPath, needsLlmSlug, buildSlugInfo, computeDecisions, mergeSources,
  rewriteLinksToPlan, simulateGraphStats, composePostPlanPages, mechanicalSlugStem, hasCJK,
  slugOverrideFor, resolveSlugInfo,
} from "./lib/normalize-core.mjs";
import { RESERVED_PAGES, buildLinkCtx } from "./lib/translate-core.mjs";

// ── CLI ──
function parseArgs(argv) {
  const out = { apply: false, project: null, api: "http://127.0.0.1:8080", omlx: "http://127.0.0.1:8001", bootstrap: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
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
const USAGE = `用法: node normalize-wiki-paths.mjs [--apply] [--project 614] [--api URL] [--omlx URL] [--bootstrap FILE] [--model NAME]
  默认 dry-run（零写入：不 PUT/POST/DELETE、不落 token 缓存；产出备份 jsonl + normalize-plan.json + 决策汇总）`;

const ARGS = parseArgs(process.argv.slice(2));
const HERE = fileURLToPath(new URL(".", import.meta.url));

// 遗留债补齐（终审 round3 CLN-1）：六对历史链接兜底映射（translate 侧 a41de0ef 已挪
// JSON 注入，本脚本漏带第 4 参——normalize 场景六种中文目标链接会从可解析降级为悬空）。
// 文件缺失/畸形 → 空映射（与 translate 侧同口径，兜底链本就 best-effort）。
let LEGACY_LINK_RECOVERY = {};
try {
  const j = JSON.parse(readFileSync(join(HERE, "legacy-link-recovery.json"), "utf-8"));
  LEGACY_LINK_RECOVERY = { ...(j.pairs ?? {}) };
} catch { /* 见上 */ }
const REPO_ROOT = join(HERE, "..", "..", "..");
const BOOTSTRAP_PATH = ARGS.bootstrap ?? join(REPO_ROOT, "tools/transcriber/out/bootstrap.env");

const MCP_HOME = join(homedir(), ".llm-wiki-mcp");
const PLAN_PATH = join(MCP_HOME, "normalize-plan.json");
const AUTH_PATH = join(MCP_HOME, "normalize-auth.json"); // 独立于翻译脚本缓存，互不干扰

/** PUT If-Match 冲突重试环上限（409 → 重新 GET + 重改写） */
const PUT_ROUNDS = 3;
/** LLM 单次调用失败重试次数（不含首发） */
const LLM_RETRIES = 2;

function die(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
function stripThink(s) { return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); }
function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

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

// ── src-server API 客户端（login / 401 重登 / GET+PUT If-Match / POST / DELETE） ──
let accessToken = null;
async function apiLogin({ persist } = { persist: true }) {
  const res = await fetch(`${ARGS.api}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("login 响应缺 access_token");
  accessToken = j.access_token;
  if (persist) { // dry-run 零写入：不落 token 缓存
    try {
      mkdirSync(MCP_HOME, { recursive: true });
      atomicWrite(AUTH_PATH, JSON.stringify({ access_token: accessToken, saved_at: new Date().toISOString() }));
      chmodSync(AUTH_PATH, 0o600);
    } catch { /* 持久化失败不致命 */ }
  }
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
    await apiLogin({ persist: ARGS.apply });
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
const pageUrl = (path) => `/api/v1/projects/${PROJECT_ID}/page?path=${encodeURIComponent(path)}`;

class ConflictError extends Error {}
async function putPageIfMatch(path, body, ifMatch) {
  const put = await apiFetch(pageUrl(path), {
    method: "PUT",
    headers: { "if-match": ifMatch },
    body: JSON.stringify({ ...body, path }),
  });
  if (put.status === 409) throw new ConflictError(`PUT ${path}: If-Match 冲突（内容已被并发修改）`);
  return apiJson(put, `PUT ${path}`);
}
async function postPage(body) {
  const res = await apiFetch(`/api/v1/projects/${PROJECT_ID}/pages`, { method: "POST", body: JSON.stringify(body) });
  if (res.status === 409) throw new ConflictError(`POST ${body.path}: 目标 path 已存在`);
  return apiJson(res, `POST ${body.path}`);
}
async function deletePage(path, ifMatch) {
  const res = await apiFetch(pageUrl(path), { method: "DELETE", headers: ifMatch ? { "if-match": ifMatch } : {} });
  if (res.status === 404) { log(`  DELETE ${path}: 404（已不存在，视为成功）`); return {}; }
  if (!res.ok) throw new Error(`DELETE ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {};
}

// ── omlx LLM 客户端（中文标题 → 英文短语；同翻译脚本模式） ──
const MODEL_PREFERENCE = [
  "Qwen3.6-35B-A3B-4bit",
  "Qwen3.8-27B-4bit",
  "Qwen3.6-27B-4bit",
];
let OMLX_MODEL = ARGS.model;
class FatalLlmError extends Error {}
async function pickModel() {
  if (OMLX_MODEL) return OMLX_MODEL;
  const res = await fetch(`${ARGS.omlx}/v1/models`);
  if (!res.ok) throw new Error(`GET /v1/models HTTP ${res.status}`);
  const j = await res.json();
  const ids = (j.data ?? []).map((m) => m.id).filter(Boolean);
  OMLX_MODEL = MODEL_PREFERENCE.find((p) => ids.includes(p)) ?? ids.find((id) => /qwen/i.test(id)) ?? ids[0];
  if (!OMLX_MODEL) throw new Error("/v1/models 返回空");
  return OMLX_MODEL;
}
async function llmOnce(messages, { temperature = 0.1, maxTokens = 256, enableThinking = false } = {}) {
  const model = await pickModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(`${ARGS.omlx}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      signal: controller.signal,
      // enable_thinking:false 关 Qwen3 思考模式——本 serving 否则会以纯文本吐
      // "Here's a thinking process:" 前导（非 <think> 标签，stripThink 救不了）
      body: JSON.stringify({
        model, messages, temperature, max_tokens: maxTokens, stream: false,
        ...(enableThinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      }),
    });
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
  } finally {
    clearTimeout(timer);
  }
}
/** 清洗短语：首行、去包裹引号/装饰符、去尾标点、折叠空白。 */
function cleanPhrase(raw) {
  const line = String(raw ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line
    .replace(/^["'“”‘’·`\-–—\s]+|["'“”‘’·`\-–—\s]+$/g, "")
    .replace(/[.。!！?？,，;；:：`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const isValidPhrase = (p) => p !== "" && !hasCJK(p) && mechanicalSlugStem(p) !== "";
/**
 * 中文标题 → 3-6 个英文单词的短语（slug 化前驱）。
 * 两式：① 关思考直出短语；② PHRASE 行契约（思考仍会漏的 serving 兜底，取最后一个
 * PHRASE 匹配）。均无效 → 抛错（该页标记 needs-review，绝不落垃圾 slug）。
 */
async function llmSlugPhrase(title, stem) {
  const sys1 = "你在为英文知识库的文件起名。给下面的中文标题起一个 3-6 个英文单词的英文短语，作为英文文件名的基础。专有名词与教材名保留原文（如 PEP、New Concept English、IELTS、TBLT）。只输出英文短语本身：不要解释、不要标点、不要引号、不要换行。";
  const sys2 = "你在为英文知识库的文件起名。给中文标题起一个 3-6 个英文单词的英文短语作为文件名基础。专有名词与教材名保留原文（如 PEP、New Concept English、IELTS、TBLT）。思考后最后单独一行输出结论，格式严格为：PHRASE: <英文短语>。";
  const user = `中文标题：${title ?? "(无)"}\n原文件名：${stem}`;
  let lastErr = null;
  for (const { sys, maxTokens, phraseLine } of [
    { sys: sys1, maxTokens: 256, phraseLine: false },
    { sys: sys2, maxTokens: 1024, phraseLine: true },
  ]) {
    let raw = null;
    for (let r = 0; r <= LLM_RETRIES; r++) {
      try { raw = await llmOnce([{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens }); break; }
      catch (e) {
        if (e instanceof FatalLlmError) throw e;
        lastErr = e;
        if (r < LLM_RETRIES) await sleep(r === 0 ? 3000 : 10000);
      }
    }
    if (raw == null) continue;
    let picked = raw;
    if (phraseLine) {
      const ms = [...raw.matchAll(/PHRASE[:：]\s*(.+)/gi)].map((m) => m[1]);
      if (ms.length > 0) picked = ms[ms.length - 1]; // 思考行会复述格式——取最后一个 PHRASE 匹配
    }
    const phrase = cleanPhrase(picked);
    if (isValidPhrase(phrase)) return phrase;
    log(`  LLM 短语无效: ${JSON.stringify(phrase.slice(0, 80))}`);
  }
  throw lastErr ?? new Error(`LLM 未能为 "${title ?? stem}" 产出有效英文短语`);
}

// ── 备份（全字段，原子写；形状兼容 restore-from-backup.mjs v2） ──
function newBackupPath() {
  const base = `normalize-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  let p = join(MCP_HOME, `${base}.jsonl`);
  let n = 2;
  while (existsSync(p)) p = join(MCP_HOME, `${base}-${n++}.jsonl`);
  return p;
}
function backupAllPages(pages) {
  const file = newBackupPath();
  const lines = pages.map((p) =>
    JSON.stringify({ path: p.path, title: p.title, updated_at: p.updated_at, content: p.content, frontmatter: p.frontmatter }),
  ).join("\n") + "\n";
  atomicWrite(file, lines);
  log(`备份 ${pages.length} 页（path/title/updated_at/content/frontmatter 全字段）→ ${file}`);
  return file;
}

/** M3：PUT/POST frontmatter 以读取到的为准——保留原键，回填缺失的 type/sources/images。 */
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

// ── 主流程 ──
async function main() {
  const mode = ARGS.apply ? "APPLY（写入）" : "DRY-RUN（零写入）";
  log(`启动: project=${PROJECT_ID} api=${ARGS.api} omlx=${ARGS.omlx} mode=${mode}`);
  await apiLogin({ persist: ARGS.apply });
  log(`已登录 ${USERNAME}${ARGS.apply ? "" : "（dry-run：不落 token 缓存）"}`);

  // 1. 枚举
  const pages = await apiJson(await apiFetch(`/api/v1/projects/${PROJECT_ID}/pages`), "GET pages");
  log(`项目共 ${pages.length} 页`);

  // 5a. 执行前全字段备份（dry-run 也产——apply 重跑时会再备新快照）
  const backupFile = backupAllPages(pages);

  // 2. slug 计算（curated SLUG_OVERRIDES 优先钉死、不调 LLM；中文 stem → omlx 短语）
  const nonSlug = pages.filter((p) =>
    !p.path.startsWith("transcripts/") && !RESERVED_PAGES.has(p.path) && !isSlugPath(p.path));
  log(`非 slug 收编目标 ${nonSlug.length} 页（排除 transcripts/ 与 reserved 三页）`);
  const slugInfoByPath = new Map();
  const llmPages = nonSlug.filter((p) => needsLlmSlug(p) && slugOverrideFor(p) == null);
  if (llmPages.length > 0) {
    await pickModel();
    log(`omlx 模型: ${OMLX_MODEL}；中文/混合标题 ${llmPages.length} 页走 LLM 短语`);
  }
  for (const p of nonSlug) {
    const ov = slugOverrideFor(p);
    if (ov != null) {
      slugInfoByPath.set(p.path, resolveSlugInfo(p));
      log(`  SLUG override: ${p.path} → ${ov}（curated 钉死，不调 LLM）`);
      continue;
    }
    let phrase = null;
    if (needsLlmSlug(p)) {
      phrase = await llmSlugPhrase(p.title, p.path.split("/").pop().replace(/\.md$/, ""));
      log(`  LLM slug: ${p.path} → "${phrase}"`);
    }
    slugInfoByPath.set(p.path, buildSlugInfo(p, phrase));
  }

  // 3. 决策表（五级孪生探测 + 撞车去重 + 多胞胎分组）
  const { decisions, groups, warnings } = computeDecisions(pages, slugInfoByPath, { log });
  for (const d of decisions) {
    log(`  ${d.decision.toUpperCase().padEnd(12)} ${d.path} → ${d.target ?? "(无)"} [${d.basis ?? d.slugSource}] (${d.contentLen} 字) ${d.reason ?? ""}`);
  }
  for (const w of warnings) log(`  警告: ${w}`);

  // 4. 入链改写预演（当前快照上计算；apply 时逐页重取重算）
  const sortedPages = pages.slice().sort((a, b) => a.path.localeCompare(b.path));
  const ctx = buildLinkCtx(sortedPages, {}, [], LEGACY_LINK_RECOVERY);
  const activeDecisions = decisions.filter((d) => d.decision === "merge" || d.decision === "rename");
  const finalPath = new Map(); // 旧 path → 存活 path
  const finalTitle = new Map(); // 存活 path → 现标题
  for (const d of activeDecisions) {
    finalPath.set(d.path, d.target);
    if (d.decision === "rename") finalTitle.set(d.target, d.title ?? null);
  }
  for (const [target, g] of groups) finalTitle.set(target, g.title ?? null);
  const rewrite = (pageLike) => rewriteLinksToPlan(pageLike.content ?? "", ctx, finalPath, finalTitle).content;

  const oldPaths = new Set(activeDecisions.map((d) => d.path));
  const rewritePlan = [];
  for (const p of sortedPages) {
    if (oldPaths.has(p.path) || RESERVED_PAGES.has(p.path) || p.path.startsWith("transcripts/")) continue; // reserved 由 ingest 重建；transcripts 无 wikilink 且 CLI 直写
    const { content, changes } = rewriteLinksToPlan(p.content ?? "", ctx, finalPath, finalTitle);
    if (content !== (p.content ?? "")) {
      rewritePlan.push({ path: p.path, occurrences: changes.length, changes: changes.slice(0, 10) });
    }
  }
  const rewriteOccurrences = rewritePlan.reduce((s, r) => s + r.occurrences, 0);
  log(`入链改写: ${rewritePlan.length} 页 × ${rewriteOccurrences} 处（指向旧 path 的 [[...]] → [[新slug|现标题]]）`);
  for (const r of rewritePlan) log(`  改写 ${r.path}: ${r.occurrences} 处${r.changes.length ? `（如 ${r.changes[0].from} → ${r.changes[0].to}）` : ""}`);

  // 6. 图边数/悬空链接：执行前后（needs-review 页不在模拟内——apply 前必须清零）
  const before = simulateGraphStats(pages);
  const after = simulateGraphStats(composePostPlanPages(pages, activeDecisions, groups, rewrite));
  log(`图模拟: 节点 ${before.nodes}→${after.nodes}；边 ${before.edges}→${after.edges}；悬空链接 ${before.danglingLinks}→${after.danglingLinks}`);

  // 5b. 决策清单落盘（dry-run 也产出，供评审）
  const plan = {
    generated_at: new Date().toISOString(),
    mode: ARGS.apply ? "apply" : "dry-run",
    project_id: PROJECT_ID,
    api: ARGS.api,
    backup_file: backupFile,
    counts: {
      nonSlug: nonSlug.length,
      rename: decisions.filter((d) => d.decision === "rename").length,
      merge: decisions.filter((d) => d.decision === "merge").length,
      needsReview: decisions.filter((d) => d.decision === "needs-review").length,
      llmSlug: llmPages.length,
      multiBirthGroups: [...groups.values()].filter((g) => g.members.length > 2).length,
      rewritePages: rewritePlan.length,
      rewriteOccurrences,
    },
    decisions: decisions.map(({ path, title, contentLen, decision, target, basis, slugSource, phrase, reason }) =>
      ({ path, title, contentLen, decision, target, basis, slugSource, phrase, reason })),
    mergeGroups: [...groups.values()].map((g) => ({
      target: g.target, title: g.title, winner: g.winnerPath,
      members: g.members.map((m) => m.path),
      dropped: g.dropped,
      sources: g.sources,
    })),
    rewrites: rewritePlan,
    warnings,
    graph: { before, after },
  };
  mkdirSync(MCP_HOME, { recursive: true });
  atomicWrite(PLAN_PATH, JSON.stringify(plan, null, 2));
  log(`决策清单 → ${PLAN_PATH}`);

  const c = plan.counts;
  log(`汇总: ${c.nonSlug} 页 = rename ${c.rename} / merge ${c.merge}${c.needsReview ? ` / needs-review ${c.needsReview}` : ""}；LLM slug ${c.llmSlug} 页；多胞胎组 ${c.multiBirthGroups}；入链改写 ${c.rewritePages} 页 × ${c.rewriteOccurrences} 处`);

  if (ARGS.apply) {
    if (c.needsReview > 0) die(`存在 ${c.needsReview} 页 needs-review，先解决再 --apply`);
    await applyAll(pages, decisions, groups, ctx, finalPath, finalTitle);
  } else {
    log("dry-run 结束（零写入）。apply 步骤见 task 报告「控制器 apply」节。");
  }
}

// ── apply（本任务不执行；控制器在翻译 v2 结束后运行 --apply） ──
// 失败语义：逐组/逐页 try-catch——单页失败不阻塞其余（重跑自愈：已 rename/merge 的页
// 自动退出枚举，plan/备份支撑 restore-from-backup.mjs 兜底回滚）。
async function applyAll(snapshotPages, decisions, groups, ctx, finalPath, finalTitle) {
  const byPath = new Map(snapshotPages.map((p) => [p.path, p]));
  const rewrite = (pageLike) => rewriteLinksToPlan(pageLike.content ?? "", ctx, finalPath, finalTitle).content;
  let applyFailed = 0;

  // A. merge：逐目标 GET（target+members 同轮快照）→ 组装合并 body → PUT If-Match → DELETE 成员
  for (const g of groups.values()) {
    try {
      let done = false;
      for (let round = 0; round < PUT_ROUNDS && !done; round++) {
        const targetFresh = await apiJson(await apiFetch(pageUrl(g.target)), `GET ${g.target}`);
        const memberFresh = [];
        for (const m of g.members) {
          if (m.path === g.target) continue;
          try { memberFresh.push(await apiJson(await apiFetch(pageUrl(m.path)), `GET ${m.path}`)); }
          catch (e) { log(`  成员已不存在，跳过: ${m.path}（${String(e.message ?? e).slice(0, 120)}）`); }
        }
        const pool = [targetFresh, ...memberFresh].filter((p) => p != null);
        // 重取后按现值重算 winner（同 computeDecisions 语义：长度desc、path序 tie-break）
        pool.sort((a, b) => (b.content ?? "").length - (a.content ?? "").length || a.path.localeCompare(b.path));
        const winner = pool[0];
        const title = targetFresh.title ?? pool.find((p) => p.title != null)?.title ?? null;
        const sources = mergeSources(...pool.map((p) => (Array.isArray(p.sources) ? p.sources : [])));
        const body = {
          title,
          content: rewrite(winner),
          frontmatter: { ...normalizedFrontmatter(targetFresh, title), sources },
        };
        try {
          await putPageIfMatch(g.target, body, targetFresh.updated_at);
          log(`  MERGE OK ${g.target}（正文取 ${winner.path}，sources 并集 ${sources.length} 项）`);
          done = true;
        } catch (e) {
          if (e instanceof ConflictError && round < PUT_ROUNDS - 1) { log(`  409，重取重并 (${round + 1}/${PUT_ROUNDS}): ${g.target}`); continue; }
          throw e;
        }
      }
      for (const m of g.members) {
        if (m.path === g.target) continue;
        let ifMatch;
        try { ifMatch = (await apiJson(await apiFetch(pageUrl(m.path)), `GET ${m.path}`)).updated_at; } catch { ifMatch = null; }
        await deletePage(m.path, ifMatch);
        log(`  DELETE ${m.path}`);
      }
    } catch (e) {
      applyFailed++;
      log(`  MERGE FAIL ${g.target}: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }

  // B. rename：GET 旧页 → POST 新 slug 页 → DELETE 旧页
  //    409 自愈（遗留债 M4 前置）：POST 撞目标分两型——①上次运行 POST 成功后中断
  //    （目标已是我们将写的确定性内容——rewrite 为纯机械函数）→ GET 比对一致即
  //    视为续跑，补 DELETE 旧页收尾；②目标在快照后被并发建成异质页 → -2 后缀改投
  //    （与决策期撞车去重同法）并回写 d.target，保证后续入链改写（C pass）指向实际
  //    落地路径。两型都不再让整个 rename 永久 FAIL。
  for (const d of decisions.filter((x) => x.decision === "rename")) {
    try {
      const src = byPath.get(d.path);
      if (!src) { log(`  RENAME SKIP ${d.path}: 快照后已不存在`); continue; }
      let fresh;
      try { fresh = await apiJson(await apiFetch(pageUrl(d.path)), `GET ${d.path}`); }
      catch (e) { log(`  RENAME SKIP ${d.path}: ${String(e.message ?? e).slice(0, 120)}`); continue; }
      let target = d.target;
      const body = {
        title: fresh.title ?? undefined,
        content: rewrite(fresh),
        frontmatter: normalizedFrontmatter(fresh, fresh.title),
      };
      try {
        await postPage({ path: target, ...body });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        let existing;
        try { existing = await apiJson(await apiFetch(pageUrl(target)), `GET ${target}`); }
        catch { throw e; } // 409 但目标已不可读（并发消失）→ 还原走 FAIL
        if (existing.content === body.content && (existing.title ?? null) === (body.title ?? null)) {
          log(`  RENAME RESUME ${d.path} → ${target}: 目标已存在且内容一致（上次中断续跑），补删旧页`);
        } else {
          target = target.replace(/\.md$/, "") + "-2.md";
          log(`  RENAME RETARGET ${d.path} → ${target}: 目标被并发占用（异质内容），-2 改投`);
          await postPage({ path: target, ...body });
        }
      }
      log(`  RENAME OK ${d.path} → ${target}`);
      await deletePage(d.path, fresh.updated_at);
      log(`  DELETE ${d.path}`);
      // CLN-2（终审 round4）：-2 改投时同步预建映射——C pass 的 rewrite 读的是
      // finalPath/finalTitle（main 预建），只回写 d.target 无人消费，原 target
      // 已被并发异质页占用，不改映射则全库入链仍指向占用者。RESUME 分支目标
      // 未变（内容一致续跑），无需处理。
      if (finalPath.get(d.path) !== target) {
        const plannedTarget = d.target; // 改写前留存（title 键挂在原计划目标上）
        finalPath.set(d.path, target);
        finalTitle.set(target, finalTitle.get(plannedTarget) ?? d.title ?? null);
        finalTitle.delete(plannedTarget);
      }
      d.target = target; // C pass（入链改写）按实际落地目标
    } catch (e) {
      applyFailed++;
      log(`  RENAME FAIL ${d.path} → ${d.target}: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }

  // C. 入链改写 pass：存活页逐页 GET → 改写 → PUT If-Match（409 → 重取重改 ≤PUT_ROUNDS）
  const oldPaths = new Set(decisions.filter((d) => d.decision === "merge" || d.decision === "rename").map((d) => d.path));
  const candidates = snapshotPages
    .filter((p) => !oldPaths.has(p.path) && !RESERVED_PAGES.has(p.path) && !p.path.startsWith("transcripts/"))
    .sort((a, b) => a.path.localeCompare(b.path));
  let fixed = 0, untouched = 0, failed = 0;
  for (const p of candidates) {
    try {
      let done = false;
      for (let round = 0; round < PUT_ROUNDS && !done; round++) {
        const freshPage = await apiJson(await apiFetch(pageUrl(p.path)), `GET ${p.path}`);
        const content = freshPage.content ?? "";
        if (!content.trim()) { untouched++; break; }
        const newContent = rewriteLinksToPlan(content, ctx, finalPath, finalTitle).content;
        if (newContent === content) { untouched++; break; }
        const body = { content: newContent, frontmatter: normalizedFrontmatter(freshPage, freshPage.title) };
        if (freshPage.title != null) body.title = freshPage.title;
        try {
          await putPageIfMatch(p.path, body, freshPage.updated_at);
          fixed++; done = true;
          log(`  改写 OK ${p.path}`);
        } catch (e) {
          if (e instanceof ConflictError && round < PUT_ROUNDS - 1) { log(`  409，重取重改 (${round + 1}/${PUT_ROUNDS}): ${p.path}`); continue; }
          throw e;
        }
      }
    } catch (e) {
      failed++;
      log(`  改写 FAIL ${p.path}: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }
  log(`apply 完成: merge 组 ${groups.size} / rename ${decisions.filter((d) => d.decision === "rename").length}；入链改写 ${fixed} 页（无需 ${untouched} / 失败 ${failed}）${applyFailed ? `；merge/rename 失败 ${applyFailed}（重跑自愈）` : ""}`);
  if (failed > 0 || applyFailed > 0) process.exitCode = 1;
}

main().catch((e) => { log(`FATAL: ${e?.stack ?? e}`); process.exit(1); });

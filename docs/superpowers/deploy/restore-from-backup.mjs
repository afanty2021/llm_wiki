#!/usr/bin/env node
// docs/superpowers/deploy/restore-from-backup.mjs
//
// wiki 翻译备份恢复工具（m3-impl-review W1）。Node ≥ 20（原生 fetch），零外部依赖。
//
// 读 translate-wiki-pages.mjs 的备份 jsonl（自动识别条目格式）：
//   v1 首发（translate-backup-YYYYMMDD.jsonl，599 条）：仅 path/title/updated_at/content
//     ——缺 frontmatter/sources/images，且不含 transcripts/reserved 页；
//   v2 系列（同日 -N 递增后缀，全字段 650 条）：path/title/updated_at/content/frontmatter。
// 识别规则：条目含 frontmatter 键 → v2 全量整体恢复；否则 → v1 部分恢复
//   （GET 现页取 frontmatter 仅回填 title/content，type/sources/images 等保留现值）。
//
// 恢复走 src-server REST（与翻译脚本同一链路：svc-transcriber 登录 + GET + PUT If-Match
// 乐观锁，409 → 重 GET 重试 ≤3 轮；PUT 触发 re-embed，检索同步干净）。
// 凭据与工具函数复制 translate-wiki-pages.mjs 的模式（该脚本不可 import——模块加载即跑
// main）。备份文件与 translate-progress.json 一律只读，绝不写入。
//
// 用法：
//   node restore-from-backup.mjs --backup ~/.llm-wiki-mcp/translate-backup-20260821.jsonl --all --dry-run
//   node restore-from-backup.mjs --backup <file> --pages concepts/a.md,entities/b.md
//   node restore-from-backup.mjs --backup <file> --all
//        [--project 614] [--api http://127.0.0.1:8080] [--bootstrap FILE]
//   （--backup 缺省取 ~/.llm-wiki-mcp/ 下最新的 translate-backup-*.jsonl）
//
// --dry-run：逐条校验可恢复性（目标页存在 / updated_at 可取 / 字段完备），输出汇总，
// 零写入（只 GET，含不落 token 缓存）。

import { readFileSync, readdirSync, existsSync, mkdirSync, chmodSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── CLI ──
function parseArgs(argv) {
  const out = { backup: null, pages: null, all: false, dryRun: false, project: null, api: "http://127.0.0.1:8080", bootstrap: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backup") out.backup = argv[++i];
    else if (a === "--pages") out.pages = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--project") out.project = Number(argv[++i]);
    else if (a === "--api") out.api = argv[++i];
    else if (a === "--bootstrap") out.bootstrap = argv[++i];
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else { console.error(`未知参数: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}
const USAGE = `用法: node restore-from-backup.mjs --backup <file> (--all | --pages p1,p2) [--dry-run] [--project 614] [--api URL] [--bootstrap FILE]`;

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.all && ARGS.pages) die("--all 与 --pages 互斥");
if (!ARGS.all && !ARGS.pages) die(`必须指定恢复范围：${USAGE}`);
if (ARGS.pages != null && ARGS.pages.trim() === "") die("--pages 为空");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const BOOTSTRAP_PATH = ARGS.bootstrap ?? join(REPO_ROOT, "tools/transcriber/out/bootstrap.env");

const MCP_HOME = join(homedir(), ".llm-wiki-mcp");
const AUTH_PATH = join(MCP_HOME, "translate-auth.json"); // 与翻译脚本共用 token 缓存（仅非 dry-run 落盘）
/** PUT If-Match 冲突重试环上限（409 → 重新 GET + 重建 body） */
const PUT_ROUNDS = 3;

function die(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── bootstrap.env（凭据只进内存，绝不打印；同翻译脚本模式） ──
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

// ── 备份装载（只读；缺省取 MCP_HOME 最新 translate-backup-*.jsonl） ──
function newestBackup() {
  try {
    const files = readdirSync(MCP_HOME)
      .filter((f) => /^translate-backup-\d{8}(-\d+)?\.jsonl$/.test(f))
      .sort(); // 字典序：-N 后缀天然递增，-9 < -10 有边界但同日内 ≤ 数十个，且精确兜底见下
    if (files.length === 0) return null;
    // 精确取「同 basename 数字最大」：按 (date, n) 二元组重排
    const keyed = files.map((f) => {
      const m = /^translate-backup-(\d{8})(?:-(\d+))?\.jsonl$/.exec(f);
      return { f, date: m[1], n: Number(m[2] ?? 1) };
    }).sort((a, b) => a.date - b.date || a.n - b.n);
    return join(MCP_HOME, keyed[keyed.length - 1].f);
  } catch { return null; }
}
const BACKUP_PATH = ARGS.backup ?? newestBackup();
if (!BACKUP_PATH || !existsSync(BACKUP_PATH)) die(`备份文件不存在: ${ARGS.backup ?? "(自动探测无 translate-backup-*.jsonl)"}`);

/** 装载 jsonl → 条目数组；逐条自动识别格式：含 frontmatter 键 = v2 全量，否则 v1 部分。 */
function loadBackup(file) {
  const entries = [];
  const seen = new Map();
  let line = 0;
  for (const l of readFileSync(file, "utf-8").split(/\r?\n/)) {
    line++;
    if (!l.trim()) continue;
    let e;
    try { e = JSON.parse(l); } catch (err) { die(`备份第 ${line} 行 JSON 解析失败: ${err.message}`); }
    if (typeof e?.path !== "string" || e.path === "") die(`备份第 ${line} 行缺 path`);
    if (seen.has(e.path)) log(`  警告: 备份内 path 重复（后者生效）: ${e.path}`);
    seen.set(e.path, line);
    e.__fullRestore = Object.prototype.hasOwnProperty.call(e, "frontmatter"); // v2 全字段标志
    entries.push(e);
  }
  return entries;
}
const BACKUP = loadBackup(BACKUP_PATH);
const v2Count = BACKUP.filter((e) => e.__fullRestore).length;
log(`备份: ${BACKUP_PATH}（${BACKUP.length} 条目：v1 部分恢复 ${BACKUP.length - v2Count} / v2 全量恢复 ${v2Count}）`);

// ── 待恢复条目选择 ──
let SELECTED = BACKUP;
if (ARGS.pages) {
  const want = ARGS.pages.split(",").map((s) => s.trim()).filter(Boolean);
  const missing = want.filter((p) => !BACKUP.some((e) => e.path === p));
  if (missing.length > 0) die(`--pages 中 ${missing.length} 个 path 不在备份内: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`);
  SELECTED = BACKUP.filter((e) => want.includes(e.path));
}

// ── src-server API 客户端（login / 401 重登 / GET+PUT If-Match，同翻译脚本链路） ──
let accessToken = null;
function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
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
    await apiLogin({ persist: !ARGS.dryRun });
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

/** PUT 409（If-Match 过期 / 页不存在）——调用方应重新 GET 重做。 */
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

// ── 可恢复性校验（dry-run 与恢复前置共用；current 来自 GET /pages 单次快照） ──
function validateEntry(e, current) {
  const issues = [];
  if (!current) issues.push("目标页不存在");
  else {
    if (typeof current.updated_at !== "string" || Number.isNaN(Date.parse(current.updated_at))) issues.push("现页 updated_at 不可取（If-Match 无基线）");
    if (e.content == null || typeof e.content !== "string") issues.push("备份 content 缺失/非字符串");
    if (e.title != null && typeof e.title !== "string") issues.push("备份 title 非字符串");
    if (e.__fullRestore && e.frontmatter != null && (typeof e.frontmatter !== "object" || Array.isArray(e.frontmatter))) issues.push("备份 frontmatter 非对象");
  }
  return issues;
}

/** v1 部分恢复 body：frontmatter 取现页（title 换备份值，type/sources/images 回填现列值）。 */
function partialRestoreBody(e, fresh) {
  const fm = (fresh.frontmatter && typeof fresh.frontmatter === "object" && !Array.isArray(fresh.frontmatter))
    ? { ...fresh.frontmatter }
    : {};
  if (e.title != null) fm.title = e.title;
  if (fm.type === undefined) fm.type = fresh.page_type ?? "concept";
  if (fm.sources === undefined) fm.sources = fresh.sources ?? [];
  if (fm.images === undefined) fm.images = fresh.images ?? [];
  return { title: e.title, content: e.content, frontmatter: fm };
}
/** v2 全量恢复 body：content/frontmatter/title 全按备份整体回写。 */
function fullRestoreBody(e) {
  return { title: e.title, content: e.content, frontmatter: e.frontmatter };
}

/** 幂等预检：现值已与备份一致 → 无需 PUT（信息项，不算失败）。 */
function alreadyRestored(e, fresh) {
  if ((fresh.content ?? null) !== (e.content ?? null)) return false;
  if ((fresh.title ?? null) !== (e.title ?? null)) return false;
  if (e.__fullRestore && JSON.stringify(fresh.frontmatter ?? null) !== JSON.stringify(e.frontmatter ?? null)) return false;
  return true;
}

// ── dry-run：逐条校验 + 汇总，零写入 ──
async function dryRun() {
  await apiLogin({ persist: false });
  log(`已登录 ${USERNAME}（dry-run：不落 token 缓存）`);
  const pages = await apiJson(await apiFetch(`/api/v1/projects/${PROJECT_ID}/pages`), "GET pages");
  const byPath = new Map(pages.map((p) => [p.path, p]));
  log(`项目现页 ${pages.length}；逐条校验 ${SELECTED.length} 个备份条目`);

  const c = { ok: 0, notFound: 0, noUpdatedAt: 0, badFields: 0, identical: 0, changedSinceBackup: 0 };
  const samples = [];
  for (const e of SELECTED) {
    const current = byPath.get(e.path);
    const issues = validateEntry(e, current);
    if (issues.length > 0) {
      for (const it of issues) {
        if (it === "目标页不存在") c.notFound++;
        else if (it.startsWith("现页 updated_at")) c.noUpdatedAt++;
        else c.badFields++;
      }
      if (samples.length < 10) samples.push(`  ✖ ${e.path}: ${issues.join("；")}`);
      continue;
    }
    c.ok++;
    if (alreadyRestored(e, current)) c.identical++;
    // 现页 updated_at 晚于备份时刻 → 恢复会回退其后的改动（通常是本批翻译）
    if (Date.parse(current.updated_at) > Date.parse(e.updated_at ?? 0)) c.changedSinceBackup++;
  }

  log(`[dry-run] 校验汇总（零写入）:`);
  log(`  可恢复        ${c.ok}/${SELECTED.length}`);
  log(`  不可恢复      ${SELECTED.length - c.ok}（目标页不存在 ${c.notFound} / updated_at 不可取 ${c.noUpdatedAt} / 字段不完备 ${c.badFields}）`);
  log(`  信息: 内容+标题已与备份一致 ${c.identical}（PUT 幂等 no-op）；现页晚于备份时刻 ${c.changedSinceBackup}（恢复将回退其后的改动）`);
  for (const s of samples) log(s);
  if (c.ok !== SELECTED.length) { log(`[dry-run] 存在不可恢复条目，恢复将被跳过或失败`); process.exitCode = 1; }
}

// ── 实恢复：逐条 GET + PUT If-Match（409 → 重 GET 重建 ≤ PUT_ROUNDS 轮） ──
async function restore() {
  await apiLogin({ persist: true });
  log(`已登录 ${USERNAME}；开始恢复 ${SELECTED.length} 条（写入通道 PUT If-Match，re-embed 同翻译链路）`);
  let ok = 0, skipped = 0, failed = 0, conflictRetried = 0;
  const failures = [];
  for (let i = 0; i < SELECTED.length; i++) {
    const e = SELECTED[i];
    const progress = `[${i + 1}/${SELECTED.length}]`;
    try {
      let done = false;
      for (let round = 0; round < PUT_ROUNDS && !done; round++) {
        const fresh = await apiJson(await apiFetch(pageUrl(e.path)), `GET ${e.path}`); // If-Match 与 body 同一时刻基线
        const issues = validateEntry(e, fresh);
        if (issues.length > 0) throw new Error(issues.join("；"));
        if (alreadyRestored(e, fresh)) {
          skipped++; done = true;
          log(`${progress} SKIP ${e.path}: 现值已与备份一致`);
          break;
        }
        const body = e.__fullRestore ? fullRestoreBody(e) : partialRestoreBody(e, fresh);
        try {
          await putPageIfMatch(e.path, body, fresh.updated_at);
          ok++; done = true;
          log(`${progress} OK   ${e.path} <- 备份（${e.__fullRestore ? "v2 全量" : "v1 部分: title/content"}）`);
        } catch (err) {
          if (err instanceof ConflictError && round < PUT_ROUNDS - 1) {
            conflictRetried++;
            log(`${progress} 409，重取重建 (${round + 1}/${PUT_ROUNDS}): ${e.path}`);
            await sleep(500);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      failed++; failures.push(`${e.path}: ${String(err.message ?? err).slice(0, 200)}`);
      log(`${progress} FAIL ${e.path}: ${failures[failures.length - 1]}`);
    }
  }
  log(`恢复完成: ok=${ok} skip=${skipped} fail=${failed}${conflictRetried ? `（409 重试 ${conflictRetried} 次）` : ""}`);
  if (failed > 0) {
    for (const f of failures.slice(0, 20)) log(`  FAIL ${f}`);
    process.exitCode = 1;
  }
}

(async () => {
  log(`启动: project=${PROJECT_ID} api=${ARGS.api} backup=${BACKUP_PATH} 范围=${ARGS.all ? "--all" : `${SELECTED.length} 页`} dry-run=${ARGS.dryRun}`);
  if (ARGS.dryRun) await dryRun();
  else await restore();
})().catch((e) => { log(`FATAL: ${e?.stack ?? e}`); process.exit(1); });

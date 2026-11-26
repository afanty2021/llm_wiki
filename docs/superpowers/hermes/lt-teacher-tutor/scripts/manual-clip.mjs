// 手工入库：正文由教师粘贴提供（微信验证码墙挡住 clip 抓取时），其余走与
// orchestrateClip 完全一致的管线（normalize→判重→writeSource→upsertPage→embed→ingest）。
// 用法：node manual-clip.mjs '<标题>' '<原文URL>' <正文文件.md> [projectId]
// 环境变量：TRAINING__ADMIN_TOKEN（必填）、LLM_WIKI_API_BASE_URL（缺省 http://127.0.0.1:8080）
// actor 固定 HuangZhengBo（管理员本人收藏口径）。
import { readFileSync } from "node:fs";
import {
  normalizeUrl,
  clipFileName,
  sanitizeClipTitle,
  buildSourceMarkdown,
  clipFrontmatter,
} from "/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/dist/src/web-clip.js";
import { LlmWikiApiClient } from "/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/dist/src/api-client.js";

const TITLE = process.argv[2];
const URL = process.argv[3];
const BODY_FILE = process.argv[4];
const PROJECT_ID = process.argv[5] ?? "614";
const ACTOR = "HuangZhengBo";
const BASE = process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:8080";
const TOKEN = (process.env.TRAINING__ADMIN_TOKEN ?? "").trim();
if (!TITLE || !URL || !BODY_FILE) {
  console.error("usage: node manual-clip.mjs '<title>' '<url>' <body.md> [projectId]");
  process.exit(2);
}
if (!TOKEN) { console.error("TRAINING__ADMIN_TOKEN not set"); process.exit(2); }

const title = sanitizeClipTitle(TITLE);
if (!title) throw new Error("title sanitized to empty");
const normalized = normalizeUrl(URL);
const fileName = clipFileName(title, normalized);
const sourcePath = `sources/clips/${fileName}`;
const pagePath = `clips/${fileName}`;

const body = readFileSync(BODY_FILE, "utf8").replace(/\n+$/, "\n");
const adminClient = new LlmWikiApiClient({ baseUrl: BASE, token: TOKEN });
const auth = await adminClient.trainingBind(ACTOR, TOKEN); // 幂等：轮换 refresh，拿 access token
const client = new LlmWikiApiClient({ baseUrl: BASE, token: auth.access_token });

const existing = await client.getPage(pagePath, PROJECT_ID);
const now = new Date().toISOString();
const input = { title, url: normalized, clippedAt: now, clippedBy: ACTOR, body };
const sourceMd = buildSourceMarkdown(input);

let upsert;
if (existing !== null) {
  upsert = existing.content === sourceMd ? "skipped"
    : await client.upsertPage(pagePath, sourceMd, clipFrontmatter(input), PROJECT_ID);
  if (upsert !== "skipped") await client.writeSource(sourcePath, sourceMd, PROJECT_ID);
} else {
  await client.writeSource(sourcePath, sourceMd, PROJECT_ID);
  upsert = await client.upsertPage(pagePath, sourceMd, clipFrontmatter(input), PROJECT_ID);
}
try {
  if (upsert === "created") await client.embedPage(pagePath, PROJECT_ID, false);
  else if (upsert === "updated") await client.embedPage(pagePath, PROJECT_ID, true);
} catch (err) {
  if (err?.status !== 405) throw err; // 405 = 服务端已嵌（ingest 已覆盖），非致命
  console.error("embed 405 (already embedded, skip)");
}
const { job_id } = await client.createIngestJob([sourcePath], PROJECT_ID);

console.log(JSON.stringify({
  status: existing !== null ? "already" : "created",
  title, sourcePath, pagePath, upsert, jobId: job_id, bodyChars: body.length,
}, null, 2));

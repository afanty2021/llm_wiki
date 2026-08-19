// tools/transcriber/src/api-client.ts
// Task 14：写入客户端（M1 五步：writeSource → upsertTranscriptPage → registerMediaAssets
// → triggerIngest → waitJob，外加 verifyTranscriptIntact 对账）。
// 凭证：login/refresh 持久化 out/auth.json（**写入后 chmod 600**，spec §3.3）；
// 409 策略：POST 页冲突 → GET 预检 → content sha256 一致跳过，不一致 If-Match PUT。
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_AUTH_PATH = join(here, "../out/auth.json");

/** 服务端 ingest 终态集合（src-server ingest_queue：next_status 合法迁移的目标）。 */
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "succeeded_with_warnings", "failed", "cancelled"]);
/** PUT If-Match 冲突时的整轮重试上限（GET 预检 → PUT）。 */
const UPSERT_MAX_ROUNDS = 3;

export class ApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: unknown,
  ) {
    super(`HTTP ${status} ${url}: ${JSON.stringify(body).slice(0, 300)}`);
    this.name = "ApiError";
  }
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user?: { id: number; username: string };
}

export interface MediaAssetItem {
  slug: string;
  media_ref: string;
  playback_path?: string | null;
  duration_s: number;
  codec?: string | null;
  kind: "video" | "audio";
  /** Task 13 的 Chapter[]（chapters JSON 列）。 */
  chapters: unknown;
  transcript_page_path?: string | null;
  source_path?: string | null;
}

export interface JobStatus {
  id: string;
  project_id: number;
  status: string;
  stage?: string | null;
  progress?: number;
  error?: string | null;
  result?: unknown;
  /** item 级状态（服务端 JobResponse 的 JSONB 数组 [{path,status,error}]，snake_case；
   *  waitJob 终态返回时携带——CLI 层解析 failed 项驱动非零退出（M1 评审 #2））。 */
  item_states?: unknown;
}

interface WikiPageDTO {
  path: string;
  content: string | null;
  updated_at: string;
}

export interface ApiClientOptions {
  projectId: number;
  /** 既有 token 对（跳过 login 直写；测试注入用）。 */
  accessToken?: string;
  refreshToken?: string;
  /** auth.json 落盘路径，默认 tools/transcriber/out/auth.json。 */
  authPath?: string;
  /** 双 401 兜底重登录凭据（一般经 login() 记忆）。 */
  username?: string;
  password?: string;
  /** waitJob 轮询间隔 ms，默认 2000（测试传 0）。 */
  pollIntervalMs?: number;
  /** 等待函数注入（默认 setTimeout sleep）——测试注入录制桩，避免真实退避 5s/15s/60s。 */
  sleepFn?: (ms: number) => Promise<void>;
  /** 媒体签名 key（缺省读 MEDIA__SIGNING_KEY）。 */
  mediaSigningKey?: string;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 媒体 URL 签名——与 src-server utils/media_sign.rs 同算法：
 * HMAC-SHA256(key, `${media_id}:${exp}`) → hex（Task 7 服务端 verify_media_sig 消费）。
 */
export function signMedia(key: string, mediaId: string, exp: number): string {
  return createHmac("sha256", key).update(`${mediaId}:${exp}`).digest("hex");
}

/**
 * 极简 frontmatter 解析（仅覆盖 buildTranscriptMd 产出的形态）：
 * `key: 值`（双引号标量走 JSON.parse 吸收 YAML 敏感字符 / 纯数字 → number / 其余原样字符串）
 * 与 `key:` + 后续 `  - item` 列表。目的：POST /pages 的 frontmatter 字段驱动服务端
 * denormalize（title/type/sources 落规范化列），否则 transcript 页会被记为 concept。
 */
export function parseFrontmatter(md: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (listKey !== null && /^\s+-\s/.test(rawLine)) {
      (out[listKey] as unknown[]).push(rawLine.trim().slice(1).trim());
      continue;
    }
    listKey = null;
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === "") {
      out[key] = [];
      listKey = key; // 后续 `- item` 行归入该 key
    } else if (val.startsWith('"')) {
      try { out[key] = JSON.parse(val); } catch { out[key] = val; }
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** waitJob 总超时默认 4h（M2 前置：防 ingest job 卡住时 CLI 静默无限轮询）。 */
export const WAIT_JOB_DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** waitJob 单次非 2xx 的退避表（3 次重试：5s/15s/60s——M2 前置）。 */
export const WAIT_JOB_RETRY_BACKOFF_MS = [5_000, 15_000, 60_000] as const;

export interface WaitJobOptions {
  /** 总超时 ms，默认 {@link WAIT_JOB_DEFAULT_TIMEOUT_MS}（4h）；超时抛错带 job_id。 */
  timeoutMs?: number;
  /** 单次非 2xx 的有界重试次数（默认退避表长度 3；重试配额为整轮累计，非连续计数）。 */
  retryOn5xx?: number;
}

export class ApiClient {
  private accessToken: string;
  private refreshToken: string;
  private readonly authPath: string;
  private username?: string;
  private password?: string;
  private expiresIn?: number;
  private readonly pollIntervalMs: number;
  private readonly doSleep: (ms: number) => Promise<void>;

  constructor(
    public readonly baseUrl: string,
    private readonly opts: ApiClientOptions,
  ) {
    this.accessToken = opts.accessToken ?? "";
    this.refreshToken = opts.refreshToken ?? "";
    this.authPath = opts.authPath ?? DEFAULT_AUTH_PATH;
    this.username = opts.username;
    this.password = opts.password;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.doSleep = opts.sleepFn ?? sleep;
  }

  get projectId(): number {
    return this.opts.projectId;
  }

  // ── 凭证：login / 持久化 / refresh 轮换 ──

  /** POST /api/v1/auth/login → 记忆 token 对与凭据（双 401 重登录用）并持久化。 */
  async login(username: string, password: string): Promise<AuthTokens> {
    this.username = username;
    this.password = password;
    const res = await this.plainFetch("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return this.applyAuth(await this.parseJson(res, "login"));
  }

  /** 读取持久化的 token 对（进程重启续跑）；缺失/损坏返回 null。 */
  static readAuthFile(path: string = DEFAULT_AUTH_PATH): AuthTokens | null {
    try {
      const j = JSON.parse(readFileSync(path, "utf-8")) as AuthTokens;
      return j.access_token && j.refresh_token ? j : null;
    } catch {
      return null;
    }
  }

  private applyAuth(auth: AuthTokens): AuthTokens {
    if (!auth.access_token || !auth.refresh_token) throw new Error("auth response missing tokens");
    this.accessToken = auth.access_token;
    this.refreshToken = auth.refresh_token;
    this.expiresIn = auth.expires_in;
    this.persistAuth();
    return auth;
  }

  /** out/auth.json：写 token 对后 chmod 600（spec §3.3——文件含长期 refresh token）。 */
  private persistAuth(): void {
    mkdirSync(dirname(this.authPath), { recursive: true });
    writeFileSync(this.authPath, JSON.stringify({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_in: this.expiresIn,
      saved_at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 }); // 新建即 600（防 write→chmod 窗口期泄露）；已存在文件 mode 不生效 → chmodSync 兜底
    chmodSync(this.authPath, 0o600);
  }

  // ── fetch 包装：401 → refresh 轮换（持久化新对）→ 再 401 → 重登录 ──

  /**
   * 带 Bearer 的 fetch（path 以 http 开头则原样使用，否则拼 baseUrl）。
   * 非 2xx 不抛（409 等业务状态由调用方解读）；仅 401 走凭证链：
   * ① POST /auth/refresh 轮换（新 refresh 持久化——旧 token 已被服务端 revoke）
   * ② 仍 401 → login() 重放凭据；再失败则原样返回 401 Response 交调用方。
   */
  async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let res = await this.bearerFetch(url, init);
    if (res.status === 401) {
      if (await this.tryRefresh()) res = await this.bearerFetch(url, init);
      if (res.status === 401 && await this.tryRelogin()) res = await this.bearerFetch(url, init);
    }
    return res;
  }

  private async bearerFetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    // 带 body 的请求补 JSON content-type（服务端 axum Json extractor 415 硬要求；
    // T15 limit-1 真跑抓到的集成缺口，mock 测试未断言请求头故 T14 未现）
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(url, { ...init, headers });
  }

  private async plainFetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers as Record<string, string> },
    });
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await this.plainFetch("/api/v1/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });
      if (!res.ok) return false;
      this.applyAuth((await res.json()) as AuthTokens);
      return true;
    } catch {
      // 网络/畸形 JSON/缺 token 字段等异常一律吞掉返回 false（对齐 tryRelogin），
      // 交由上层按 401 继续凭证链或原样返回（M2 前置：refresh 崩溃不再冲断写入步骤）
      return false;
    }
  }

  private async tryRelogin(): Promise<boolean> {
    if (!this.username || !this.password) return false;
    try {
      await this.login(this.username, this.password);
      return true;
    } catch {
      return false;
    }
  }

  // ── 五步写入 ──

  /** ① 源文件（原始 md 副本）：POST /api/v1/files/{pid}/write，body {path, contents}。 */
  async writeSource(sourcePath: string, contents: string): Promise<void> {
    const res = await this.authedFetch(`/api/v1/files/${this.projectId}/write`, {
      method: "POST",
      body: JSON.stringify({ path: sourcePath, contents }),
    });
    await this.parseJson(res, `writeSource ${sourcePath}`);
  }

  /**
   * ② 转写页 upsert：POST /pages；409 → GET 预检：服务端 content sha256 与本地一致
   * → skipped（幂等重跑零写放大），不一致 → PUT 带 If-Match: <GET 响应 updated_at>。
   * PUT 再 409（预检-写入窗口内被并发改写）→ 整轮重试，上限 {@link UPSERT_MAX_ROUNDS}。
   */
  async upsertTranscriptPage(pagePath: string, md: string): Promise<"created" | "skipped" | "updated"> {
    const body = { path: pagePath, content: md, frontmatter: parseFrontmatter(md) };
    const pageUrl = () => `/api/v1/projects/${this.projectId}/page?path=${encodeURIComponent(pagePath)}`;

    const created = await this.authedFetch(`/api/v1/projects/${this.projectId}/pages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (created.status !== 409) {
      await this.parseJson(created, `create page ${pagePath}`);
      return "created";
    }

    const localHash = sha256Hex(md);
    for (let round = 0; round < UPSERT_MAX_ROUNDS; round++) {
      const cur = await this.authedFetch(pageUrl());
      const page = await this.parseJson<WikiPageDTO>(cur, `prefetch page ${pagePath}`);
      if (sha256Hex(page.content ?? "") === localHash) return "skipped";
      const put = await this.authedFetch(pageUrl(), {
        method: "PUT",
        headers: { "if-match": page.updated_at }, // 服务端 RFC3339 解析为 timestamptz 精确比较
        body: JSON.stringify(body),               // body.path == query path（PUT 不支持 rename）
      });
      if (put.status === 409) continue; // stale write → 重新 GET 再比
      await this.parseJson(put, `update page ${pagePath}`);
      return "updated";
    }
    throw new Error(`upsertTranscriptPage ${pagePath}: If-Match conflict persisted after ${UPSERT_MAX_ROUNDS} rounds`);
  }

  /** ③ 媒体资产登记：POST /api/v1/training/media-assets，返回 imported 数。 */
  async registerMediaAssets(items: MediaAssetItem[]): Promise<number> {
    const res = await this.authedFetch("/api/v1/training/media-assets", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    const j = await this.parseJson<{ imported: number }>(res, "registerMediaAssets");
    return j.imported;
  }

  /** ④ 触发 ingest：POST /api/v1/projects/{pid}/ingest，返回 job_id。 */
  async triggerIngest(sourcePaths: string[]): Promise<string> {
    const res = await this.authedFetch(`/api/v1/projects/${this.projectId}/ingest`, {
      method: "POST",
      body: JSON.stringify({ source_paths: sourcePaths }),
    });
    const j = await this.parseJson<{ job_id: string }>(res, "triggerIngest");
    return j.job_id;
  }

  /** ⑤ 轮询 GET /api/v1/ingest/jobs/:id 至终态（首次立即查，之后按 pollIntervalMs）。
   *  M2 前置健壮化：
   *  - 总超时（默认 {@link WAIT_JOB_DEFAULT_TIMEOUT_MS} 4h）——超时抛错带 job_id，防静默无限轮询；
   *  - 单次非 2xx 有界重试（默认 3 次，退避 5s/15s/60s）——配额为整轮累计而非连续计数
   *    （长任务中多次瞬时 5xx 也受同一上限约束）；配额尽后非 2xx 照常抛 ApiError。 */
  async waitJob(jobId: string, opts: WaitJobOptions = {}): Promise<JobStatus> {
    const timeoutMs = opts.timeoutMs ?? WAIT_JOB_DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.retryOn5xx ?? WAIT_JOB_RETRY_BACKOFF_MS.length;
    const deadline = Date.now() + timeoutMs;
    const url = `/api/v1/ingest/jobs/${jobId}`;
    let retries = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(`waitJob timed out after ${timeoutMs}ms: job ${jobId} 未到终态`);
      }
      const res = await this.authedFetch(url);
      if (!res.ok && retries < maxRetries) {
        await this.doSleep(WAIT_JOB_RETRY_BACKOFF_MS[Math.min(retries, WAIT_JOB_RETRY_BACKOFF_MS.length - 1)]);
        retries++;
        continue;
      }
      const job = await this.parseJson<JobStatus>(res, `job status ${jobId}`);
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
      await this.doSleep(this.pollIntervalMs);
    }
  }

  /** 对账：GET 页 → 服务端 content sha256 与写入时记录的 expectedHash 比对（LLM 改写即 false）。 */
  async verifyTranscriptIntact(pagePath: string, expectedHash: string): Promise<boolean> {
    const res = await this.authedFetch(`/api/v1/projects/${this.projectId}/page?path=${encodeURIComponent(pagePath)}`);
    const page = await this.parseJson<WikiPageDTO>(res, `verify page ${pagePath}`);
    return sha256Hex(page.content ?? "") === expectedHash.toLowerCase();
  }

  // ── 媒体签名（T15 sign-media 子命令消费）──

  /** 生成 `${base}/media/<slug>?exp=<unix>&sig=<hex>`；key 缺失 fail fast（服务端同样拒签）。 */
  signMediaUrl(mediaId: string, hours = 12, key = this.opts.mediaSigningKey ?? process.env.MEDIA__SIGNING_KEY ?? ""): string {
    if (!key) throw new Error("media signing key required (options.mediaSigningKey or MEDIA__SIGNING_KEY)");
    const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
    return `${this.baseUrl}/media/${mediaId}?exp=${exp}&sig=${signMedia(key, mediaId, exp)}`;
  }

  private async parseJson<T = unknown>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应原样保留 */ }
    if (!res.ok) throw new ApiError(res.status, what, body);
    return body as T;
  }
}

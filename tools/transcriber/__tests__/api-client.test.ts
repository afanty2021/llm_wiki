// tools/transcriber/__tests__/api-client.test.ts
// Task 14：写入客户端——mock fetch 全分支覆盖（409-skip / 409-update / 401-refresh-rotate /
// 双 401 重登录 / waitJob 终态停止 / 五步端点形状 / HMAC 向量）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ApiClient, signMedia, parseFrontmatter, WAIT_JOB_DEFAULT_TIMEOUT_MS, WAIT_JOB_RETRY_BACKOFF_MS } from "../src/api-client";
import { buildTranscriptMd } from "../src/transcript";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const headersOf = (init?: RequestInit): Headers => new Headers(init?.headers);
const bodyOf = (init?: RequestInit): any => JSON.parse(String(init?.body));

/** 每用例独立临时 auth.json（避免写 /dev/null——chmod 600 会破坏系统设备权限）。 */
function tempAuthPath(): string {
  return join(mkdtempSync(join(tmpdir(), "api-client-")), "auth.json");
}
const mode600 = (p: string) => (statSync(p).mode & 0o777) === 0o600;

describe("upsertTranscriptPage 409 策略", () => {
  it("409 且内容一致 → 跳过（不 PUT）", async () => {
    const md = "---\ntitle: t\n---\nbody";
    const puts: unknown[][] = [];
    let once = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/pages") && init?.method === "POST") return json(409, { error: "ERR_CONFLICT" });
      if (once++ === 0) return json(200, { path: "transcripts/t.md", content: md, updated_at: "2026-08-17T00:00:00Z" });
      puts.push([url, init]); return json(200, {});
    }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.upsertTranscriptPage("transcripts/t.md", md)).toBe("skipped");
    expect(puts).toHaveLength(0);
  });

  it("409 且内容不一致 → PUT 带 If-Match（值 = GET 响应 updated_at）", async () => {
    const md = "---\ntitle: t\n---\nnew body";
    const serverMd = "---\ntitle: t\n---\nOLD";
    let put: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/pages") && init?.method === "POST") return json(409, { error: "ERR_CONFLICT" });
      if (init?.method === "PUT") { put = init; return json(200, { path: "transcripts/t.md" }); }
      return json(200, { path: "transcripts/t.md", content: serverMd, updated_at: "2026-08-17T00:00:00Z" }); // GET 预检
    }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.upsertTranscriptPage("transcripts/t.md", md)).toBe("updated");
    expect(put).toBeDefined();
    expect(headersOf(put).get("if-match")).toBe("2026-08-17T00:00:00Z");
    expect(bodyOf(put).path).toBe("transcripts/t.md"); // body.path == query path（服务端 PUT 约束）
    expect(bodyOf(put).content).toBe(md);
  });

  it("无冲突 → 直接 created（frontmatter 随 body 递交）", async () => {
    const md = "---\ntitle: t\ntype: transcript\n---\nbody";
    let post: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { post = init; return json(201, { path: "transcripts/t.md" }); }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.upsertTranscriptPage("transcripts/t.md", md)).toBe("created");
    expect(bodyOf(post).frontmatter).toEqual({ title: "t", type: "transcript" });
  });
});

describe("authedFetch 401 → refresh 轮换", () => {
  it("401 → refresh 轮换并持久化新对（auth.json 写入 + 600）→ 重放成功", async () => {
    const authPath = tempAuthPath();
    const posts: { auth: string | null; url: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/auth/refresh") {
        expect(bodyOf(init).refresh_token).toBe("r"); // 用旧 refresh 换新
        return json(200, { access_token: "a2", refresh_token: "r2", expires_in: 900 });
      }
      if (u.pathname.endsWith("/pages")) {
        posts.push({ auth: headersOf(init).get("authorization"), url: String(url) });
        return posts.length === 1 ? json(401, { error: { code: "AUTH_EXPIRED" } }) : json(201, { path: "transcripts/t.md" });
      }
      return json(500, {});
    }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath });
    expect(await c.upsertTranscriptPage("transcripts/t.md", "---\ntitle: t\n---\nb")).toBe("created");
    expect(posts).toHaveLength(2);
    expect(posts[1].auth).toBe("Bearer a2");            // 重放带新 access token
    const saved = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(saved.access_token).toBe("a2");
    expect(saved.refresh_token).toBe("r2");              // 新 refresh 持久化（轮换后旧 r 已废）
    expect(mode600(authPath)).toBe(true);               // spec §3.3
  });

  it("refresh 也 401 → 重新 login（凭据复用）→ 重放成功", async () => {
    const authPath = tempAuthPath();
    let logins = 0, pagePosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/auth/refresh") return json(401, { error: { code: "AUTH_INVALID" } });
      if (u.pathname === "/api/v1/auth/login") {
        logins++;
        expect(bodyOf(init)).toEqual({ username: "svc", password: "pw" });
        return json(200, { access_token: "a3", refresh_token: "r3" });
      }
      if (u.pathname.endsWith("/pages")) return pagePosts++ === 0 ? json(401, {}) : json(201, {});
      return json(500, {});
    }));
    const c = new ApiClient("http://x", { projectId: 1, authPath });
    await c.login("svc", "pw");
    expect(await c.upsertTranscriptPage("transcripts/t.md", "---\ntitle: t\n---\nb")).toBe("created");
    expect(logins).toBe(2); // 显式 login 1 + 双 401 兜底 1
    expect(JSON.parse(readFileSync(authPath, "utf-8")).refresh_token).toBe("r3");
  });

  it("login 持久化 token 对并 chmod 600", async () => {
    const authPath = tempAuthPath();
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { access_token: "A", refresh_token: "R", expires_in: 900, user: { id: 1, username: "svc" } })));
    const c = new ApiClient("http://x", { projectId: 1, authPath });
    await c.login("svc", "pw");
    const saved = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(saved).toMatchObject({ access_token: "A", refresh_token: "R" });
    expect(mode600(authPath)).toBe(true);
  });

  it("persistAuth mode：新建路径首写即 600（writeFileSync mode，防 chmod 前窗口）；已存在 644 文件由 chmodSync 收紧", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { access_token: "A", refresh_token: "R" })));
    // 新建路径：fresh temp 目录（tempAuthPath 保证不存在），mode 0o600 在创建时生效
    const fresh = tempAuthPath();
    await new ApiClient("http://x", { projectId: 1, authPath: fresh }).login("svc", "pw");
    expect(mode600(fresh)).toBe(true);
    // 已存在路径：预置 0o644——writeFileSync mode 对既有文件不生效，断言 chmodSync 兜底收紧
    const existing = tempAuthPath();
    writeFileSync(existing, "{}\n", { mode: 0o644 });
    chmodSync(existing, 0o644);
    await new ApiClient("http://x", { projectId: 1, authPath: existing }).login("svc", "pw");
    expect(mode600(existing)).toBe(true);
  });
});

describe("waitJob 轮询", () => {
  it("非终态轮询、succeeded 即停（不再多打一发）", async () => {
    const statuses = ["running", "succeeded", "succeeded"];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { id: "j1", status: statuses[Math.min(calls++, statuses.length - 1)], progress: 100 })));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", pollIntervalMs: 0 });
    const job = await c.waitJob("j1");
    expect(job.status).toBe("succeeded");
    expect(calls).toBe(2);
  });

  it("failed / succeeded_with_warnings / cancelled 均为终态", async () => {
    for (const terminal of ["failed", "succeeded_with_warnings", "cancelled"]) {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => json(200, { id: "j1", status: calls++ === 0 ? "pending" : terminal })));
      const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", pollIntervalMs: 0 });
      expect((await c.waitJob("j1")).status).toBe(terminal);
      expect(calls).toBe(2);
    }
  });

  it("终态返回携带 item_states（snake_case [{path,status,error}]，M1 评审 #2——此前被丢弃）", async () => {
    const itemStates = [
      { path: "sources/transcripts/a.md", status: "done", error: null },
      { path: "sources/transcripts/b.md", status: "failed", error: "embedding timeout" },
    ];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {
      id: "j1", project_id: 1, status: calls++ === 0 ? "running" : "succeeded_with_warnings",
      item_states: itemStates,
    })));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", pollIntervalMs: 0 });
    const job = await c.waitJob("j1");
    expect(job.status).toBe("succeeded_with_warnings");
    expect(job.item_states).toEqual(itemStates);
  });
});

describe("五步其余端点形状", () => {
  it("writeSource → POST /files/{pid}/write，body {path, contents}，带 Bearer", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { captured = { url: String(url), init }; return json(200, { status: "ok" }); }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 7, refreshToken: "r", authPath: "/dev/null" });
    await c.writeSource("sources/transcripts/s1.md", "正文");
    expect(captured!.url).toBe("http://x/api/v1/files/7/write");
    expect(captured!.init!.method).toBe("POST");
    expect(bodyOf(captured!.init)).toEqual({ path: "sources/transcripts/s1.md", contents: "正文" });
    expect(headersOf(captured!.init).get("authorization")).toBe("Bearer a");
    expect(headersOf(captured!.init).get("content-type")).toBe("application/json"); // T15 limit-1 真跑：axum Json extractor 415
  });

  it("registerMediaAssets → POST /training/media-assets {items} → imported", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { captured = { url: String(url), init }; return json(200, { imported: 1 }); }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    const item = {
      slug: "s1", media_ref: "/abs/x.mp4", playback_path: null, duration_s: 120, codec: "h264",
      kind: "video" as const, chapters: [{ start_s: 0, end_s: 10, label: "L" }],
      transcript_page_path: "transcripts/s1.md", source_path: "sources/transcripts/s1.md",
    };
    expect(await c.registerMediaAssets([item])).toBe(1);
    expect(captured!.url).toBe("http://x/api/v1/training/media-assets");
    expect(bodyOf(captured!.init).items).toEqual([item]);
  });

  it("triggerIngest → POST /projects/{pid}/ingest {source_paths} → job_id", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { captured = { url: String(url), init }; return json(201, { job_id: "abc", status: "pending" }); }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 3, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.triggerIngest(["sources/transcripts/s1.md"])).toBe("abc");
    expect(captured!.url).toBe("http://x/api/v1/projects/3/ingest");
    expect(bodyOf(captured!.init)).toEqual({ source_paths: ["sources/transcripts/s1.md"] });
  });

  it("verifyTranscriptIntact：GET 页 content 的 sha256 与期望 hash 比对", async () => {
    const md = "---\ntitle: t\n---\nbody";
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { path: "transcripts/t.md", content: md, updated_at: "2026-08-17T00:00:00Z" })));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.verifyTranscriptIntact("transcripts/t.md", sha256(md))).toBe(true);
    expect(await c.verifyTranscriptIntact("transcripts/t.md", sha256("tampered"))).toBe(false);
  });
});

describe("waitJob 总超时 + 有界重试（M2 前置）", () => {
  /** 退避经注入 sleepFn 录制——测试绝不真等 5s/15s/60s。 */
  const recordingSleep = (log: number[]) => async (ms: number): Promise<void> => { log.push(ms); };

  it("默认契约：总超时 4h；退避表 5s/15s/60s（3 次重试）", () => {
    expect(WAIT_JOB_DEFAULT_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);
    expect([...WAIT_JOB_RETRY_BACKOFF_MS]).toEqual([5_000, 15_000, 60_000]);
  });

  it("单次非 2xx：500×2 → 第 3 次成功（退避 5s/15s 走注入 sleep）", async () => {
    const statuses = [500, 500, 200];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const s = statuses[Math.min(calls++, statuses.length - 1)];
      return s === 200 ? json(200, { id: "j1", status: "succeeded" }) : json(s, { error: "boom" });
    }));
    const sleeps: number[] = [];
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 0, sleepFn: recordingSleep(sleeps),
    });
    expect((await c.waitJob("j1")).status).toBe("succeeded");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5_000, 15_000]); // 仅退避两次，成功后不再睡
  });

  it("重试配额（3）耗尽 → 抛最后 ApiError（HTTP 500）", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return json(500, { error: "down" }); }));
    const sleeps: number[] = [];
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 0, sleepFn: recordingSleep(sleeps),
    });
    await expect(c.waitJob("j9")).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(4);          // 首发 1 + 重试 3
    expect(sleeps).toEqual([5_000, 15_000, 60_000]);
  });

  it("总超时：一直 running → 抛错带 job_id（不再静默无限轮询）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { id: "job-xyz", status: "running" })));
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 5, // 真实短睡（默认 sleep），几轮后越过 deadline
    });
    await expect(c.waitJob("job-xyz", { timeoutMs: 30 })).rejects.toThrow(/job-xyz/);
    await expect(c.waitJob("job-xyz", { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it("非 2xx 重试不重置终态语义：500 → 200 failed 仍原样返回（failed 是终态不是异常）", async () => {
    const statuses = [500, 200];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const s = statuses[Math.min(calls++, statuses.length - 1)];
      return s === 200 ? json(200, { id: "j1", status: "failed", error: "item err" }) : json(s, {});
    }));
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 0, sleepFn: async () => {},
    });
    expect((await c.waitJob("j1")).status).toBe("failed");
  });

  it("重试收窄：4xx（非 429）不重试——404 首发/重试配额充足也立即抛 ApiError（零退避）", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return json(404, { error: { code: "JOB_NOT_FOUND", message: "no such job" } }); }));
    const sleeps: number[] = [];
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 0, sleepFn: recordingSleep(sleeps),
    });
    await expect(c.waitJob("j404")).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);            // 4xx 语义性失败：退避重试同态无意义
    expect(sleeps).toEqual([]);       // 未进入任何退避
  });

  it("重试收窄矩阵：400/401/403/409/422 均 1 发即败（401 的 refresh 探测另计）；429 仍按瞬时态退避重试", async () => {
    for (const s of [400, 401, 403, 409, 422]) {
      let jobCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        // 401 会先走 authedFetch 凭证链（refresh 探测一发，失败后原样返回）——合法行为另计
        if (String(url).includes("/api/v1/auth/refresh")) return json(401, { error: "nope" });
        jobCalls++;
        return json(s, { error: "x" });
      }));
      const sleeps: number[] = [];
      const c = new ApiClient("http://x", {
        accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
        pollIntervalMs: 0, sleepFn: recordingSleep(sleeps),
      });
      await expect(c.waitJob(`j${s}`)).rejects.toThrow(new RegExp(`HTTP ${s}`));
      expect(jobCalls).toBe(1);      // job 端点恰一发：4xx 不进入退避重试
      expect(sleeps).toEqual([]);    // 未进入任何退避
    }
    // 429 是限流瞬时态：仍吃退避重试
    const statuses = [429, 200];
    let calls429 = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const s = statuses[Math.min(calls429++, statuses.length - 1)];
      return s === 200 ? json(200, { id: "j1", status: "succeeded" }) : json(s, { error: "slow down" });
    }));
    const sleeps: number[] = [];
    const c = new ApiClient("http://x", {
      accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null",
      pollIntervalMs: 0, sleepFn: recordingSleep(sleeps),
    });
    expect((await c.waitJob("j1")).status).toBe("succeeded");
    expect(calls429).toBe(2);
    expect(sleeps).toEqual([5_000]);
  });
});

describe("tryRefresh 守卫（M2 前置：网络/JSON 异常吞掉返回 false，对齐 tryRelogin）", () => {
  it("refresh 200 但 body 畸形（非 JSON）→ 返回 false：不崩、不持久化垃圾、上层按 401 走", async () => {
    const authPath = tempAuthPath();
    let pageCalls = 0, refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/auth/refresh") {
        refreshCalls++;
        return new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.pathname.endsWith("/pages")) return pageCalls++ === 0 ? json(401, {}) : json(201, {});
      return json(500, {});
    }));
    const c = new ApiClient("http://x", { accessToken: "a", refreshToken: "r", projectId: 1, authPath });
    await expect(c.upsertTranscriptPage("transcripts/t.md", "---\ntitle: t\n---\nb")).rejects.toThrow(/HTTP 401/);
    expect(refreshCalls).toBe(1);
    expect(pageCalls).toBe(1);                 // refresh false 后未带旧 token 重放
    expect(existsSync(authPath)).toBe(false);  // 畸形 body 未被持久化
  });

  it("refresh 网络级异常（fetch 抛错）→ 同样吞掉返回 false", async () => {
    let pageCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/auth/refresh") throw new TypeError("fetch failed: ECONNREFUSED");
      if (u.pathname.endsWith("/pages")) return pageCalls++ === 0 ? json(401, {}) : json(201, {});
      return json(500, {});
    }));
    const c = new ApiClient("http://x", { accessToken: "a", refreshToken: "r", projectId: 1, authPath: "/dev/null" });
    await expect(c.upsertTranscriptPage("transcripts/t.md", "---\ntitle: t\n---\nb")).rejects.toThrow(/HTTP 401/);
    expect(pageCalls).toBe(1);
  });
});

describe("parseFrontmatter 直测（M2 前置：mcp/transcriber 共用的 T13 形态）", () => {
  it("T13 形态：type/sources/media_slug/duration_s 四字段原样解析", () => {
    const md = [
      "---",
      'title: "Lesson 3: Phonics？"',
      "type: transcript",
      "media_slug: abc12345",
      "duration_s: 1234",
      "sources:",
      "  - sources/transcripts/abc12345.md",
      "---",
      "## [00:00] hi",
      "",
      "[00:00] hello world",
    ].join("\n");
    expect(parseFrontmatter(md)).toEqual({
      title: "Lesson 3: Phonics？",   // 双引号标量走 JSON.parse（吸收 ：/？ 等 YAML 敏感字符）
      type: "transcript",
      media_slug: "abc12345",
      duration_s: 1234,               // 纯数字 → number
      sources: ["sources/transcripts/abc12345.md"], // `sources:` + 缩进 `- item` 列表
    });
  });

  it("与 buildTranscriptMd 产出对账（round-trip：写入端 ⇄ 解析端锁同一形状）", () => {
    const { md } = buildTranscriptMd({
      title: "T: 感叹！问？",
      segments: [{ startS: 0, endS: 4, text: " hello " }, { startS: 320, endS: 330, text: "world" }],
      sourcePath: "sources/transcripts/abcd1234.md",
      mediaSlug: "abcd1234",
      durationS: 620,
    });
    const fm = parseFrontmatter(md);
    expect(fm.type).toBe("transcript");
    expect(fm.sources).toEqual(["sources/transcripts/abcd1234.md"]);
    expect(fm.media_slug).toBe("abcd1234");
    expect(fm.duration_s).toBe(620);
    expect(fm.title).toBe("T: 感叹！问？");
  });

  it("退化：无 frontmatter → {}（type 缺失 → 服务端记为 concept 语义）", () => {
    expect(parseFrontmatter("正文，无 frontmatter")).toEqual({});
    expect(parseFrontmatter("---\nkey: 但无闭合\n")).toEqual({}); // 无闭合 --- 不算 frontmatter
  });
});

describe("signMedia（三段式唯一格式，2026-08-25 起服务端严格验签）", () => {
  it("两段式已移除：signMedia 缺 fp 抛错（TS 侧防手滑产出服务端必拒票据）", () => {
    expect(() => (signMedia as unknown as (k: string, m: string, e: number) => string)("k", "m", 123)).toThrow();
  });

  it("三段式（Task 9 fp）：HMAC-SHA256(key, `${media_id}:${exp}:${fp}`)——与 Rust sign_media_with_fp 向量一致", () => {
    // 预计算向量 ×2（Rust media_sign.rs tests 同值双锁）：
    // HMAC-SHA256("k", "m:123:abcdef0123456789")
    expect(signMedia("k", "m", 123, "abcdef0123456789")).toBe("6ff287af43e5e25e63cc640d715c5ba4c2fa7be0256e84783d23f2b9aa03d7cf");
    // HMAC-SHA256("k", "media-slug-1:1700000000:0011223344556677")
    expect(signMedia("k", "media-slug-1", 1700000000, "0011223344556677")).toBe("453dc8bd833a447601595d6b4f80507beb8e52b78221e4138e7317233a143c4e");
  });

  it("signMediaUrl 缺/空/null fp 抛错（两段式移除后服务端必拒，fail fast）", () => {
    const c = new ApiClient("http://127.0.0.1:8080", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", mediaSigningKey: "k" });
    // @ts-expect-error 运行时守卫测试：JS 调用方可能漏传 fp
    expect(() => c.signMediaUrl("slug-1", 12)).toThrow(/fp required/);
    expect(() => c.signMediaUrl("slug-1", 12, undefined, null as unknown as string)).toThrow(/fp required/);
    expect(() => c.signMediaUrl("slug-1", 12, undefined, "")).toThrow(/fp required/);
  });

  it("signMediaUrl 带 fp：URL 附 &fp= 且 sig 为三段式（/t/ 落地页同形票据）", () => {
    const c = new ApiClient("http://127.0.0.1:8080", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", mediaSigningKey: "k" });
    const u = new URL(c.signMediaUrl("slug-1", 12, undefined, "abcdef0123456789"));
    const exp = Number(u.searchParams.get("exp"));
    expect(u.searchParams.get("fp")).toBe("abcdef0123456789");
    expect(u.searchParams.get("sig")).toBe(signMedia("k", "slug-1", exp, "abcdef0123456789"));
  });

  it("缺 key → 报错（fail fast，不发无签名 URL）", () => {
    vi.stubEnv("MEDIA__SIGNING_KEY", ""); // 隔离宿主机真实 env，确保走"无 key"分支
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(() => c.signMediaUrl("s", 12, undefined, "0000000000000000")).toThrow(/signing key/i);
  });
});

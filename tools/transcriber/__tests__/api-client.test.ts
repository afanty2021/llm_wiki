// tools/transcriber/__tests__/api-client.test.ts
// Task 14：写入客户端——mock fetch 全分支覆盖（409-skip / 409-update / 401-refresh-rotate /
// 双 401 重登录 / waitJob 终态停止 / 五步端点形状 / HMAC 向量）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ApiClient, signMedia } from "../src/api-client";

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

describe("signMedia（Task 7 服务端同算法）", () => {
  it("HMAC-SHA256(key, `${media_id}:${exp}`) hex——与 Rust media_sign.rs 向量一致", () => {
    // 预计算向量：HMAC-SHA256("k", "m:123") — 锁定两侧算法漂移
    expect(signMedia("k", "m", 123)).toBe("3d2dc485f29e280c2a5dbf7988b55d23378e06aa891b1df1372714ca19f2fed9");
  });

  it("signMediaUrl 输出 ${base}/media/<slug>?exp=..&sig=..（T15 sign-media 消费）", () => {
    const c = new ApiClient("http://127.0.0.1:8080", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null", mediaSigningKey: "k" });
    const u = new URL(c.signMediaUrl("slug-1", 12));
    expect(`${u.origin}${u.pathname}`).toBe("http://127.0.0.1:8080/media/slug-1");
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig")!;
    expect(sig).toBe(signMedia("k", "slug-1", exp));
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 11 * 3600);
  });

  it("缺 key → 报错（fail fast，不发无签名 URL）", () => {
    vi.stubEnv("MEDIA__SIGNING_KEY", ""); // 隔离宿主机真实 env，确保走"无 key"分支
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(() => c.signMediaUrl("s")).toThrow(/signing key/i);
  });
});

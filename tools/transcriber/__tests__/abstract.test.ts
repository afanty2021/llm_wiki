// tools/transcriber/__tests__/abstract.test.ts
// 课例摘要（2026-09-08 门槛④）：insertAbstract 模板幂等 / 采样 / LLM mock / 快照幂等
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { insertAbstract } from "../src/transcript";
import { sampleMdForAbstract } from "../src/abstract";
import { llmAbstract, maybeAbstract, loadAbstract, DEFAULT_ABSTRACT } from "../src/abstract";

const FM = "---\ntitle: \"测试课\"\ntype: transcript\n---\n\n## [00:00] 热身\n[00:00] Good morning children.\n\n## [05:00] 新授\n[05:00] Look at the picture.";

describe("insertAbstract（中文课例摘要块插入，门槛④检索锚）", () => {
  it("插入到 frontmatter 之后、首个章节之前", () => {
    const out = insertAbstract(FM, "这是一节四年级绘本阅读课。");
    expect(out.indexOf("## 课例摘要")).toBeGreaterThan(out.indexOf("---\n"));
    expect(out.indexOf("## 课例摘要")).toBeLessThan(out.indexOf("## [00:00]"));
    expect(out).toContain("这是一节四年级绘本阅读课。");
    expect(out).toContain("## [00:00] 热身");
  });
  it("幂等：已有摘要块时原位替换不叠块", () => {
    const once = insertAbstract(FM, "旧摘要。");
    const twice = insertAbstract(once, "新摘要内容。");
    expect(twice).not.toContain("旧摘要");
    expect(twice.match(/## 课例摘要/g)).toHaveLength(1);
    expect(twice).toContain("新摘要内容。");
    expect(twice).toContain("## [05:00] 新授"); // 后续章节完好
  });
  it("摘要文本含 $ 与换行不被替换机制吞掉", () => {
    const odd = "奖励贴纸 $1 一个。\n第二行。";
    const out = insertAbstract(FM, odd);
    expect(out).toContain("$1 一个。\n第二行。");
  });
  it("无 frontmatter 的空页形态 → 置顶", () => {
    const out = insertAbstract("## [00:00] 孤章\n正文", "摘要");
    expect(out.startsWith("## 课例摘要")).toBe(true);
  });
});

describe("sampleMdForAbstract（长页采样：章节骨架 + 首中尾三段）", () => {
  it("短页原样（去 frontmatter）", () => {
    const out = sampleMdForAbstract(FM);
    expect(out).toContain("## [00:00] 热身");
    expect(out).not.toContain("title:");
  });
  it("长页截断含首中尾三段且不超上限", () => {
    const long = FM + "\n\n" + Array.from({ length: 2000 }, (_, i) => `句子${i}些课堂实录内容填充`).join("");
    const out = sampleMdForAbstract(long, 8000);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out).toContain("句子0");          // 首
    expect(out).toContain("（中略）");        // 省略标记
    const lastIdx = out.lastIndexOf("句子");
    expect(Number(out.slice(lastIdx + 2, lastIdx + 6).match(/\d+/)?.[0])).toBeGreaterThan(1000); // 尾段
  });
});

describe("llmAbstract（mock fetch）", () => {
  const okFetch = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
  it("解析 content 并剥模型自带标题", async () => {
    const out = await llmAbstract("样本", { ...DEFAULT_ABSTRACT }, { fetchImpl: okFetch("## 课例摘要\n\n四年级绘本课摘要。") });
    expect(out).toBe("四年级绘本课摘要。");
  });
  it("HTTP 错误抛出（调用方回落无摘要）", async () => {
    await expect(llmAbstract("样本", { ...DEFAULT_ABSTRACT }, { fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch })).rejects.toThrow(/500/);
  });
  it("空 content 抛错", async () => {
    await expect(llmAbstract("样本", { ...DEFAULT_ABSTRACT }, { fetchImpl: okFetch("") })).rejects.toThrow(/空摘要/);
  });
});

describe("maybeAbstract（快照幂等）", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "t-abstract-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("首跑生成并落快照；二跑读快照零 LLM 调用", async () => {
    let calls = 0;
    const deps = { apiKey: "test-key", fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: "摘要文本A。" } }] }), { status: 200 }); }) as unknown as typeof fetch };
    const out1 = await maybeAbstract({ md: FM, slug: "s-x", outDir: dir, deps });
    expect(out1).toContain("摘要文本A。");
    expect(existsSync(join(dir, "abstract", "s-x.md"))).toBe(true);
    const out2 = await maybeAbstract({ md: FM, slug: "s-x", outDir: dir, deps });
    expect(calls).toBe(1);
    expect(out2).toBe(out1);
  });
  it("LLM 失败回落原 md（不落快照、不 fail 批次）", async () => {
    const out = await maybeAbstract({ md: FM, slug: "s-fail", outDir: dir, deps: { apiKey: "test-key", fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch } });
    expect(out).toBe(FM);
    expect(loadAbstract(dir, "s-fail")).toBeNull();
  });
  it("enabled=false 静默跳过", async () => {
    const out = await maybeAbstract({ md: FM, slug: "s-off", outDir: dir, cfg: { enabled: false }, deps: { apiKey: "test-key", fetchImpl: (async () => { throw new Error("不应调用"); }) as unknown as typeof fetch } });
    expect(out).toBe(FM);
  });
});

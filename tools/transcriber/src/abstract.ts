// tools/transcriber/src/abstract.ts
// 课例中文摘要（2026-09-08 门槛④：视频页跨语言检索锚——英文课堂实录页的中文
// 文本只有章节标题几行，自然中文教师查询前 30 全空（刘飞雪试点实测），摘要块
// 提供中文密集锚文本）。快照幂等哲学与 maybePunctuate 同源：LLM 非确定输出
// 只允许发生一次并落盘，断点续跑/重跑上传按快照字节级复用。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadZaiKey, stripThinking } from "./chaptering";
import { insertAbstract } from "./transcript";

export interface AbstractConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
}

export const DEFAULT_ABSTRACT = {
  enabled: true,
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  model: "glm-5.3-flash",
} as const;

export const ABSTRACT_MAX_CHARS = 8000; // 送 LLM 的正文采样上限

const SYS = "你是小学英语教研员。根据课堂实录为教师写中文课例观摩摘要。";

/** 页面采样：章节小标题（教学流程骨架）+ 首段/中段/尾段正文各取样，防长页
 *  截断偏向开头（热身环节）。返回拼接文本。 */
export function sampleMdForAbstract(md: string, maxChars = ABSTRACT_MAX_CHARS): string {
  const headers = [...md.matchAll(/^## \[.+$/gm)].map(m => m[0]).join("\n");
  const body = md.replace(/^---[\s\S]*?---/, "").replace(/^## \[.+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const budget = Math.max(0, maxChars - headers.length);
  if (body.length <= budget) return `${headers}\n${body}`.trim();
  const third = Math.floor(budget / 3);
  const head = body.slice(0, third);
  const mid = body.slice(Math.floor(body.length / 2) - third / 2, Math.floor(body.length / 2) + third / 2);
  const tail = body.slice(body.length - third);
  return `${headers}\n${head}\n…（中略）…\n${mid}\n…（中略）…\n${tail}`.slice(0, maxChars);
}

export interface LlmAbstractDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

/** LLM 生成中文课例摘要（120-200 字，纯文本无 markdown）。失败抛错，调用方回落无摘要。 */
export async function llmAbstract(
  sample: string,
  cfg: Required<AbstractConfig>,
  deps: LlmAbstractDeps = {},
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey ?? loadZaiKey()}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请为以下课堂实录写 120-200 字中文课例摘要，覆盖：课型与主题、教学环节流程、核心活动/操练方式、语言点或技能目标、适用学段。只输出摘要正文，不要标题、不要 markdown、不要任何评论。\n\n课堂实录：\n${sample}` },
      ],
      temperature: 0.2,
      max_tokens: 800,
      thinking: { type: "disabled" }, // bigmodel 不认 enable_thinking；reasoning 烧爆 max_tokens 会静默空输出（2026-09-02 事故教训）
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`zai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = stripThinking(j.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("空摘要");
  return text.replace(/^#+\s*课例摘要\s*$/m, "").trim(); // 模型偶发自带标题，剥掉
}

const abstractPath = (outDir: string, slug: string): string => join(outDir, "abstract", `${slug}.md`);

export function persistAbstract(outDir: string, slug: string, text: string): void {
  const dir = join(outDir, "abstract");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abstractPath(outDir, slug), text);
}

export function loadAbstract(outDir: string, slug: string): string | null {
  const p = abstractPath(outDir, slug);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** 摘要装配入口：快照优先 → LLM 生成（落快照）→ 失败回落原文（页照常产出，
 *  只缺检索锚——非关键增强不 fail 批次）。cfg.enabled=false 或缺 ZAI key 时静默跳过。 */
export async function maybeAbstract(input: {
  md: string
  slug: string
  outDir: string
  cfg?: AbstractConfig
  deps?: LlmAbstractDeps
}): Promise<string> {
  const cfg = { ...DEFAULT_ABSTRACT, ...input.cfg };
  if (!cfg.enabled) return input.md;
  const cached = loadAbstract(input.outDir, input.slug);
  if (cached !== null) return insertAbstract(input.md, cached);
  if (!input.deps?.apiKey && !process.env.ZAI_API_KEY && !loadZaiKey()) {
    console.warn("[abstract] 缺 ZAI_API_KEY（env 或 ~/.hermes/.env），页无课例摘要");
    return input.md;
  }
  try {
    const text = await llmAbstract(sampleMdForAbstract(input.md), cfg, input.deps);
    persistAbstract(input.outDir, input.slug, text);
    return insertAbstract(input.md, text);
  } catch (e) {
    console.warn(`[abstract] ${input.slug}: ${String(e).slice(0, 140)}，页无课例摘要`);
    return input.md;
  }
}

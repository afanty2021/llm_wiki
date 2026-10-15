/**
 * 2026-10-15 去重战役内容修正（三页）：
 *  - wiki/index.md：删除 78 行败者转写链接（胜者同列，无需改指）
 *  - concepts/jigsaw-reading.md：行内来源引用 4-63-…-980a65ee（败）→ 8e1b9175（胜）
 *  - entities/mary-lt-lecturer.md：来源引用 sources/transcripts/4-38-…-336ab6f8（败）
 *    → sources/transcripts/人教版高中二年级-Listening-Reading-491b7ac5.md（胜）
 * 用法：
 *   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/dedupe-content-fix.ts            # 干跑
 *   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/dedupe-content-fix.ts --execute  # 实跑
 * 页面走 upsertTranscriptPage（POST→409→If-Match PUT，PUT 自动重嵌）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "../src/api-client";

const EXECUTE = process.argv.includes("--execute");
const outDir = join(import.meta.dirname, "../out");
const password = process.env.SVC_PASSWORD;
if (!password) { console.error("缺 SVC_PASSWORD"); process.exit(1); }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
});

// sets 读 kb-dumps 持久归档（评审 2026-10-16 Important 2：原指 /tmp/dedupe-sets.json，
// 重启即失——去重全套工件已随归档移入 ~/kb-dumps/20261015-dedupe-81/）
const setsPath = join(process.env.HOME ?? "", "kb-dumps/20261015-dedupe-81/dedupe-sets.json");
const sets = JSON.parse(readFileSync(setsPath, "utf-8")) as {
  losers: string[]; winners: string[];
};
const loserPaths = new Set(sets.losers.map((l) => `transcripts/${l}.md`));

const EDITS: Array<{
  path: string; expect: number;
  already: (md: string) => boolean;
  apply: (md: string) => { next: string; changed: number } | null;
}> = [
  {
    path: "wiki/index.md", expect: 78,
    already: (md) => ![...loserPaths].some((p) => md.includes(`(${p})`)),
    apply(md) {
      const lines = md.split("\n");
      const kept = lines.filter((ln) =>
        ![...loserPaths].some((p) => ln.includes(`(${p})`)));
      const changed = lines.length - kept.length;
      if (changed === 0) return null;
      return { next: kept.join("\n"), changed };
    },
  },
  {
    path: "concepts/jigsaw-reading.md", expect: 1,
    already: (md) => md.includes("transcripts/初中优质词汇课教学视频分析-下-8e1b9175.md"),
    apply(md) {
      const old = "transcripts/4-63-初中优质词汇课教学视频分析-下-980a65ee.md";
      const neu = "transcripts/初中优质词汇课教学视频分析-下-8e1b9175.md";
      if (!md.includes(old)) return null;
      return { next: md.split(old).join(neu), changed: md.split(old).length - 1 };
    },
  },
  {
    path: "entities/mary-lt-lecturer.md", expect: 1,
    already: (md) => md.includes("sources/transcripts/人教版高中二年级-Listening-Reading-491b7ac5.md"),
    apply(md) {
      const old = "sources/transcripts/4-38-人教版高中二年级-Listening-Reading-336ab6f8.md";
      const neu = "sources/transcripts/人教版高中二年级-Listening-Reading-491b7ac5.md";
      if (!md.includes(old)) return null;
      return { next: md.split(old).join(neu), changed: md.split(old).length - 1 };
    },
  },
];

await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password);

let fail = 0;
for (const e of EDITS) {
  const url = `/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(e.path)}`;
  const res = await api.authedFetch(url);
  const page = await res.json() as { content?: string };
  const md = page.content ?? "";
  const r = e.apply(md);
  if (r === null) {
    // 幂等口径（评审 2026-10-16 Minor 8）：目标态已达成 = 上次已改过，跳过不算失败；
    // 连待改内容都找不到且目标态未达成 = 真异常
    if (e.already(md)) { console.log(`= ${e.path}：目标态已达成（上次已改过），幂等跳过`); continue; }
    console.error(`✗ ${e.path}：未找到待改内容且目标态未达成`); fail++; continue;
  }
  if (r.changed !== e.expect) {
    console.error(`✗ ${e.path}：命中 ${r.changed} 处 ≠ 预期 ${e.expect}，拒绝`); fail++; continue;
  }
  // 后验：改后内容不再含任何败者路径
  if ([...loserPaths].some((p) => r.next.includes(p)) ||
      r.next.includes("4-63-初中优质词汇课教学视频分析-下-980a65ee") ||
      r.next.includes("4-38-人教版高中二年级-Listening-Reading-336ab6f8")) {
    console.error(`✗ ${e.path}：改后仍含败者引用`); fail++; continue;
  }
  console.log(`${EXECUTE ? "EXECUTE" : "dry-run"} ${e.path}：${r.changed} 处（预期 ${e.expect}）`);
  if (EXECUTE) {
    const st = await api.upsertTranscriptPage(e.path, r.next);
    console.log(`  upsert → ${st}`);
  }
}
if (fail) { console.error(`${fail} 页失败`); process.exit(1); }
console.log(EXECUTE ? "全部完成" : "干跑通过（加 --execute 实跑）");

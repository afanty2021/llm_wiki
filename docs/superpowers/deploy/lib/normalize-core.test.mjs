// docs/superpowers/deploy/lib/normalize-core.test.mjs
//
// normalize-core.mjs 单元测试（m3-impl-review W2 遗留项）。
// 跑法（主）：node --test docs/superpowers/deploy/lib/*.test.mjs
//   ⚠ 目录形式 node --test <dir> 在 Node v26.5 把目录当模块入口（MODULE_NOT_FOUND），须用 glob。
// 双 runner 兼容（Batch B shim 模式）：根 vitest 4 会扫到 docs/**/*.test.mjs 但不收集
// node:test 用例（报 "No test suite found" 破坏 npm test），故在 vitest 环境
// （process.env.VITEST）下改 import vitest 的 test/describe；断言统一
// node:assert/strict（两 runner 通用）。本文件零外部依赖、零网络/文件副作用。
//
// 六类核心用例（对应任务验收）：
//  ① slug 计算：四英文形态（大写/空格/括号逗号/点号）+ 连压缩 + 目录保留
//  ② 孪生探测五级链：exact-dir / exact-crossdir / stem-equiv / paren-stripped / title(+token-set)
//  ③ 决策表：无孪生 rename / 有孪生 merge / 中文标题标记 needsLlmSlug
//  ④ 多胞胎迭代合并（TBLT 三页）+ slug 撞车 -2 去重
//  ⑤ 入链改写：指向旧 path 的链接 → [[新slug|现标题]]；alias/锚点/fence/悬空保留
//  ⑥ 图模拟：边数/悬空（graph.rs 语义近似——title 碰撞除名、自环跳过、无向去重、锚点不可解析）

import assert from "node:assert/strict";

const { test, describe } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

import {
  isSlugPath, hasCJK, dirOf, mechanicalSlugStem, stripParens, tokenKey, needsLlmSlug, buildSlugInfo,
  selectNonSlugPages, selectTwinCandidates, findTwin, computeDecisions, mergeSources,
  rewriteLinksToPlan, extractGraphWikilinks, graphNorm, simulateGraphStats, composePostPlanPages,
  SLUG_OVERRIDES, slugOverrideFor, resolveSlugInfo,
} from "./normalize-core.mjs";
import { buildLinkCtx } from "./translate-core.mjs";

// ══ ① slug 计算 ══
describe("① mechanicalSlugStem 四英文形态 + 压缩", () => {
  test("大写单词：Twinkle → twinkle", () => {
    assert.equal(mechanicalSlugStem("Twinkle"), "twinkle");
  });
  test("空格：Real World Task → real-world-task", () => {
    assert.equal(mechanicalSlugStem("Real World Task"), "real-world-task");
  });
  test("括号+逗号：PPP (Presentation, Practice, Production) → ppp-presentation-practice-production", () => {
    assert.equal(mechanicalSlugStem("PPP (Presentation, Practice, Production)"), "ppp-presentation-practice-production");
  });
  test("点号：Meaning vs. Form → meaning-vs-form（标点段折叠为单连字符，无 -- 残留）", () => {
    assert.equal(mechanicalSlugStem("Meaning vs. Form"), "meaning-vs-form");
    assert.ok(!mechanicalSlugStem("Meaning vs. Form").includes("--"));
  });
  test("连续连字符/边缘连字符压缩：' A - B ' → a-b；'-x-' → x", () => {
    assert.equal(mechanicalSlugStem(" A -- B "), "a-b");
    assert.equal(mechanicalSlugStem("-x-"), "x");
  });
  test("下划线按标点折叠：british_council → british-council（≡ British Council）", () => {
    assert.equal(mechanicalSlugStem("british_council"), "british-council");
    assert.equal(mechanicalSlugStem("British Council"), mechanicalSlugStem("british_council"));
  });
  test("中文被剔除（应走 LLM 路由而非机械 slug）；纯标点 → 空串", () => {
    assert.equal(mechanicalSlugStem("青少版新概念英语"), "");
    assert.equal(mechanicalSlugStem("///..."), "");
  });
  test("目录保留由调用方负责（slug 只算末段）；stripParens 全半角括号都去；tokenKey 保留括号内词", () => {
    assert.equal(stripParens("TBLT (Task Based Language Teaching)"), "TBLT");
    assert.equal(stripParens("新概念英语 (成人版)"), "新概念英语");
    assert.equal(stripParens("PPP (Presentation, Practice, Production)"), "PPP");
    // 括号折叠为分隔符但括号内词保留：与无括号形式同 key（第 5 级 token-set 的设计前提）
    assert.equal(tokenKey("New Concept English (Youth Edition)"), tokenKey("New Concept English Youth Edition"));
    assert.equal(tokenKey("New Concept English (Youth Edition)"), "concept-edition-english-new-youth");
  });
});

describe("① isSlugPath / hasCJK / 目标集过滤", () => {
  test("isSlugPath：合法/非法全集（与服务端允许集一致）", () => {
    assert.ok(isSlugPath("concepts/ppp-presentation-practice-production.md"));
    assert.ok(isSlugPath("entities/british_council.md")); // 下划线合法
    assert.ok(isSlugPath("a/b/c.md"));
    assert.ok(!isSlugPath("concepts/Twinkle.md"));           // 大写
    assert.ok(!isSlugPath("concepts/Real World Task.md"));   // 空格
    assert.ok(!isSlugPath("entities/PPP (Presentation, Practice, Production).md"));
    assert.ok(!isSlugPath("entities/青少版新概念英语.md"));   // 中文
    assert.ok(!isSlugPath(""));
  });
  test("hasCJK：基本区/扩展A检测，纯英文为假", () => {
    assert.ok(hasCJK("青少版"));
    assert.ok(hasCJK("人教版八年级上册-unit-1"));
    assert.ok(!hasCJK("PEP Grade 8"));
    assert.ok(!hasCJK(""));
  });
  test("selectNonSlugPages：排除 transcripts/ 与 reserved 三页，只留非 slug", () => {
    const pages = [
      { path: "concepts/Twinkle.md" },
      { path: "concepts/twinkle-2.md" },
      { path: "transcripts/中文转写.md" },        // transcripts/ 不收编（即使非 slug）
      { path: "wiki/index.md" },                  // reserved 排除（也不进孪生候选池）
      { path: "entities/Mary.md" },
    ];
    assert.deepEqual(selectNonSlugPages(pages).map((p) => p.path), ["concepts/Twinkle.md", "entities/Mary.md"]);
    assert.deepEqual(selectTwinCandidates(pages).map((p) => p.path), ["concepts/twinkle-2.md"]);
  });
});

// ══ ①b curated slug 钉死（fix round 1 F2） ══
describe("①b SLUG_OVERRIDES / resolveSlugInfo：override 优先于 LLM 短语", () => {
  const adult = { path: "entities/新概念英语 (成人版).md", title: "新概念英语 (成人版)", content: "x" };

  test("命中键：LLM 短语被忽略，slug/source 取表值；未命中键直通 buildSlugInfo", () => {
    assert.ok(needsLlmSlug(adult), "中文 stem 常规应走 LLM");
    assert.equal(slugOverrideFor(adult), "entities/new-concept-english-adult.md");
    const i = resolveSlugInfo(adult, "New Concept English Adult Version"); // 短语漂移形态
    assert.equal(i.source, "override");
    assert.equal(i.slug, "new-concept-english-adult");
    assert.equal(i.phrase, null, "override 页不携带短语（未调 LLM）");
    // 未命中键：llm 短语照常生效
    const j = resolveSlugInfo({ path: "entities/青少新概念.md", title: "青少版新概念英语" }, "Youth Edition New Concept English");
    assert.equal(j.source, "llm");
    assert.equal(j.slug, "youth-edition-new-concept-english");
    assert.equal(slugOverrideFor({ path: "concepts/别的页.md" }), null);
    // 表值与源页同目录（rename 目标 dir 取源页）且为合法 slug path——库内无同名页，不撞名翻 merge
    assert.ok(Object.entries(SLUG_OVERRIDES).every(([k, v]) => dirOf(k) === dirOf(v) && isSlugPath(v)));
  });

  test("override 页决策：无孪生 → rename 到钉死目标（slugSource=override，不随短语漂移）", () => {
    const pages = [
      adult,
      { path: "entities/new-concept-english.md", title: "新概念英语（青少版）", content: "y".repeat(1634), sources: [] },
    ];
    const { decisions, groups } = computeDecisions(pages, new Map([
      ["entities/新概念英语 (成人版).md", resolveSlugInfo(adult, "whatever drifted phrase")],
    ]));
    const d = decisions.find((x) => x.path === adult.path);
    assert.equal(d.decision, "rename");
    assert.equal(d.target, "entities/new-concept-english-adult.md");
    assert.equal(d.slugSource, "override");
    assert.equal(groups.size, 0, "钉死目标非现存页 → 不成 merge 组");
  });
});

// ══ ② 孪生探测：curated 覆盖 + 六级链 ══
describe("② findTwin 覆盖+六级链（生产 23 页真实形态）", () => {
  const T = (path, title) => ({ path, title, content: "", sources: [] });
  const twins = [
    T("concepts/pinterest.md", "Pinterest"),                                  // A exact-dir
    T("concepts/second-conditional.md", "第二类条件句"),                        // B exact-crossdir（跨目录）
    T("concepts/british_council.md", "英国文化协会"),                          // C stem-equiv（下划线）
    T("concepts/teachers_pay_teachers.md", "Teachers Pay Teachers"),           // D paren-stripped
    T("concepts/tblt.md", "TBLT (Task Based Language Teaching)"),              // D paren-stripped（多胞胎目标）
    T("entities/new-concept-english.md", "New Concept English (Youth Edition)"), // E token-set（中文短语）
    T("entities/pep-grade-8-unit-1.md", "PEP 八年级上册第一单元"),               // override（fix F1；v2 译后中文标题）
    T("entities/mary.md", "Mary"),
    T("concepts/mary.md", "Mary"),
  ];
  const info = (page, phrase) => buildSlugInfo(page, phrase);

  test("A exact-dir：concepts/Pinterest.md → concepts/pinterest.md", () => {
    const p = T("concepts/Pinterest.md", "Pinterest");
    const r = findTwin(p, info(p), twins);
    assert.equal(r.path, "concepts/pinterest.md");
    assert.equal(r.basis, "exact-dir");
    assert.equal(r.crossDir, false);
  });
  test("B exact-crossdir：entities/Second Conditional.md → concepts/second-conditional.md（同 slug 跨目录）", () => {
    const p = T("entities/Second Conditional.md", "Second Conditional");
    const r = findTwin(p, info(p), twins);
    assert.equal(r.path, "concepts/second-conditional.md");
    assert.equal(r.basis, "exact-crossdir");
    assert.equal(r.crossDir, true);
  });
  test("C stem-equiv：concepts/British Council.md → concepts/british_council.md（下划线折叠）", () => {
    const p = T("concepts/British Council.md", "英国文化协会");
    const r = findTwin(p, info(p), twins);
    assert.equal(r.path, "concepts/british_council.md");
    assert.equal(r.basis, "stem-equiv");
  });
  test("D paren-stripped：concepts/Teachers Pay Teachers (TpT).md → concepts/teachers_pay_teachers.md", () => {
    const p = T("concepts/Teachers Pay Teachers (TpT).md", "Teachers Pay Teachers (TpT)");
    const r = findTwin(p, info(p), twins);
    assert.equal(r.path, "concepts/teachers_pay_teachers.md");
    assert.equal(r.basis, "paren-stripped");
  });
  test("D paren-stripped：entities/TBLT (Task Based Language Teaching).md → concepts/tblt.md", () => {
    const p = T("entities/TBLT (Task Based Language Teaching).md", "TBLT (Task Based Language Teaching)");
    const r = findTwin(p, info(p), twins);
    assert.equal(r.path, "concepts/tblt.md");
    assert.equal(r.basis, "paren-stripped");
  });
  test("E token-set：中文页（LLM 短语）→ New Concept English (Youth Edition)（词序无关）", () => {
    const p = T("entities/青少新概念.md", "青少版新概念英语 (Youth Version of New Concept English)"); // 非 override 键
    assert.ok(needsLlmSlug(p), "中文 stem 标记 LLM");
    const i = info(p, "Youth Edition New Concept English"); // 词序打乱的 LLM 短语
    const r = findTwin(p, i, twins);
    assert.equal(r.path, "entities/new-concept-english.md");
    assert.equal(r.basis, "token-set");
    assert.equal(i.source, "llm");
    assert.equal(i.slug, "youth-edition-new-concept-english");
  });
  test("F fuzzy：同义变体（'Youth Version' vs '(Youth Edition)'）经交并比兜底命中", () => {
    const p = T("entities/青少新概念教材.md", "青少版新概念英语 (Youth Version of New Concept English)");
    const i = info(p, "Youth Version New Concept English"); // token 集不等（version≠edition）
    const r = findTwin(p, i, twins);
    assert.equal(r.path, "entities/new-concept-english.md");
    assert.equal(r.basis, "fuzzy");
  });
  test("F fuzzy 不误并：'Adult Version' 短语与 youth 页交并比 0.43 < 0.6 → 不命中", () => {
    const p = T("entities/成人新概念.md", "新概念英语 (成人版)");
    const r = findTwin(p, info(p, "New Concept English Adult Version"), twins);
    assert.equal(r, null);
  });
  test("TWIN_OVERRIDES：curated 键优先返回（basis=override），目标不在池则回落常规链", () => {
    const p = T("entities/青少版新概念英语.md", "青少版新概念英语 (Youth Version of New Concept English)");
    const r = findTwin(p, info(p, "Whatever Phrase"), twins);
    assert.equal(r.path, "entities/new-concept-english.md");
    assert.equal(r.basis, "override");
    // 目标不在候选池 → 告警 + 回落（短语无命中 → null）
    const logged = [];
    const r2 = findTwin({ path: "entities/Flipped Classroom.md", title: "Flipped Classroom" }, buildSlugInfo({ path: "entities/Flipped Classroom.md", title: "Flipped Classroom" }), [], (m) => logged.push(m));
    assert.equal(r2, null);
    assert.ok(logged.some((l) => l.includes("覆盖目标不在候选池")));
  });
  test("TWIN_OVERRIDES 人教版（fix F1）：LLM 短语偏离 'PEP Grade 8 Unit 1' 仍钉死 merge 目标", () => {
    const p = T("entities/人教版八年级上册-unit-1.md", "人教版八年级上册 Unit 1");
    assert.ok(needsLlmSlug(p), "混合中文 stem 走 LLM");
    // apply 时短语重起非确定——偏离形态 slug 化后不再是 pep-grade-8-unit-1，
    // exact-dir/stem 级必失配（对照：无钉死则误判 rename，新建与现存 pep 页重复的页）
    const i = info(p, "PEP Grade Eight Textbook Unit One");
    assert.notEqual(i.slug, "pep-grade-8-unit-1");
    // curated 钉死：短语无关，恒 merge 到现存 pep 页（basis=override）
    const r = findTwin(p, i, twins);
    assert.equal(r.path, "entities/pep-grade-8-unit-1.md");
    assert.equal(r.basis, "override");
  });
  test("无孪生：concepts/Twinkle.md → null（rename 语义）", () => {
    const p = T("concepts/Twinkle.md", "Twinkle（闪烁）");
    assert.equal(findTwin(p, info(p), twins), null);
  });
  test("歧义保护：title 级两个不同目标（mary 双页）→ 跳过该级返回 null，宁 rename 不错并", () => {
    const p = T("entities/Who.md", "Mary"); // slug 化后无 path 级命中，仅 title 级撞 mary 双页
    const logged = [];
    const r = findTwin(p, info(p), twins, (m) => logged.push(m));
    assert.equal(r, null);
    assert.ok(logged.some((l) => l.includes("孪生歧义")));
  });
});

// ══ ③④ 决策表 + 多胞胎 + 撞车 ══
describe("③④ computeDecisions：rename/merge/多胞胎/撞车", () => {
  const mkPages = () => [
    // TBLT 三页：target 724 / concepts/TBLT.md 946 / entities/(...) 2450
    { path: "concepts/tblt.md", title: "TBLT (Task Based Language Teaching)", content: "x".repeat(724), sources: ["s1"], page_type: "concept" },
    { path: "concepts/TBLT.md", title: "TBLT (Task Based Language Teaching)", content: "x".repeat(946), sources: ["s2"], page_type: "concept" },
    { path: "entities/TBLT (Task Based Language Teaching).md", title: "TBLT (Task Based Language Teaching)", content: "x".repeat(2450), sources: ["s3"], page_type: "entity" },
    // 无孪生 rename ×2（同目录同 slug 撞车：全角括号与半角大写形态算出同一 twinkle）
    { path: "concepts/Twinkle.md", title: "Twinkle（闪烁）", content: "t".repeat(100), sources: ["a"] },
    { path: "concepts/（Twinkle）.md", title: "Twinkle（闪烁）", content: "t".repeat(80), sources: ["b"] },
    // 有孪生 merge（exact-dir）
    { path: "concepts/pinterest.md", title: "Pinterest", content: "p".repeat(364), sources: ["s4"] },
    { path: "concepts/Pinterest.md", title: "Pinterest", content: "p".repeat(349), sources: ["s5"] },
    // 孪生 title 为空 → 取非 slug 页 title
    { path: "entities/jack.md", title: null, content: "j".repeat(10), sources: [] },
    { path: "entities/Jack.md", title: "Jack", content: "j".repeat(130), sources: ["s6"] },
  ];
  const infos = (pages) => new Map(selectNonSlugPages(pages).map((p) => [p.path, buildSlugInfo(p)]));

  test("多胞胎迭代合并到同一 slug 目标：winner=长者（entities 2450），sources 并集，title 保留孪生现值", () => {
    const pages = mkPages();
    const { decisions, groups } = computeDecisions(pages, infos(pages));
    const g = groups.get("concepts/tblt.md");
    assert.ok(g, "tblt 组存在");
    assert.equal(g.members.length, 3, "target + 2 非 slug 成员");
    assert.equal(g.winnerPath, "entities/TBLT (Task Based Language Teaching).md");
    assert.deepEqual(g.dropped.map((d) => d.path).sort(), ["concepts/TBLT.md", "concepts/tblt.md"]);
    // fix F5：dropped 增记出链清单（[[...]] 提取，graph.rs 语义——本组正文无 wikilink → 空数组）
    assert.ok(g.dropped.every((d) => Array.isArray(d.links)));
    assert.deepEqual(g.sources.sort(), ["s1", "s2", "s3"]);
    assert.equal(g.title, "TBLT (Task Based Language Teaching)");
    // 两个非 slug 页 decision 均 merge 且 target 一致
    const ds = decisions.filter((d) => d.path.includes("TBLT"));
    assert.equal(ds.length, 2);
    assert.ok(ds.every((d) => d.decision === "merge" && d.target === "concepts/tblt.md"));
  });

  test("slug 撞车去重：同目录两个无孪生 Twinkle 同算 twinkle → 第二个 -2 并告警", () => {
    const pages = mkPages();
    const { decisions, warnings } = computeDecisions(pages, infos(pages));
    const renames = decisions.filter((d) => d.decision === "rename");
    assert.equal(renames.length, 2);
    assert.deepEqual(renames.map((d) => d.target).sort(), ["concepts/twinkle-2.md", "concepts/twinkle.md"]);
    assert.ok(warnings.some((w) => w.includes("concepts/twinkle-2.md") && w.includes("撞车")));
  });

  test("rename 目标撞现存 slug 页：A2 级 exact-crossdir 先收编为 merge（不可能 POST 409）", () => {
    const pages = [
      { path: "concepts/real.md", title: "Real", content: "r", sources: [] },
      { path: "entities/Real.md", title: "Real", content: "r3", sources: [] },
    ];
    const { decisions } = computeDecisions(pages, new Map([
      ["entities/Real.md", buildSlugInfo(pages[1])],
    ]));
    const d = decisions.find((x) => x.path === "entities/Real.md");
    assert.equal(d.decision, "merge");
    assert.equal(d.target, "concepts/real.md");
    assert.equal(d.basis, "exact-crossdir");
  });

  test("孪生 title 为空：merge 组 title 取非 slug 页现值；缺 slugInfo → needs-review", () => {
    const pages = mkPages();
    const { groups, decisions } = computeDecisions(pages, infos(pages));
    assert.equal(groups.get("entities/jack.md").title, "Jack");
    assert.equal(decisions.filter((d) => d.decision === "needs-review").length, 0);
    // 无 info → 全部 needs-review（6 个非 slug 页）
    const r2 = computeDecisions(pages, new Map());
    assert.equal(r2.decisions.filter((d) => d.decision === "needs-review").length, 6);
    assert.equal(r2.warnings.length, 6);
  });

  test("mergeSources：多数组并集去重、保序、忽略非字符串", () => {
    assert.deepEqual(mergeSources(["a", "b"], ["b", "c"], undefined, ["a", 1]), ["a", "b", "c"]);
    assert.deepEqual(mergeSources(), []);
  });

  test("needsLlmSlug：中文/混合 stem 与纯标点 stem 标记；英文形态不标记", () => {
    assert.ok(needsLlmSlug({ path: "entities/青少版新概念英语.md" }));
    assert.ok(needsLlmSlug({ path: "concepts/(!!!).md" }));
    assert.ok(!needsLlmSlug({ path: "concepts/Twinkle.md" }));
    assert.ok(needsLlmSlug({ path: "entities/人教版八年级上册-unit-1.md" }), "混合中文 stem 标记");
  });
});

// ══ ⑤ 入链改写 ══
describe("⑤ rewriteLinksToPlan", () => {
  // buildLinkCtx 的 normStem first-wins 按数组序（脚本侧传 path 排序页表——大写非 slug 页排在
  // 小写 slug 页前，链接解析到旧页从而触发改写；这里同样以排序序构造）
  const pages = [
    { path: "concepts/Pinterest.md", title: "Pinterest" },
    { path: "concepts/other.md", title: "Other" },
    { path: "entities/new-concept-english.md", title: "New Concept English (Youth Edition)" },
    { path: "entities/青少版新概念英语.md", title: "青少版新概念英语 (Youth Version of New Concept English)" },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const ctx = buildLinkCtx(pages, {}, []);
  const finalPath = new Map([
    ["concepts/Pinterest.md", "concepts/pinterest.md"],
    ["entities/青少版新概念英语.md", "entities/new-concept-english.md"],
  ]);
  const finalTitle = new Map([
    ["concepts/pinterest.md", "Pinterest"],
    ["entities/new-concept-english.md", "New Concept English (Youth Edition)"],
  ]);

  test("指向旧 path 的链接 → [[新slug|现标题]]；其他链接原样", () => {
    const body = "参见 [[Pinterest]] 与 [[青少版新概念英语]]，另有 [[Other]]。";
    const { content, changes } = rewriteLinksToPlan(body, ctx, finalPath, finalTitle);
    assert.equal(content, "参见 [[pinterest|Pinterest]] 与 [[new-concept-english|New Concept English (Youth Edition)]]，另有 [[Other]]。");
    assert.equal(changes.length, 2);
  });

  test("已有 alias 保留（作者选择的显示文本）；锚点保留", () => {
    const body = "[[Pinterest|图片站]] 和 [[青少版新概念英语#Unit 1|教材]]";
    const { content } = rewriteLinksToPlan(body, ctx, finalPath, finalTitle);
    assert.equal(content, "[[pinterest|图片站]] 和 [[new-concept-english#Unit 1|教材]]");
  });

  test("fence 内不动；悬空不动；幂等（改写后再跑一遍无变化）", () => {
    const body = "```\n[[Pinterest]]\n```\n外层 [[Pinterest]] 与 [[悬空目标]]";
    const once = rewriteLinksToPlan(body, ctx, finalPath, finalTitle);
    assert.equal(once.content, "```\n[[Pinterest]]\n```\n外层 [[pinterest|Pinterest]] 与 [[悬空目标]]");
    const twice = rewriteLinksToPlan(once.content, ctx, finalPath, finalTitle);
    assert.equal(twice.content, once.content, "二次改写幂等（新 path 不在 finalPath 键中）");
    assert.equal(twice.changes.length, 0);
  });

  test("链接指向孪生目标自身（解析到 slug 页）→ 不改写（最小 diff）", () => {
    const body = "[[new-concept-english]]";
    const { content, changes } = rewriteLinksToPlan(body, ctx, finalPath, finalTitle);
    assert.equal(content, body);
    assert.equal(changes.length, 0);
  });
});

// ══ ⑥ 图模拟 ══
describe("⑥ simulateGraphStats / extractGraphWikilinks（graph.rs 近似）", () => {
  test("extractGraphWikilinks：target 在 | 前、trim、锚点保留在 target 内（graph.rs 语义）", () => {
    assert.deepEqual(extractGraphWikilinks("[[A]] [[B|别名]] [[C#锚]]"), ["A", "B", "C#锚"]);
    assert.deepEqual(extractGraphWikilinks("```js\nconst x='[[A]]';\n```"), ["A"], "graph.rs 无 fence 感知（近似忠实）");
  });

  test("graphNorm：小写 + 单空格→连字符（空白 run 不折叠，Rust .replace(' ',\"-\") 语义）", () => {
    assert.equal(graphNorm("TBLT Lesson  Structure"), "tblt-lesson--structure");
    assert.equal(graphNorm("Mary"), "mary");
  });

  test("边数/悬空：stem 解析、title 兜底、title 碰撞除名、自环跳过、无向去重", () => {
    const pages = [
      { path: "a.md", title: "A", page_type: "concept", content: "[[b]] [[B]] [[q]] [[a]]" }, // b: stem；B: title；q 悬空；a 自环
      { path: "b/x.md", title: "B", page_type: "concept", content: "[[A]]" },                // A → a.md（同边无向去重）
      { path: "c.md", title: "T", page_type: "concept", content: "[[T]] [[t]]" },            // title 撞 c2 → 除名 → 悬空
      { path: "c2.md", title: "T", page_type: "concept", content: "" },
      { path: "q.md", title: "Q", page_type: "query", content: "[[a]]" },                    // query 页不计
    ];
    const s = simulateGraphStats(pages);
    assert.equal(s.nodes, 4, "query 页排除");
    assert.equal(s.edges, 1, "a↔b 一条无向边（多链接/反向去重）");
    assert.equal(s.resolvedLinks, 4, "a→b(stem) + a→B(title) + b→A(title) + c→t(stem)");
    assert.equal(s.danglingLinks, 3, "q + T + T（title 碰撞除名后两处悬空）");
  });

  test("锚点链接不可解析（graph.rs 语义：normalize 不去锚点）→ 悬空", () => {
    const s = simulateGraphStats([
      { path: "a.md", title: "A", page_type: "concept", content: "[[a#sec]]" },
    ]);
    assert.equal(s.danglingLinks, 1);
    assert.equal(s.edges, 0);
  });

  test("执行前后对比：rename 后归一化形态链接重新可解析（悬空下降、边建立）", () => {
    const before = [
      { path: "concepts/Meaning vs. Form.md", title: "意义与形式", page_type: "concept", content: "# 意义与形式\n" },
      { path: "entities/x.md", title: "X", page_type: "entity", content: "看 [[meaning vs form]] 与 [[Missing Page]]。" },
    ];
    // [[meaning vs form]]：graphNorm → "meaning-vs-form"；旧 stem 键为 "meaning-vs.-form"（句点保留）→ 改名前悬空
    const decisions = [
      { path: "concepts/Meaning vs. Form.md", title: "意义与形式", contentLen: 8, decision: "rename", target: "concepts/meaning-vs-form.md" },
    ];
    const groups = new Map();
    const after = composePostPlanPages(before, decisions, groups, (p) => p.content);
    const sBefore = simulateGraphStats(before);
    const sAfter = simulateGraphStats(after);
    assert.equal(sBefore.danglingLinks, 2);
    assert.equal(sBefore.edges, 0);
    assert.equal(sAfter.danglingLinks, 1, "rename 后 [[meaning vs form]] 命中新 stem");
    assert.equal(sAfter.edges, 1);
    assert.ok(after.some((p) => p.path === "concepts/meaning-vs-form.md"), "rename 页以新 path 出现");
    assert.ok(!after.some((p) => p.path === "concepts/Meaning vs. Form.md"), "旧 path 移除");
  });

  test("composePostPlanPages：merge 组目标页换 winner 正文与组 title；落败者记 dropped 由调用方备份", () => {
    const before = [
      { path: "concepts/tblt.md", title: "TBLT", page_type: "concept", content: "short", sources: ["s1"] },
      { path: "entities/TBLT (Task).md", title: "TBLT", page_type: "entity", content: "much longer winner", sources: ["s2"] },
    ];
    const decisions = [
      { path: "entities/TBLT (Task).md", title: "TBLT", contentLen: 18, decision: "merge", target: "concepts/tblt.md" },
    ];
    const groups = new Map([
      ["concepts/tblt.md", {
        target: "concepts/tblt.md",
        members: [
          { path: "entities/TBLT (Task).md", title: "TBLT", content: "much longer winner", sources: ["s2"] },
          { path: "concepts/tblt.md", title: "TBLT", content: "short", sources: ["s1"] },
        ],
        winnerPath: "entities/TBLT (Task).md",
        title: "TBLT",
        dropped: [{ path: "concepts/tblt.md", len: 5 }],
        sources: ["s1", "s2"],
      }],
    ]);
    const after = composePostPlanPages(before, decisions, groups, (p) => p.content);
    const target = after.find((p) => p.path === "concepts/tblt.md");
    assert.equal(target.content, "much longer winner", "目标页换 winner 正文");
    assert.ok(!after.some((p) => p.path === "entities/TBLT (Task).md"), "旧页移除");
  });
});

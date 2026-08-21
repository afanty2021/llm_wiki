// docs/superpowers/deploy/lib/translate-core.test.mjs
//
// translate-core.mjs 单元测试（m3-impl-review W4）。
// 跑法（主）：node --test docs/superpowers/deploy/lib/*.test.mjs
//   ⚠ 目录形式 node --test <dir> 在 Node v26.5 把目录当模块入口（MODULE_NOT_FOUND），须用 glob。
// 双 runner 兼容：根 vitest 4 会扫到 docs/**/*.test.mjs 但不收集 node:test 用例
// （报 "No test suite found" 破坏 npm test），故在 vitest 环境（process.env.VITEST）
// 下改 import vitest 的 test/describe；断言统一 node:assert/strict（两 runner 通用）。
// 本文件零外部依赖、零网络/文件副作用。
//
// 四类核心用例（对应评审 W4 验收）：
//  ① 碰撞：两组同译名 → 整组恒等 + 记录
//  ② 别名保留：已有 [[slug|alias]] 不二次改写
//  ③ 悬空链接：目标不在页表 → 原样
//  ④ 占位符容错：丢失/乱序/LLM 部分改写 → 拒写（throw）或按容错链还原
// 加：zhRatio 边界 + 目标页过滤（transcripts/reserved/中文占比排除）。
// 加 ⑤ 输出闸（Fix round 3）：译文含 thinking 痕迹 / 残留 ⟦⟧ 占位符字符 → 拒写。

import assert from "node:assert/strict";

const { test, describe } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

import {
  RESERVED_PAGES, ZH_RATIO_SKIP, LEGACY_LINK_RECOVERY,
  zhRatio, isChinesePage, normKey, pathStem,
  buildLinkCtx, resolveTargetPath, renderWikilink,
  maskWikilinks, unmaskWikilinks, rewriteLinksInBody,
  detectTitleCollisions, selectTranslationTargets, hasThinkingLeakOrSlotResidue,
} from "./translate-core.mjs";

// ── 测试夹具：迷你页表（concepts/entities + 保留页 + 转写页） ──
const PAGES = [
  { path: "concepts/ielts-reading.md", title: "IELTS Reading" },
  { path: "concepts/kwl-chart.md", title: "KWL Chart" },
  { path: "concepts/cooperative-learning.md", title: "Cooperative Learning" },
  { path: "concepts/scaffolding.md", title: "Scaffolding" },
  { path: "concepts/ambiguous.md", title: "Ambiguous" },
  { path: "concepts/ambiguous-2.md", title: "Ambiguous" }, // 同精确 title → 歧义
  { path: "entities/mary.md", title: "Mary" },
  { path: "transcripts/116-3f89a942.md", title: "116. 如何准备公开课" },
  { path: "wiki/index.md", title: "Index" },
];
/** 常规 titleMap：IELTS Reading→IELTS阅读（与 LEGACY_LINK_RECOVERY 值相同，模拟碰撞组丢失场景外的正常译名） */
const TITLE_MAP = { "IELTS Reading": "IELTS阅读", "KWL Chart": "KWL图表" };

const ctx = buildLinkCtx(PAGES, TITLE_MAP, []);

// ══ ① 碰撞（I4）：两组同译名 → 整组恒等 + 记录 ══
describe("① 标题碰撞 detectTitleCollisions", () => {
  test("同中文译名：整组恒等化（保持英文标题）并记录 collisions", () => {
    const pages = [
      { path: "concepts/a.md", title: "Reading Fluency" },
      { path: "concepts/b.md", title: "Reading Proficiency" },
      { path: "concepts/c.md", title: "Unrelated Title" },
    ];
    const titleMap = { "Reading Fluency": "阅读流利度", "Reading Proficiency": "阅读流利度", "Unrelated Title": "无关标题" };
    const logged = [];
    const collisions = detectTitleCollisions(pages, titleMap, (m) => logged.push(m));

    assert.equal(collisions.length, 1, "一组碰撞");
    assert.equal(collisions[0].normalizedTitle, "阅读流利度");
    assert.deepEqual(
      collisions[0].pages.map((m) => m.path).sort(),
      ["concepts/a.md", "concepts/b.md"],
    );
    // 整组恒等：titleMap 被就地覆盖为原英文标题
    assert.equal(titleMap["Reading Fluency"], "Reading Fluency");
    assert.equal(titleMap["Reading Proficiency"], "Reading Proficiency");
    // 记录覆盖前的译后终值（translated），供 revTitle 补建
    assert.equal(collisions[0].pages.find((m) => m.path === "concepts/a.md").translated, "阅读流利度");
    // 无碰撞页不受影响
    assert.equal(titleMap["Unrelated Title"], "无关标题");
    // 日志：组告警 + 逐页清单
    assert.ok(logged.some((l) => l.includes("I4 碰撞") && l.includes("2 页共享")));
    assert.ok(logged.some((l) => l.includes("concepts/a.md")));
  });

  test("归一化碰撞（译名大小写/空白差异同键）：同样整组恒等", () => {
    const pages = [
      { path: "concepts/x.md", title: "Reading Fluency" },
      { path: "concepts/y.md", title: "Reading Speed" },
    ];
    // 两个不同原标题的译名经 normKey 折叠为同键：小写 + 空白 run→连字符
    // （"Task Based Learning" 与 "task  based  learning" → 均 "task-based-learning"）
    const titleMap = { "Reading Fluency": "Task Based Learning", "Reading Speed": "task  based  learning" };
    const collisions = detectTitleCollisions(pages, titleMap);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].normalizedTitle, "task-based-learning");
    assert.equal(titleMap["Reading Fluency"], "Reading Fluency");
    assert.equal(titleMap["Reading Speed"], "Reading Speed");
  });

  test("无碰撞：titleMap 原样、collisions 空", () => {
    const titleMap = { A: "甲", B: "乙" };
    const collisions = detectTitleCollisions(
      [{ path: "concepts/a.md", title: "A" }, { path: "concepts/b.md", title: "B" }],
      titleMap,
    );
    assert.equal(collisions.length, 0);
    assert.deepEqual(titleMap, { A: "甲", B: "乙" });
  });
});

// ══ ② 别名保留：已有 [[slug|alias]] 不二次改写 ══
describe("② 别名保留 renderWikilink / unmaskWikilinks", () => {
  test("已有 alias 的链接：alias 原样保留，仅目标规范化为 slug", () => {
    const slot = { kind: "wl", raw: "[[IELTS Reading|我读过的考试]]", target: "IELTS Reading", anchor: "", alias: "我读过的考试" };
    assert.equal(renderWikilink(slot, ctx), "[[ielts-reading|我读过的考试]]");
  });

  test("alias 为空串：视为无 alias，用 effTitle 中文标签", () => {
    const slot = { kind: "wl", raw: "[[IELTS Reading|]]", target: "IELTS Reading", anchor: "", alias: "" };
    assert.equal(renderWikilink(slot, ctx), "[[ielts-reading|IELTS阅读]]");
  });

  test("无 alias：标签取 titleMap 译名（effTitle），锚点保留", () => {
    const slot = { kind: "wl", raw: "[[KWL Chart#section]]", target: "KWL Chart", anchor: "#section", alias: undefined };
    assert.equal(renderWikilink(slot, ctx), "[[kwl-chart#section|KWL图表]]");
  });

  test("别名形式经 rewriteLinksInBody 幂等：改写一次后再次改写不再变化", () => {
    const body = "参见 [[KWL Chart]] 与 [[IELTS Reading|我读过的考试]]。";
    const once = rewriteLinksInBody(body, ctx);
    assert.equal(once, "参见 [[kwl-chart|KWL图表]] 与 [[ielts-reading|我读过的考试]]。");
    assert.equal(rewriteLinksInBody(once, ctx), once, "二次改写幂等");
  });

  test("未译目标页（titleMap 无映射）：标签回落原英文 title", () => {
    const slot = { kind: "wl", raw: "[[Scaffolding]]", target: "Scaffolding", anchor: "", alias: undefined };
    assert.equal(renderWikilink(slot, ctx), "[[scaffolding|Scaffolding]]");
  });
});

// ══ ③ 悬空链接：目标不在页表 → 原样 ══
describe("③ 悬空链接原样", () => {
  test("resolveTargetPath 解析失败 → null，renderWikilink 返回 raw", () => {
    assert.equal(resolveTargetPath(ctx, "No Such Page"), null);
    const slot = { kind: "wl", raw: "[[No Such Page]]", target: "No Such Page", anchor: "", alias: undefined };
    assert.equal(renderWikilink(slot, ctx), "[[No Such Page]]");
  });

  test("悬空链接经 mask→unmask 全链路保持原样（含锚点/别名）", () => {
    const body = "看 [[Dangling Target#x|别名]] 和 [[KWL Chart]]";
    const { masked, slots } = maskWikilinks(body);
    assert.equal(masked, "看 \u27e6WL0\u27e7 和 \u27e6WL1\u27e7");
    const out = unmaskWikilinks(masked, slots, ctx); // 译文未动占位符 = 原样送回
    assert.equal(out, "看 [[Dangling Target#x|别名]] 和 [[kwl-chart|KWL图表]]");
  });

  test("rewriteLinksInBody：悬空链接不重写，fence 内链接不动", () => {
    const body = "```\n[[KWL Chart]] in code\n```\nouter [[Dangling]]";
    assert.equal(rewriteLinksInBody(body, ctx), body);
  });
});

// ══ ④ 占位符容错：丢失 → 拒写；乱序/部分改写行为锚定 ══
describe("④ 占位符容错 unmaskWikilinks", () => {
  const mk = () => maskWikilinks("[[KWL Chart]] mid [[Dangling]]");

  test("占位符丢失（LLM 删改受保护内容）→ throw 拒写", () => {
    const { slots } = mk();
    assert.throws(
      () => unmaskWikilinks("译文没有占位符了", slots, ctx),
      /译文丢失占位符 \u27e6WL0\u27e7/,
    );
  });

  test("LLM 把 ⟦WLn⟧ 改写成 [[WLn]]（原占位符已丢）→ 同样拒写 throw", () => {
    const { slots } = mk();
    // 内联版容错链只救「⟦WLn⟧ 在且额外混入 [[WLn]]」的复制型改写；
    // 占位符本体丢失必须拒写（不能静默接受被翻译过的链接）。
    assert.throws(() => unmaskWikilinks("看 [[WL0]] 与 [[WL1]]", slots, ctx), /丢失占位符/);
  });

  test("占位符乱序出现：按 token 全局替换，与出现顺序无关", () => {
    const { masked, slots } = mk();
    const swapped = masked.includes("\u27e6WL0\u27e7")
      ? masked.replace("\u27e6WL0\u27e7", "\u00a4").replace("\u27e6WL1\u27e7", "\u27e6WL0\u27e7").replace("\u00a4", "\u27e6WL1\u27e7")
      : masked;
    const out = unmaskWikilinks(swapped, slots, ctx);
    assert.ok(out.includes("[[kwl-chart|KWL图表]]"));
    assert.ok(out.includes("[[Dangling]]"));
  });

  test("部分改写：译文只保留 ⟦WL1⟧ 丢了 ⟦WL0⟧ → throw（逐槽校验，不静默半成品）", () => {
    const { slots } = mk();
    assert.throws(() => unmaskWikilinks("只留 \u27e6WL1\u27e7", slots, ctx), /丢失占位符 \u27e6WL0\u27e7/);
  });

  test("复制型混写：⟦WL0⟧ 在、额外混入 [[WL0]] → 前者按解析改写，后者按 raw 还原", () => {
    const { masked, slots } = maskWikilinks("[[KWL Chart]]");
    const out = unmaskWikilinks(`${masked} 复制 [[WL0]]`, slots, ctx);
    assert.equal(out, "[[kwl-chart|KWL图表]] 复制 [[KWL Chart]]");
  });

  test("幻觉序号 [[WL9]]（槽不存在）→ 原样保留", () => {
    const { masked, slots } = maskWikilinks("[[KWL Chart]]");
    const out = unmaskWikilinks(`${masked} 幻觉 [[WL9]]`, slots, ctx);
    assert.equal(out, "[[kwl-chart|KWL图表]] 幻觉 [[WL9]]");
  });

  test("code 槽原样还原（fence 内 [[..]] 已被整体 mask，不经链接改写）", () => {
    const body = "```js\nconst x = '[[KWL Chart]]';\n```";
    const { masked, slots } = maskWikilinks(body);
    assert.equal(masked, "\u27e6C0\u27e7");
    assert.equal(unmaskWikilinks(masked, slots, ctx), body);
  });
});

// ══ ⑤ 输出闸（Fix round 3）：thinking 痕迹 / 残留占位符字符 → 拒写 ══
// 根因复盘：Qwen serving 思考模式偶发以纯文本吐 "Here's a thinking process:" 前导 +
// prompt 回显当正文（非 <think> 标签，stripThink 救不了），且正文占位符未还原——
// live 污染 concepts/ccq.md、concepts/class-motto.md 两页。
describe("⑤ 输出闸 hasThinkingLeakOrSlotResidue", () => {
  test("译文含 ⟦ 或 ⟧（还原后残留占位符字符）→ true 拒写", () => {
    assert.equal(hasThinkingLeakOrSlotResidue("正文残留 \u27e6WL9\u27e7 幻觉序号"), true);
    assert.equal(hasThinkingLeakOrSlotResidue("只有右括号 \u27e7"), true);
  });

  test("thinking 痕迹前导（实测污染形态 + 大小写变体）→ true 拒写", () => {
    assert.equal(hasThinkingLeakOrSlotResidue("Here's a thinking process:\n\n1.  **Analyze User Input:**"), true);
    assert.equal(hasThinkingLeakOrSlotResidue("here's a THINKING PROCESS"), true);
    assert.equal(hasThinkingLeakOrSlotResidue("Thinking Process: 首先分析……"), true);
  });

  test("干净译文（含正常还原的 [[slug|标签]] 链接）/ 空串 / null → false 放行", () => {
    assert.equal(hasThinkingLeakOrSlotResidue("# 合作学习\n\n参见 [[kwl-chart|KWL图表]]。"), false);
    assert.equal(hasThinkingLeakOrSlotResidue(""), false);
    assert.equal(hasThinkingLeakOrSlotResidue(null), false);
  });

  test("全链路：LLM 泄漏 thinking 前导但占位符齐全 → unmask 放行，闸兜底拒写", () => {
    const { masked, slots } = maskWikilinks("[[KWL Chart]] 正文");
    const polluted = `Here's a thinking process:\n${masked}`;
    const out = unmaskWikilinks(polluted, slots, ctx); // 占位符都在，unmask 不报错
    assert.ok(hasThinkingLeakOrSlotResidue(out), "闸捕获 thinking 前导");
  });

  test("全链路：LLM 幻觉多吐 ⟦WL9⟧（unmask 容错不还原）→ 闸兜底拒写", () => {
    const { masked, slots } = maskWikilinks("[[KWL Chart]]");
    const out = unmaskWikilinks(`${masked} 幻觉 \u27e6WL9\u27e7`, slots, ctx);
    assert.ok(out.includes("[[kwl-chart|KWL图表]]"));
    assert.ok(hasThinkingLeakOrSlotResidue(out), "闸捕获残留占位符");
  });
});

// ══ 加：LEGACY_LINK_RECOVERY 应用 ══
describe("LEGACY_LINK_RECOVERY 反查兜底", () => {
  test("全部 6 对进入 revTitle；历史 [[中文标题]] 链接解析回英文目标页", () => {
    for (const [zh, en] of Object.entries(LEGACY_LINK_RECOVERY)) {
      assert.equal(ctx.revTitle.get(zh), en, `revTitle[${zh}]`);
    }
    // 目标页本体未翻译（DB 标题英文、titleMap 无映射）→ 裸中文链接仍可解析
    const slot = { kind: "wl", raw: "[[合作学习]]", target: "合作学习", anchor: "", alias: undefined };
    assert.equal(renderWikilink(slot, ctx), "[[cooperative-learning|Cooperative Learning]]");
  });

  test("titleMap 已含同名中文值时不覆盖（recovery 仅补缺）", () => {
    const c = buildLinkCtx(PAGES, { "IELTS Reading": "IELTS阅读" }, []);
    assert.equal(c.revTitle.get("IELTS阅读"), "IELTS Reading");
    const c2 = buildLinkCtx(PAGES, {}, []);
    assert.equal(c2.revTitle.get("IELTS阅读"), "IELTS Reading", "无 titleMap 时由 LEGACY 兜底");
  });

  test("collisions 记录补建反查：恒等化丢失的中文值仍可回溯", () => {
    const collisions = [{ normalizedTitle: "阅读流利度", pages: [
      { path: "concepts/a.md", title: "Reading Fluency", translated: "阅读流利度" },
    ] }];
    const c = buildLinkCtx(PAGES, { "Reading Fluency": "Reading Fluency" }, collisions);
    assert.equal(c.revTitle.get("阅读流利度"), "Reading Fluency");
    const slot = { kind: "wl", raw: "[[阅读流利度]]", target: "阅读流利度", anchor: "", alias: undefined };
    // PAGES 无该目标页 → 悬空原样（revTitle 命中但 exact/normTitle/normStem 均未命中）
    assert.equal(renderWikilink(slot, c), "[[阅读流利度]]");
  });
});

// ══ 加：zhRatio 边界 ══
describe("zhRatio / isChinesePage 边界", () => {
  test("空输入与纯空白 → 0（nonSpace=0 不除零）", () => {
    assert.equal(zhRatio(""), 0);
    assert.equal(zhRatio(null), 0);
    assert.equal(zhRatio(undefined), 0);
    assert.equal(zhRatio("   \n\t "), 0);
  });

  test("纯英文 → 0；纯中文 → 1；混合按非空白字符计（空格不入分母）", () => {
    assert.equal(zhRatio("Plain English text"), 0);
    assert.equal(zhRatio("中文"), 1);
    // "Hello 世界"：非空白 7 字符（空格不计），CJK 2 → 2/7
    assert.equal(zhRatio("Hello 世界"), 2 / 7);
  });

  test("CJK 扩展区（U+3400 扩A / U+4E00 基本 / 兼容区）均计数", () => {
    assert.equal(zhRatio("\u3400"), 1); // 㐀 CJK 扩 A
    assert.equal(zhRatio("\u4e00"), 1); // 一 CJK 基本
    assert.ok(zhRatio("\uf900") === 1); // 豈 CJK 兼容
  });

  test("日文假名/韩文不算 CJK 汉字区间", () => {
    assert.equal(zhRatio("あいう"), 0);
    assert.equal(zhRatio("한국어"), 0);
  });

  test("isChinesePage 阈值边界：> ZH_RATIO_SKIP 才排除（严格大于）", () => {
    assert.equal(ZH_RATIO_SKIP, 0.6);
    assert.ok(!isChinesePage("aa中中中"), "恰 0.6（3/5）→ 不排除");
    assert.ok(isChinesePage("a中中"), "0.667（2/3）→ 排除");
    assert.ok(!isChinesePage("English only"));
  });
});

// ══ 加：目标页过滤 ══
describe("selectTranslationTargets 路径过滤", () => {
  const pages = [
    { path: "concepts/a.md", title: "A", content: "body" },
    { path: "transcripts/116-3f89a942.md", title: "转写页", content: "正文" },      // transcripts/ 排除
    { path: "wiki/index.md", title: "Index", content: "body" },                      // reserved 排除
    { path: "concepts/done.md", title: "Done", content: "body" },                    // completed 排除
    { path: "concepts/empty.md", title: "Empty", content: "   \n " },                // 空内容排除
    { path: "concepts/nulltitle.md", title: null, content: "body" },                 // M2: title null
    { path: "concepts/chinese.md", title: "中文页", content: "全是中文正文" },       // 中文占比（主循环运行时排除）
  ];

  test("transcripts/reserved/completed/空内容 排除；null title 单列（M2）", () => {
    const { targets, nullTitle } = selectTranslationTargets(pages, { completed: new Set(["concepts/done.md"]) });
    assert.deepEqual(targets.map((p) => p.path).sort(), ["concepts/a.md", "concepts/chinese.md"]);
    assert.deepEqual(nullTitle.map((p) => p.path), ["concepts/nulltitle.md"]);
  });

  test("RESERVED_PAGES 恰为 ingest 重建三页", () => {
    assert.deepEqual([...RESERVED_PAGES].sort(), ["wiki/index.md", "wiki/log.md", "wiki/overview.md"]);
  });

  test("content null 按空内容排除（?? 兜底）", () => {
    const { targets } = selectTranslationTargets([{ path: "concepts/x.md", title: "X", content: null }]);
    assert.equal(targets.length, 0);
  });

  test("中文占比页仍进目标集（由主循环逐页 GET 后 isChinesePage 排除，过滤本身不看内容语言）", () => {
    const { targets } = selectTranslationTargets(pages, { completed: new Set() });
    assert.ok(targets.some((p) => p.path === "concepts/chinese.md"));
    assert.ok(isChinesePage(pages.find((p) => p.path === "concepts/chinese.md").content));
  });
});

// ══ 加：normKey / pathStem 与服务端对齐 ══
describe("normKey / pathStem", () => {
  test("normKey：小写 + 空白折叠为连字符", () => {
    assert.equal(normKey("KWL Chart"), "kwl-chart");
    assert.equal(normKey("  Task   Based  "), "task-based");
    assert.equal(normKey(null), "");
  });
  test("pathStem：末段去 .md", () => {
    assert.equal(pathStem("concepts/ielts-reading.md"), "ielts-reading");
    assert.equal(pathStem("wiki/index.md"), "index");
    assert.equal(pathStem("noext"), "noext");
  });
});

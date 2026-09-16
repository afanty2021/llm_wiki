/**
 * 课件样张 fixture（worksheet-fixture 一处两用先例）：真渲染冒烟输入 +
 * zip 解包文字准确性断言源。内容取库内常见教学主题（一般过去时）。
 */
import type { PptxDoc } from "../src/pptx.js"

export const PPTX_FIXTURE: PptxDoc = {
  title: "The Past Simple Tense",
  subtitle: "六年级 · 英语语法课件",
  theme: "warm",
  slides: [
    {
      heading: "When do we use it?",
      bullets: [
        "Actions that finished in the past（过去已完成的动作）",
        "yesterday / last night / in 2020 等过去时间词",
      ],
      note: "先问学生：昨天你做了什么？引出动词语境。",
    },
    {
      heading: "Regular verbs: add -ed",
      bullets: [
        "play → played / watch → watched",
        "以 e 结尾加 -d：like → liked",
        "辅音+y 结尾变 y 为 i 加 -ed：study → studied",
      ],
    },
    {
      heading: "Practice",
      bullets: [
        "I ____ (visit) my grandma last Sunday.",
        "She ____ (study) English yesterday.",
        "They ____ (watch) a film last night.",
      ],
      note: "口头操练 2 分钟，抽三组对答案。",
    },
  ],
}

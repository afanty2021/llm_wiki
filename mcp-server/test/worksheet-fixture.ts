/**
 * 学案样张 fixture（评审 I-8b/M-6 一处两用）：真冒烟渲染输入 + 文字准确性
 * 「esc 后逐字存在于 page.html」断言源。内容取自探针样张（Green School）。
 */
import type { WorksheetDoc } from "../src/worksheet.js"

export const WORKSHEET_FIXTURE: WorksheetDoc = {
  title: "Green School in Bali, Indonesia",
  subtitle: "My School Exploration · 学校探索学案",
  theme: "nature",
  footer: "完成后交给老师 · Name: ______",
  sections: [
    {
      heading: "Our Classrooms",
      icon: "🏫",
      blocks: [
        { type: "text", text: "Our classrooms look like this:" },
        { type: "boxfill", items: [{ before: "We can see", after: "right outside." }] },
        { type: "checklist", items: ["Plants 🌱", "Trees 🌳", "Bamboo 🎋"] },
      ],
    },
    {
      heading: "Weekly Schedule",
      icon: "🗓️",
      blocks: [
        {
          type: "table",
          headers: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          rows: [
            ["English", "Math", "Computers", "Music", ""],
            ["Music", "Art", "Reading", "Gym", ""],
          ],
        },
        { type: "fill", items: [{ before: "Do we have homework?" }] },
      ],
    },
    {
      heading: "Grade Gardens",
      icon: "🌻",
      blocks: [
        { type: "fill", items: [{ before: "At the Green School, every", after: "has a garden." }] },
        { type: "numbered", items: [{ before: "We grow" }, { before: "We grow" }, { before: "We grow" }] },
      ],
    },
    {
      heading: "School Farm",
      icon: "🐷",
      blocks: [
        { type: "text", text: "There is a farm, too! We care for the animals by…" },
        { type: "fill", items: [{ before: "giving them", after: "every day." }] },
        { type: "checklist", items: ["Feed", "Pet", "Clean"] },
      ],
    },
  ],
}

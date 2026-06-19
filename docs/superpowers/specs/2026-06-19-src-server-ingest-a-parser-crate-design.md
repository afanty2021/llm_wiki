# 子系统 A 详细设计 — 解析 crate `llm-wiki-parser`

> **状态**：详细设计草稿（2026-06-19）| **上级**：[ingest Plan B 总览设计](2026-06-19-src-server-ingest-design.md) §2
>
> 将桌面端 `src-tauri/src/commands/fs.rs` 的文档解析逻辑抽成独立 workspace crate。pdf/docx/xlsx/pptx → Markdown 文本 + 图片提取。纯函数、零 Tauri 依赖、`src-server` 和 `src-tauri` 均可复用。

---

## 1. 目标与边界

**A 做什么**：
- 全格式入口 `parse_bytes(filename, bytes) → ParsedDoc`：内部按扩展名 dispatch
- pdf → pdfium-render 提取文本 + 内嵌图片（Rgb 渲染 → PNG 编码）
- docx → docx-rs 提取结构化内容（段落/表格/图片）→ Markdown
- xlsx → calamine 提取工作表 → 表格 Markdown
- pptx → calamine + zip 提取幻灯片文本 → Markdown
- .md → 直读 UTF-8（不带解析），非 UTF-8 报 `EncodingError`
- 所有解析结果统一输出结构 `ParsedDoc { text, images, meta }`

**A 不做什么**：
- **不做缓存**：调用方（worker/D）按 content-hash(redis) + `ingested_files` 表(PG)自行管理
- **不做 LLM/分块/embedding**（那是 B/D/后续的事）
- **不支持遗留格式** .doc/odt/ods（MVP 保留 `UnsupportedFormat` 错误）
- **不处理多模态 caption**（图片仅提取 `Vec<u8>`，caption 后续加）

**边界**：独立 workspace crate（路径 `crates/llm-wiki-parser/`），`src-server` 通过 `Cargo.toml` path dep 依赖。桌面端 `src-tauri` 后续可用同一 crate 替换内联解析（纯函数、无 Tauri 绑定）。

---

## 2. 模块结构

```
crates/llm-wiki-parser/
├── Cargo.toml
└── src/
    ├── lib.rs              (~60 行)  公共接口 + 格式 dispatch + pdfium 全局锁
    ├── parser/
    │   ├── mod.rs           (~10 行)  re-export
    │   ├── pdf.rs           (~150 行) extract_pdf_text + extract_pdf_images
    │   ├── docx.rs          (~200 行) extract_docx_markdown（移植 desktop fs.rs）
    │   ├── xlsx.rs          (~100 行) extract_spreadsheet（移植 desktop fs.rs）
    │   ├── pptx.rs          (~80 行)  extract_pptx_markdown（移植 desktop fs.rs）
    │   └── markdown.rs      (~20 行)  纯文本 pass-through + 编码检测
    └── image_utils.rs       (~40 行)  PNG 编码 + 尺寸过滤（桌面 extract_images.rs）
```

~650 行总计。各 parser 模块独立——修改一种格式不改其他。

---

## 3. 公共接口

```rust
// lib.rs

pub struct ParsedDoc {
    /// Markdown 文本，图片引用为相对路径（如 `![alt](page3_image1.png)`）
    pub text: String,
    /// 提取的图片数据（MVP: 仅 PDF 内嵌图）
    pub images: Vec<ExtractedImage>,
    /// 文件元信息
    pub meta: DocMeta,
}

pub struct ExtractedImage {
    /// 文件名，如 "page3_image1.png"。调用方存到 media/{pid}/ 后需替换 text 里的引用。
    pub name: String,
    /// PNG 编码的图片数据
    pub data: Vec<u8>,
}

pub struct DocMeta {
    pub filename: String,
    pub page_count: Option<u32>,    // PDF 专有
    pub file_type: String,           // "pdf" | "docx" | "xlsx" | "pptx" | "md"
}

pub enum ParseError {
    /// 不支持的文件格式（.doc/.odt 等）
    UnsupportedFormat(String),
    /// 非 UTF-8 编码（仅 .md 文件触发）
    EncodingError { filename: String, encoding: String },
    /// PDF 解析失败
    PdfiumError(String),
    /// 文件 IO / 读取失败
    Io(String),
    /// 文件损坏/无法解析
    CorruptFile(String),
}

/// 全格式入口——内部按 filename 扩展名 dispatch。
/// PDF 解析受全局 Mutex 串行化（pdfium 线程不安全）。
pub fn parse_bytes(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError>;
```

---

## 4. 格式 dispatch

```rust
pub fn parse_bytes(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "md" | "markdown" => parser::markdown::parse(filename, bytes),
        "pdf" => parser::pdf::parse(filename, bytes),   // 内部取 pdfium 锁
        "docx" => parser::docx::parse(filename, bytes),
        "xlsx" => parser::xlsx::parse(filename, bytes),
        "pptx" => parser::pptx::parse(filename, bytes),
        other => Err(ParseError::UnsupportedFormat(other.to_string())),
    }
}
```

---

## 5. 各格式实现要点

### 5.1 PDF（pdf.rs, ~200 行）

**依赖**：`pdfium-render` (0.9，与 src-tauri 一致)

**移植源**：桌面 `extract_images.rs:105` 的 `extract_pdf_markdown`（~120 行）——负责 text + image 提取 + PNG 编码 + Markdown 组装。**不是** `fs.rs:374` 的 `extract_pdf_text`（仅 40 行薄包装委托）。

**关键适配**：
- `pdfium.load_pdf_from_file(path, None)` → `pdfium.load_pdf_from_byte_slice(bytes, None)`（pdfium-render 0.9 支持内存加载）
- `save_one_image(&png_bytes, dest_dir, ...)` → 直接返回 `Vec<u8>` 写入 `ExtractedImage.data`
- 图片命名从 `img-{idx}.png` → `page{N}_image{M}.png`（spec §2 要求）
- 尺寸过滤：min_width=100, min_height=100, max_images=500（对齐桌面 `ExtractOptions::default()`）

**线程安全**：
```rust
use std::sync::Mutex;
use pdfium_render::prelude::*;

static PDFIUM: Mutex<Option<Pdfium>> = Mutex::new(None);

fn get_pdfium() -> Result<&'static Pdfium, ParseError> {
    // lazy-init: lock → 检查 → 若 None 则 bind 库 → 存储
    // 库路径从 PDFIUM_DYNAMIC_LIB_PATH env 或系统默认（对齐桌面 pdfium_candidate_paths）
}
```

**文本提取流程**：
```
① get_pdfium() → load pdf bytes → open document
② for each page:
     get text (pdfium page.text())
     if include_images: render page → extract embedded images → encode PNG
③ output: ParsedDoc { text = concatenated, images, meta.page_count }
```

注意：pdfium 的 `page.text()` 输出纯文本（非 Markdown）。图片提取调用 pdfium render 能力（对齐桌面 `extract_pdf_text` 的 `include_images` 分支）。图片命名 `page{N}_image{M}.png`，尺寸过滤（min 100px 单轴，max 500 张，对齐桌面 `ExtractOptions::default()`）。

### 5.2 DOCX（docx.rs, ~200 行）

**依赖**：`docx-rs` (0.4) + `zip` (2.x)

**移植源**：桌面 `fs.rs:607` 的 `extract_docx_markdown`（~200 行，裸 zip + XML 解析）。选择它而非 `fs.rs:459` 的 `extract_docx_with_library`（基于 docx-rs crate），因为**裸 XML 解析的样式映射（标题/粗体/列表/超链接/表格 → Markdown）产出质量更高**——桌面端也是此 codepath 首选。

```rust
pub fn parse(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    // 移植桌面 extract_docx_markdown(&mut archive)
    // ... 段落/标题/粗体/斜体/超链接/图片/表格 → Markdown
}

**流程**：移植桌面 `extract_docx_markdown`（fs.rs:607-795）
```
① 打开 zip archive（docx = zip of XMLs）
② 读 word/document.xml
③ 逐元素处理：
   段落 → Markdown 段落
   标题 → Heading level → `# ...` / `## ...`
   粗体/斜体 → `**text**` / `*text*`
   超链接 → `[text](url)`
   图片 → 提取 attachment（按 rId 交叉引用 word/_rels/document.xml.rels）→ ExtractedImage
   表格 → Markdown table（`| cell | cell |`）
④ 输出：ParsedDoc { text = 拼接的 Markdown, images, meta.file_type = "docx" }
```

### 5.3 XLSX（xlsx.rs, ~100 行）

**依赖**：`calamine` (0.35，与 src-tauri 一致)

**流程**：移植桌面 `extract_spreadsheet`（fs.rs:868-947）
```
① calamine::open_workbook_auto → 遍历所有 sheet
② 每 sheet 转 Markdown table（`| A1 | B1 | C1 |` + 分隔行）
③ 无图片（xlsx 图片嵌入在 drawing 部分，calamine 不直接支持——MVP 不提取）
④ 输出：ParsedDoc { text, images = vec![], meta.file_type = "xlsx" }
```

### 5.4 PPTX（pptx.rs, ~80 行）

**依赖**：`calamine` + `zip`（已有）

**流程**：移植桌面 `extract_pptx_markdown`（fs.rs:797-866）
```
① 打开 zip archive → 遍历 ppt/slides/slide*.xml
② 每 slide 提取所有 shape 文本 → Markdown heading + bullet list
③ 图片：从 ppt/media/ 提取附件 → ExtractedImage
④ 输出：ParsedDoc { text, images, meta.file_type = "pptx" }
```

### 5.5 Markdown（markdown.rs, ~20 行）

```rust
pub fn parse(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    // 编码检测：先试 UTF-8 → 失败尝试 stripping BOM → 仍失败报 EncodingError
    let text = String::from_utf8(bytes.to_vec())
        .or_else(|_| {
            // strip BOM
            let stripped = if bytes.starts_with(b"\xEF\xBB\xBF") { &bytes[3..] } else { bytes };
            String::from_utf8(stripped.to_vec())
        })
        .map_err(|_| ParseError::EncodingError {
            filename: filename.to_string(),
            encoding: "not UTF-8".to_string(),
        })?;
    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta { filename: filename.to_string(), page_count: None, file_type: "md".to_string() },
    })
}
```

---

## 6. pdfium 部署

**开发环境**：
- macOS：`brew install pdfium`（已验证可用基础）
- Ubuntu：`apt install libpdfium-dev`
- Windows：pdfium.dll 拷贝到 crate 目录或设 `PDFIUM_DYNAMIC_LIB_PATH` env

**Docker 部署**（src-server 用）：
```dockerfile
RUN apt-get update && apt-get install -y libpdfium-dev
ENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu
```

**CI 多 OS**：各自装 pdfium。crate 内不捆绑 .dll/.dylib——依赖宿主系统提供。build.rs 可选：检测 `PDFIUM_DYNAMIC_LIB_PATH` env 或系统库路径，不存在时打印 warning 而非 error（.md 解析不需要 pdfium）。

---

## 7. Cargo workspace 配置

当前 repo **无根 workspace**——`src-server` 是独立 Cargo 项目。创建 `crates/llm-wiki-parser/` 需要：

### 根 Cargo.toml（新建）

```toml
[workspace]
resolver = "2"
members = [
    "crates/llm-wiki-parser",
    # "src-server",   // 后续加入——Plan A 落地时再统一 workspace
]
```

### 根 workspace 策略

**Plan A（进行中）建议**：根 Cargo.toml 先只加 `crates/llm-wiki-parser` 一个 member。`src-server` 暂不加入 workspace（避免迁移冲击）。`src-server` 通过 `[dependencies]` path 引用 crate：

```toml
# src-server/Cargo.toml
llm-wiki-parser = { path = "../crates/llm-wiki-parser" }
```

这在非 workspace 场景完全合法——cargo 会把 path dep 当成普通外部 crate 编译。

**后续**：Plan B 全子系统完成后，统一建 workspace 含 `src-server` + `crates/*`。

---

## 8. 测试策略

| 类型 | 内容 | 实现 |
|------|------|------|
| unit: markdown | 合法 UTF-8 / BOM strip / GBK 报 EncodingError | table-driven |
| unit: docx | 假 docx（zip 内手工 document.xml）→ 期待 Markdown 输出 | 构造测试 zip |
| unit: xlsx | 假 xlsx（calamine 支持的内存 workbook）→ 表格 Markdown | 构造测试 |
| unit: pptx | 假 pptx（zip 内手工 slide.xml）→ Markdown | 构造测试 |
| unit: format dispatch | 未知扩展名 → UnsupportedFormat | table-driven |
| integ: 真实文件 | 一个真实 .md/.pdf/.docx/.xlsx → 非空 text | 放 `crates/llm-wiki-parser/tests/fixtures/` |

PDF 集成测试 `#[ignore]`（CI 无 pdfium 系统库——与桌面端一致）；.md/docx/xlsx/pptx 不加 ignore(纯 Rust dep,跨平台可跑)。

PDF 单元测试可选：在 CI 无 pdfium 时跳过（`#[cfg(has_pdfium)]`），本地有 pdfium 时 RUN。

---

## 9. 文件改动清单

| 文件 | 改动 |
|------|------|
| `Cargo.toml`(根) | **Create** — `[workspace]` 含 `crates/llm-wiki-parser` |
| `crates/llm-wiki-parser/Cargo.toml` | **Create** — deps: pdfium-render, docx-rs, calamine, zip, image, serde_json |
| `crates/llm-wiki-parser/src/lib.rs` | **Create** — 公共接口 + 格式 dispatch + pdfium 锁 |
| `crates/llm-wiki-parser/src/parser/*.rs` | **Create** — 6 个 parser 模块 |
| `crates/llm-wiki-parser/src/image_utils.rs` | **Create** — PNG 编码 + 尺寸过滤 |
| `crates/llm-wiki-parser/tests/*.rs` | **Create** — 单元/集成测试 |
| `src-server/Cargo.toml` | 加 `llm-wiki-parser = { path = "../crates/llm-wiki-parser" }`（A 就绪后 D 可用） |

---

## 10. 与桌面端的一致性

| 桌面端 | crate | 移植策略 |
|--------|-------|----------|
| `fs.rs::extract_pdf_text`(L374) | `parser/pdf.rs` | 核心逻辑移植，去 Tauri 绑定（`require_absolute_path` 等）。pdfium 锁从桌面 `PANIC_GUARD` 改为 crate `Mutex` |
| `fs.rs::extract_docx_markdown`(L607) | `parser/docx.rs` | 几乎 1:1 移植（zip + XML 解析，无 Tauri 依赖） |
| `fs.rs::extract_spreadsheet`(L868) | `parser/xlsx.rs` | 1:1 移植 |
| `fs.rs::extract_pptx_markdown`(L797) | `parser/pptx.rs` | 1:1 移植 |
| `fs.rs::extract_odf_text`(L949) | **不含**（MVP 支持遗留） | .odf/.odt 保留 UnsupportedFormat |
| `extract_images.rs` | `image_utils.rs` | 简化为 PNG 编码 + 尺寸过滤（去桌面 Tauri IPC 层） |
| `fs.rs::pdfium_candidate_paths`(L237) | `lib.rs` | 移植路径查找逻辑—— macOS Framework/brew/dylib，Linux so，Windows dll |

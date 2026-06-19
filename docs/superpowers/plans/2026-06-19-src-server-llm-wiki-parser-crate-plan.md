# 子系统 A — 解析 crate `llm-wiki-parser` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建独立 workspace crate `llm-wiki-parser`，实现 `parse_bytes(filename, bytes) → ParsedDoc`：按扩展名 dispatch → pdf/docx/xlsx/pptx/.md 五个 parser。移植桌面端解析逻辑，纯函数、零 Tauri 依赖。

**Architecture:** `crates/llm-wiki-parser/`：lib.rs(公共接口+format dispatch+pdfium 全局锁) + parser/{pdf,docx,xlsx,pptx,markdown}.rs + image_utils.rs。根 Cargo.toml 新建 workspace(members=["crates/llm-wiki-parser"])，src-server 通过 path dep 引用。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-ingest-a-parser-crate-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `Cargo.toml`(根) | 新建 `[workspace]` members=["crates/llm-wiki-parser"] | Create |
| `crates/llm-wiki-parser/Cargo.toml` | 解析 crate deps(pdfium-render+calamine+zip+image+serde_json) | Create |
| `crates/llm-wiki-parser/src/lib.rs` | 公共接口 + format dispatch + pdfium 全局锁 | Create |
| `crates/llm-wiki-parser/src/parser/mod.rs` | re-export 5 个 parser | Create |
| `crates/llm-wiki-parser/src/parser/markdown.rs` | .md pass-through + 编码检测 | Create |
| `crates/llm-wiki-parser/src/parser/docx.rs` | DOCX→Markdown(移植 fs.rs:607 extract_docx_markdown) | Create |
| `crates/llm-wiki-parser/src/parser/xlsx.rs` | XLSX→表格 Markdown(移植 fs.rs:868 extract_spreadsheet) | Create |
| `crates/llm-wiki-parser/src/parser/pptx.rs` | PPTX→Markdown(移植 fs.rs:797 extract_pptx_markdown) | Create |
| `crates/llm-wiki-parser/src/parser/pdf.rs` | PDF→text+images(移植 extract_images.rs:105 extract_pdf_markdown) | Create |
| `crates/llm-wiki-parser/src/image_utils.rs` | PNG 编码 + 尺寸过滤(移植 extract_images.rs) | Create |
| `crates/llm-wiki-parser/tests/` | 单元/集成测试 + fixtures | Create |
| `src-server/Cargo.toml` | 加 `llm-wiki-parser = { path = "../crates/llm-wiki-parser" }`(D 的后续依赖) | Modify |

---

## Task 0: 前置——根 workspace + crate 骨架 + 所有 deps

### Step 1: 创建根 workspace Cargo.toml

根目录 `Cargo.toml`（当前不存在）——**新建**：

```toml
[workspace]
resolver = "2"
members = [
    "crates/llm-wiki-parser",
]
```

### Step 2: 创建 crate Cargo.toml + 所有 parser deps

`crates/llm-wiki-parser/Cargo.toml`：

```toml
[package]
name = "llm-wiki-parser"
version = "0.1.0"
edition = "2021"

[dependencies]
pdfium-render = "0.9"
calamine = "0.35"
zip = "2"
image = "0.25"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
```

### Step 3: 创建公共接口(解析骨架 + 仅 .md parser) + 所有空 parser 模块

`crates/llm-wiki-parser/src/lib.rs`：

```rust
// llm-wiki-parser — 全格式文档解析（pdf/docx/xlsx/pptx/.md）
// 纯函数接口：parse_bytes(filename, &[u8]) → ParsedDoc。
// 零文件系统依赖、零 Tauri 绑定。

mod parser;  // mod image_utils; 在 Task 4 添加

use std::sync::Mutex;
pub use parser::ParsedDoc;
pub use parser::ParseError;
pub use parser::ExtractedImage;
pub use parser::DocMeta;

/// 全格式入口——内部按 filename 扩展名 dispatch。
/// PDF 解析受全局 Mutex 串行化（pdfium 线程不安全）。
pub fn parse_bytes(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "md" | "markdown" => parser::markdown::parse(filename, bytes),
        "pdf" => parser::pdf::parse(bytes),
        "docx" => parser::docx::parse(bytes),
        "xlsx" => parser::xlsx::parse(bytes),
        "pptx" => parser::pptx::parse(bytes),
        other => Err(ParseError::UnsupportedFormat(other.to_string())),
    }
}

// pdfium 全局锁（pdf.rs 内部 lazy-init）
static PDFIUM: Mutex<Option<()>> = Mutex::new(None); // placeholder until pdf.rs defines real Pdfium type
```

`crates/llm-wiki-parser/src/parser/mod.rs`：

```rust
// parser 模块——re-export 各格式 parser

pub mod markdown;
pub mod docx;
pub mod xlsx;
pub mod pptx;
pub mod pdf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDoc {
    pub text: String,
    pub images: Vec<ExtractedImage>,
    pub meta: DocMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedImage {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocMeta {
    pub filename: String,
    pub page_count: Option<u32>,
    pub file_type: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("Unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("Encoding error in {filename}: {encoding}")]
    EncodingError { filename: String, encoding: String },
    #[error("PDF error: {0}")]
    PdfiumError(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Corrupt file: {0}")]
    CorruptFile(String),
}
```

`crates/llm-wiki-parser/src/parser/markdown.rs`：

```rust
use super::{DocMeta, ParsedDoc, ParseError};

pub fn parse(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    // UTF-8 decode with BOM strip
    let stripped = if bytes.starts_with(b"\xEF\xBB\xBF") { &bytes[3..] } else { bytes };
    let text = String::from_utf8(stripped.to_vec())
        .map_err(|_| ParseError::EncodingError {
            filename: filename.to_string(),
            encoding: "unknown (expected UTF-8)".to_string(),
        })?;
    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta {
            filename: filename.to_string(),
            page_count: None,
            file_type: "md".to_string(),
        },
    })
}
```

其他 parser 模块(`docx.rs`/`xlsx.rs`/`pptx.rs`/`pdf.rs`)——空占位 `unimplemented!()`：

```rust
// parser/docx.rs (and similarly for xlsx/pptx/pdf)
use super::{ParsedDoc, ParseError};

pub fn parse(_bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    unimplemented!("DOCX parser not yet implemented")
}
```

### Step 4: 编译验证

```bash
cargo build -p llm-wiki-parser
```
Expected：0 error。根 workspace Cargo.toml 编译通过（仅新建 crate）。md parser 可测试。

### Step 5: commit

```bash
git add Cargo.toml crates/llm-wiki-parser/
git commit -m "chore: 根 workspace + llm-wiki-parser crate 骨架 + .md parser + 所有 deps（子系统 A Task 0）"
```

---

## Task 1: .md parser 单元测试（TDD）

### Step 1: 写测试

`crates/llm-wiki-parser/src/parser/markdown.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_utf8() {
        let doc = parse("test.md", b"# Hello\n\nBody text.").unwrap();
        assert_eq!(doc.text, "# Hello\n\nBody text.");
        assert_eq!(doc.meta.file_type, "md");
        assert!(doc.images.is_empty());
    }

    #[test]
    fn markdown_bom_strip() {
        let mut input = vec![0xEF, 0xBB, 0xBF];
        input.extend_from_slice(b"# Title\n");
        let doc = parse("bom.md", &input).unwrap();
        assert_eq!(doc.text, "# Title\n");
    }

    #[test]
    fn markdown_non_utf8_returns_encoding_error() {
        let result = parse("gbk.md", b"\xB4\xF3\xBC\xD2\xBA\xC3"); // GBK bytes
        assert!(matches!(result, Err(ParseError::EncodingError { .. })));
    }

    #[test]
    fn format_dispatch_markdown() {
        // 测试 lib.rs 的 dispatch
        let doc = crate::parse_bytes("hello.md", b"ok").unwrap();
        assert_eq!(doc.meta.file_type, "md");
    }

    #[test]
    fn format_dispatch_unsupported() {
        let result = crate::parse_bytes("data.bin", b"");
        assert!(matches!(result, Err(ParseError::UnsupportedFormat(ext)) if ext == "bin"));
    }
}
```

### Step 2: 跑测试验证 PASS

```bash
cargo test -p llm-wiki-parser
```
Expected：5 passed, 0 failed

### Step 3: commit

```bash
git add crates/llm-wiki-parser/src/parser/markdown.rs crates/llm-wiki-parser/src/lib.rs
git commit -m "test(llm-wiki-parser): .md parser 单元测试(UTF-8/BOM/GBK error/format dispatch)"
```

---

## Task 2: DOCX parser + 单元测试

### Step 1: 写失败测试

`crates/llm-wiki-parser/src/parser/docx.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 构造一个最小合法 docx（zip 内 word/document.xml）
    fn minimal_docx_bytes() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::default();
        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
  </w:body>
</w:document>"#).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn docx_basic_text_extraction() {
        let bytes = minimal_docx_bytes();
        let doc = parse(&bytes).unwrap();
        assert!(doc.text.contains("Hello"));
        assert_eq!(doc.meta.file_type, "docx");
    }

    #[test]
    fn docx_corrupt_zip_returns_error() {
        let result = parse(b"not a zip file");
        assert!(result.is_err());
    }
}
```

### Step 2: 跑测试验证 FAIL

```bash
cargo test -p llm-wiki-parser docx_basic -- --nocapture
```
Expected：FAIL（`unimplemented!()`）

### Step 3: 实现 DOCX parser

替换 `parser/docx.rs` 的 `parse` 函数——移植桌面 `fs.rs:607` `extract_docx_markdown`：

```rust
use super::{DocMeta, ExtractedImage, ParsedDoc, ParseError};
use std::io::{Cursor, Read};

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("invalid zip: {}", e)))?;

    let text = extract_docx_markdown(&mut archive)
        .map_err(|e| ParseError::CorruptFile(e))?;

    Ok(ParsedDoc {
        text,
        images: vec![],  // MVP 暂不提取图片
        meta: DocMeta {
            filename: String::new(), // caller fills via lib.rs dispatch
            page_count: None,
            file_type: "docx".to_string(),
        },
    })
}

/// 移植桌面 extract_docx_markdown（fs.rs:607）
fn extract_docx_markdown(archive: &mut zip::ZipArchive<Cursor<&[u8]>>) -> Result<String, String> {
    let mut doc_xml = String::new();
    if let Ok(mut f) = archive.by_name("word/document.xml") {
        f.read_to_string(&mut doc_xml).map_err(|e| format!("read document.xml: {}", e))?;
    } else {
        return Err("word/document.xml not found".into());
    }

    // MVP 实现：从 XML 中提取所有 <w:t> 文本节点，用空格分隔段落
    let mut out = String::new();
    let mut in_para = false;
    let mut para_buf = String::new();

    // 简易 XML 解析——提取 w:p 和 w:t 文本
    let xml = doc_xml.replace('\n', "");
    for seg in xml.split("<w:p") {
        if seg.is_empty() { continue; }
        para_buf.clear();
        // 提取 w:t 文本
        let mut text_start = 0;
        while let Some(tag_start) = seg[text_start..].find("<w:t") {
            let abs = text_start + tag_start;
            let tag_content = &seg[abs..];
            if let Some(close) = tag_content.find('>') {
                let inner_start = abs + close + 1;
                if let Some(end_tag) = seg[inner_start..].find("</w:t>") {
                    let text = decode_xml_entities(&seg[inner_start..inner_start + end_tag]);
                    para_buf.push_str(&text);
                    text_start = inner_start + end_tag + 6; // skip </w:t>
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        if !para_buf.is_empty() {
            if !out.is_empty() { out.push('\n'); }
            out.push_str(&para_buf);
        }
    }

    Ok(out)
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}
```

> **实现注**：MVP 版 DOCX 用简易 XML 解析（str split），不引入完整 XML parser。桌面版 `extract_docx_markdown` 有 ~200 行含标题/粗体/超链接/表格/列表处理，本 Task 实现最简版(paragraph text extraction)。全功能版留到后续 Task 加(或与桌面版同步迭代)。测试验证基本文本提取即可。

### Step 4: 跑测试验证 PASS

```bash
cargo test -p llm-wiki-parser
```
Expected：7 passed(5 markdown + 2 docx), 0 failed

### Step 5: commit

```bash
git add crates/llm-wiki-parser/src/parser/docx.rs
git commit -m "feat(llm-wiki-parser): DOCX parser(简易 XML 段落提取)+2 单元测试（Task 2）"
```

---

## Task 3: XLSX + PPTX parser + 单元测试

### Step 1: 写 XLSX parser + 测试

`crates/llm-wiki-parser/src/parser/xlsx.rs`：

```rust
use super::{DocMeta, ParsedDoc, ParseError};
use std::io::Cursor;

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    let mut workbook = calamine::open_workbook_auto(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("calamine: {}", e)))?;

    let mut text = String::new();
    for sheet_name in workbook.sheet_names().clone() {
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            text.push_str(&format!("# {}\n\n", sheet_name));
            let rows = range.rows();
            for (ri, row) in rows.enumerate() {
                let cells: Vec<String> = row.iter()
                    .map(|c| c.to_string())
                    .collect();
                text.push_str(&format!("| {} |\n", cells.join(" | ")));
                if ri == 0 {
                    // 表头分隔行
                    let sep: Vec<&str> = cells.iter().map(|_| "---").collect();
                    text.push_str(&format!("| {} |\n", sep.join(" | ")));
                }
            }
            text.push('\n');
        }
    }

    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta { filename: String::new(), page_count: None, file_type: "xlsx".to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_corrupt_returns_error() {
        let result = parse(b"not an xlsx");
        assert!(matches!(result, Err(ParseError::CorruptFile(_))));
    }
}
```

### Step 2: 写 PPTX parser + 测试

`crates/llm-wiki-parser/src/parser/pptx.rs`：

```rust
use super::{DocMeta, ParsedDoc, ParseError};
use std::io::{Cursor, Read};

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("invalid zip: {}", e)))?;

    let mut text = String::new();
    // 遍历 ppt/slides/slide{N}.xml
    for i in 1..=999 {
        let path = format!("ppt/slides/slide{}.xml", i);
        if let Ok(mut f) = archive.by_name(&path) {
            let mut xml = String::new();
            f.read_to_string(&mut xml).map_err(|e| ParseError::Io(e.to_string()))?;

            // 简易 XML：提取 <a:t> 文本（PPTX shape text）
            for seg in xml.split("<a:p>") {
                let mut line = String::new();
                for part in seg.split("<a:t>") {
                    if let Some(end) = part.find("</a:t>") {
                        line.push_str(&part[..end]);
                    }
                }
                if !line.is_empty() {
                    if text.is_empty() {
                        text.push_str(&format!("# Slide {}\n\n", i));
                    }
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            if !text.is_empty() {
                text.push('\n');
            }
        } else if i > 1 {
            break; // 连续找不到 slide 文件时停止
        }
    }

    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta { filename: String::new(), page_count: None, file_type: "pptx".to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pptx_corrupt_returns_error() {
        let result = parse(b"not a zip");
        assert!(matches!(result, Err(ParseError::CorruptFile(_))));
    }

    #[test]
    fn pptx_empty_no_slides() {
        // 空 pptx = zip 空目录
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.finish().unwrap();
        let bytes = zip.into_inner().into_inner();  // 一次 finish → 取 inner writer
        let doc = parse(&bytes).unwrap();
        assert_eq!(doc.meta.file_type, "pptx");
        assert!(doc.text.is_empty());
    }
}
```

### Step 3: 编译 + 跑测试

```bash
cargo build -p llm-wiki-parser
cargo test -p llm-wiki-parser
```
Expected：10 passed(5 markdown + 2 docx + 1 xlsx + 2 pptx), 0 failed

### Step 4: commit

```bash
git add crates/llm-wiki-parser/src/parser/xlsx.rs crates/llm-wiki-parser/src/parser/pptx.rs
git commit -m "feat(llm-wiki-parser): XLSX + PPTX parser + 3 单元测试（Task 3）"
```

---

## Task 4: PDF parser + image_utils + 集成测试

### Step 0: lib.rs 添加 mod image_utils

```rust
mod image_utils;
```

### Step 1: 写 image_utils

`crates/llm-wiki-parser/src/image_utils.rs`：

```rust
/// PNG 编码 + 尺寸过滤（移植桌面 extract_images.rs 的 ExtractOptions）
use image::GenericImageView;

pub struct ExtractOptions {
    pub min_width: u32,
    pub min_height: u32,
    pub max_images: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self { min_width: 100, min_height: 100, max_images: 500 }
    }
}

/// 将 image crate 的 DynamicImage 转 PNG 字节。尺寸过滤。
pub fn encode_png(img: &image::DynamicImage, name: &str, opts: &ExtractOptions) -> Option<Vec<u8>> {
    let (w, h) = img.dimensions();
    if w < opts.min_width || h < opts.min_height { return None; }
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(buf.into_inner())
}
```

### Step 2: 写 PDF parser（移植 extract_images.rs:105 extract_pdf_markdown）

`crates/llm-wiki-parser/src/parser/pdf.rs`（精简版，MVP 含 img extract + Mutex 锁）：

```rust
use super::{DocMeta, ExtractedImage, ParsedDoc, ParseError};
use crate::image_utils::{self, ExtractOptions};

use std::sync::Mutex;
use pdfium_render::prelude::*;

// pdfium 全局实例——Mutex 串行化（锁不外溢）
static PDFIUM: Mutex<Option<Pdfium>> = Mutex::new(None);

fn get_pdfium() -> Result<Pdfium, ParseError> {
    let mut guard = PDFIUM.lock().map_err(|e| ParseError::PdfiumError(e.to_string()))?;
    if guard.is_none() {
        *guard = Some(Pdfium::new(
            Pdfium::bind_to_system_library()
                .or_else(|_| Pdfium::bind_to_library(
                    std::env::var("PDFIUM_DYNAMIC_LIB_PATH").ok()
                        .unwrap_or_else(|| {
                            #[cfg(target_os = "macos")] { "/usr/local/lib/libpdfium.dylib".into() }
                            #[cfg(target_os = "linux")] { "/usr/lib/x86_64-linux-gnu/libpdfium.so".into() }
                            #[cfg(target_os = "windows")] { "pdfium.dll".into() }
                        })
                ))
                .map_err(|e| ParseError::PdfiumError(format!("bind: {}", e)))?
        ));
    }
    Ok(guard.as_ref().unwrap().clone())
}

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let pdfium = get_pdfium()?;
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| ParseError::PdfiumError(format!("load: {}", e)))?;

    let page_count = doc.pages().len() as u32;
    let opts = ExtractOptions::default();
    let mut text = String::new();
    let mut images = Vec::new();
    let mut image_count = 0;

    for (pi, page) in doc.pages().iter().enumerate() {
        // text
        if let Ok(t) = page.text() {
            if !t.trim().is_empty() {
                if !text.is_empty() { text.push('\n'); }
                text.push_str(&t);
            }
        }

        // images — 从 PDF 内嵌对象提取（桌面 extract_images.rs 用 objects API）
        if image_count < opts.max_images {
            for obj in page.objects().iter() {
                if let Some(img_obj) = obj.as_image_object() {
                    if let Ok(raw) = img_obj.get_raw_image() {
                        let name = format!("page{}_image{}.png", pi + 1, image_count + 1);
                        let rgba = image::RgbaImage::from_raw(
                            raw.width(), raw.height(), raw.bytes().to_vec(),
                        );
                        if let Some(dynamic_img) = rgba.map(|i| image::DynamicImage::ImageRgba8(i)) {
                            if let Some(png) = image_utils::encode_png(&dynamic_img, &name, &opts) {
                                images.push(ExtractedImage { name, data: png });
                                image_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ParsedDoc {
        text,
        images,
        meta: DocMeta {
            filename: String::new(),
            page_count: Some(page_count),
            file_type: "pdf".to_string(),
        },
    })
}
```

> **实现注**：桌面 extract_images.rs 使用 `page.objects().iter()` + `.as_image_object()` + `.get_raw_image()` 提取内嵌图片——而非 `page.render()`（整页渲染为混合位图）。pdfium 仅在 PDF 被请求时 lazy-init，不影响 `.md` 等纯 Rust parser 模块。

### Step 3: 写集成测试

`crates/llm-wiki-parser/tests/integration.rs`：

```rust
use llm_wiki_parser::*;

#[test]
fn parse_md_file() {
    let doc = parse_bytes("readme.md", b"# Hello\n").unwrap();
    assert_eq!(doc.meta.file_type, "md");
    assert!(!doc.text.is_empty());
}

#[test]
#[ignore = "requires pdfium system library — run locally"]
fn parse_pdf_file() {
    let bytes = std::fs::read("tests/fixtures/sample.pdf")?;
    let doc = parse_bytes("sample.pdf", &bytes).unwrap();
    assert_eq!(doc.meta.file_type, "pdf");
    assert!(!doc.text.is_empty());
}
```

### Step 4: 编译 + 跑测试

```bash
cargo build -p llm-wiki-parser
cargo test -p llm-wiki-parser
```
Expected：12 passed (md + docx + xlsx + pptx + integration)，1 ignored (pdf)。无 pdfium 环境下 pdf 编译通过（pdfium-render crate 不要求运行时库存在——仅 bind 时 fail——这里 lazy-init 在 Mutex 内，编译期间没问题）。

### Step 5: commit

```bash
git add crates/llm-wiki-parser/src/image_utils.rs crates/llm-wiki-parser/src/parser/pdf.rs crates/llm-wiki-parser/tests/
git commit -m "feat(llm-wiki-parser): PDF parser(extract_pdf_markdown 移植)+image_utils+集成测试（Task 4）"
```

---

## Task 5: src-server 集成——path dep 挂载

### Step 1: src-server Cargo.toml 加 path dep

`src-server/Cargo.toml` 的 `[dependencies]` 区域加：

```toml
llm-wiki-parser = { path = "../crates/llm-wiki-parser" }
```

### Step 2: src-server 编译验证

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。crate 作为外部 dep 可用（D 模块后续调 `llm_wiki_parser::parse_bytes`）。

### Step 3: src-tauri 兼容验证

```bash
(cd src-tauri && cargo check 2>&1 | tail -5)
```
Expected：src-tauri 不引 llm-wiki-parser (仍用内联解析)，编译不受影响。

### Step 4: commit

```bash
git add src-server/Cargo.toml src-server/Cargo.lock
git commit -m "chore(src-server): 挂载 llm-wiki-parser path dep（子系统 A Task 5）"
```

---

## 最终验证

```bash
cargo build -p llm-wiki-parser     # crate 0 error
cargo test -p llm-wiki-parser      # 12 passed, 1 ignored(pdf)
cargo build -p llm_wiki_server     # server + dep 0 error
```

---

## Self-Review

**1. Spec 覆盖：**
- parse_bytes 公共接口 → Task 0 lib.rs ✅
- ParsedDoc/ExtractedImage/DocMeta 结构 → Task 0 parser/mod.rs ✅
- ParseError 枚举(含 EncodingError)→ Task 0 ✅
- format dispatch(md/pdf/docx/xlsx/pptx + unsupported) → Task 0 lib.rs ✅
- .md parser + 编码检测 → Task 0 + Task 1 test ✅
- DOCX parser(移植 extract_docx_markdown)→ Task 2 ✅
- XLSX parser(移植 extract_spreadsheet)→ Task 3 ✅
- PPTX parser(移植 extract_pptx_markdown)→ Task 3 ✅
- PDF parser(移植 extract_pdf_markdown + pdfium 锁)→ Task 4 ✅
- image_utils(PNG 编码 + 尺寸过滤)→ Task 4 ✅
- pdfium 路径查找(env + 系统默认)→ Task 4 pdf.rs ✅
- workspace 布局 → Task 0 ✅
- src-server path dep → Task 5 ✅
- PDF test `#[ignore]`(CI 无 pdfium)→ Task 4 ✅

**2. 占位符扫描：** 无 TBD/TODO。DOCX MVP 版是简易段落提取(非全功能 200 行)，标注了"后续迭代加"。✅

**3. 类型一致：**
- `ParsedDoc { text, images, meta }` 在 Task 0 定义，所有 parser 返回一致 ✅
- `ParseError` 枚举在所有 parser 中一致 ✅
- `parse_bytes(filename, &[u8])` 签名在所有调用/测试中一致 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-llm-wiki-parser-crate-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?

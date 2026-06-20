// llm-wiki-parser — 全格式文档解析（pdf/docx/xlsx/pptx/.md）
// 纯函数接口：parse_bytes(filename, &[u8]) → ParsedDoc。
// 零文件系统依赖、零 Tauri 绑定。

mod parser;
mod image_utils;

pub use parser::ParsedDoc;
pub use parser::ParseError;
pub use parser::ExtractedImage;
pub use parser::DocMeta;

/// 全格式入口——内部按 filename 扩展名 dispatch。
/// PDF 解析受 pdf.rs 内全局 Mutex 串行化（pdfium 线程不安全）。
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

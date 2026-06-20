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

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

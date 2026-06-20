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

use super::{DocMeta, ParsedDoc, ParseError};
use std::io::{Cursor, Read};

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("invalid zip: {}", e)))?;

    let text = extract_docx_markdown(&mut archive).map_err(ParseError::CorruptFile)?;

    Ok(ParsedDoc {
        text,
        images: vec![], // MVP 暂不提取图片
        meta: DocMeta {
            filename: String::new(),
            page_count: None,
            file_type: "docx".to_string(),
        },
    })
}

/// 移植桌面 extract_docx_markdown（fs.rs:607）——MVP 简易 XML 段落提取。
fn extract_docx_markdown(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
) -> Result<String, String> {
    let mut doc_xml = String::new();
    if let Ok(mut f) = archive.by_name("word/document.xml") {
        f.read_to_string(&mut doc_xml)
            .map_err(|e| format!("read document.xml: {}", e))?;
    } else {
        return Err("word/document.xml not found".into());
    }

    // MVP：从 XML 提取所有 <w:t> 文本节点，按 <w:p 段落分组
    let mut out = String::new();
    let xml = doc_xml.replace('\n', "");
    for seg in xml.split("<w:p") {
        if seg.is_empty() {
            continue;
        }
        let mut para_buf = String::new();
        let mut text_start = 0;
        while let Some(tag_start) = seg[text_start..].find("<w:t") {
            let abs = text_start + tag_start;
            let tag_content = &seg[abs..];
            if let Some(close) = tag_content.find('>') {
                let inner_start = abs + close + 1;
                if let Some(end_tag) = seg[inner_start..].find("</w:t>") {
                    let text = decode_xml_entities(&seg[inner_start..inner_start + end_tag]);
                    para_buf.push_str(&text);
                    // `</w:t>` = 6 字符
                    text_start = inner_start + end_tag + 6;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        if !para_buf.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 构造最小合法 docx（zip 内 word/document.xml）
    fn minimal_docx_bytes() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        // zip 2.x：SimpleFileOptions = FileOptions<'static, ()>，无需泛型参数。
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
  </w:body>
</w:document>"#)
            .unwrap();
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

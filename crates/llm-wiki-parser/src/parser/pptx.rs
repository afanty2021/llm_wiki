use super::{DocMeta, ParsedDoc, ParseError};
use std::io::{Cursor, Read};

/// 解析 PPTX 字节为 ParsedDoc。
///
/// PPTX 本质是 zip，遍历 `ppt/slides/slide{N}.xml`，用简易字符串扫描提取 shape 文本：
/// 每个 `<a:p>`（段落）拆分，段落内累加所有 `<a:t>...</a:t>`（text run）内容，非空段落
/// 拼成一行。首个非空段落前输出 `# Slide {N}` 标题。图片暂不提取（返回空 Vec）。
pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("invalid zip: {}", e)))?;

    let mut text = String::new();
    // 遍历 ppt/slides/slide{N}.xml；遇到连续缺失（i > 1）即停止。
    for i in 1..=999 {
        let path = format!("ppt/slides/slide{}.xml", i);
        match archive.by_name(&path) {
            Ok(mut f) => {
                let mut xml = String::new();
                f.read_to_string(&mut xml)
                    .map_err(|e| ParseError::Io(e.to_string()))?;

                let slide_started = !text.is_empty();
                for seg in xml.split("<a:p>") {
                    let mut line = String::new();
                    for part in seg.split("<a:t>") {
                        if let Some(end) = part.find("</a:t>") {
                            line.push_str(&part[..end]);
                        }
                    }
                    if !line.is_empty() {
                        if !slide_started && text.is_empty() {
                            text.push_str(&format!("# Slide {}\n\n", i));
                        }
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
                if !text.is_empty() {
                    text.push('\n');
                }
            }
            Err(_) if i > 1 => break,
            Err(_) => {}
        }
    }

    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta {
            filename: String::new(),
            page_count: None,
            file_type: "pptx".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pptx_corrupt_returns_error() {
        // 非 zip 字节 -> ZipArchive::new 失败 -> CorruptFile。
        let result = parse(b"not a zip");
        assert!(
            matches!(result, Err(ParseError::CorruptFile(_))),
            "expected CorruptFile, got {:?}",
            result
        );
    }

    #[test]
    fn pptx_empty_no_slides() {
        // 空 pptx = 不含任何 slide 的合法 zip。
        // 关键：`ZipWriter::finish()` 消费 writer 并返回内部 writer（Cursor<Vec<u8>>），
        // 不能再对已 move 的 zip 调 into_inner；直接对返回值调 into_inner 取 Vec<u8>。
        let cursor = zip::ZipWriter::new(Cursor::new(Vec::new())).finish().unwrap();
        let bytes = cursor.into_inner();
        let doc = parse(&bytes).unwrap();
        assert_eq!(doc.meta.file_type, "pptx");
        assert!(
            doc.text.is_empty(),
            "expected empty text for empty pptx, got {:?}",
            doc.text
        );
    }
}

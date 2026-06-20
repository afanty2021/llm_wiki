use super::{DocMeta, ParsedDoc, ParseError};
use std::io::Cursor;

// calamine 的 sheet_names/worksheet_range 等方法定义在 Reader trait 上，需显式导入。
use calamine::Reader;

/// 解析 XLSX 字节为 ParsedDoc。
///
/// 使用 calamine 的 reader-based auto-detect API（`open_workbook_auto_from_rs`）从
/// `Cursor<Vec<u8>>` 打开 workbook；遍历每个 sheet，渲染为 Markdown 表格（首行为表头，
/// 第二行追加 `| --- |` 分隔行）。图片暂不提取（返回空 Vec）。
pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let cursor = Cursor::new(bytes);
    // calamine 0.35：从 reader 打开用 `open_workbook_auto_from_rs`（auto-detect 格式）。
    // path-based 的 `open_workbook_auto` 需要 AsRef<Path>，不接受 Cursor。
    let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
        .map_err(|e| ParseError::CorruptFile(format!("calamine: {}", e)))?;

    let mut text = String::new();
    // sheet_names() 返回借用，clone 一份避免与 worksheet_range 借用冲突。
    for sheet_name in workbook.sheet_names().clone() {
        let range = match workbook.worksheet_range(&sheet_name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // 空 sheet 跳过：避免产生孤立的 `# SheetName` 标题无表格。
        if range.is_empty() {
            continue;
        }
        text.push_str(&format!("# {}\n\n", sheet_name));
        for (ri, row) in range.rows().enumerate() {
            // calamine Data impl Display（Empty variant 输出空串），直接 to_string。
            // 转义 `|` 防止破坏 Markdown 表格列数；换行替换为空格防止断行。
            let cells: Vec<String> = row
                .iter()
                .map(|c| c.to_string().replace('|', "\\|").replace('\n', " "))
                .collect();
            text.push_str(&format!("| {} |\n", cells.join(" | ")));
            if ri == 0 {
                let sep: Vec<&str> = cells.iter().map(|_| "---").collect();
                text.push_str(&format!("| {} |\n", sep.join(" | ")));
            }
        }
        text.push('\n');
    }

    Ok(ParsedDoc {
        text,
        images: vec![],
        meta: DocMeta {
            filename: String::new(),
            page_count: None,
            file_type: "xlsx".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_corrupt_returns_error() {
        // 非 zip/xlsx 字节 -> calamine 打开失败 -> CorruptFile。
        let result = parse(b"not an xlsx");
        assert!(
            matches!(result, Err(ParseError::CorruptFile(_))),
            "expected CorruptFile, got {:?}",
            result
        );
    }
}

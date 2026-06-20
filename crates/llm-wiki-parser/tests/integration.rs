use llm_wiki_parser::*;

#[test]
fn parse_md_file() {
    let doc = parse_bytes("readme.md", b"# Hello\n").unwrap();
    assert_eq!(doc.meta.file_type, "md");
    assert!(!doc.text.is_empty());
}

#[test]
#[ignore = "requires pdfium system library — run locally with fixture present"]
fn parse_pdf_file() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = std::fs::read("tests/fixtures/sample.pdf")?;
    let doc = parse_bytes("sample.pdf", &bytes)?;
    assert_eq!(doc.meta.file_type, "pdf");
    assert!(!doc.text.is_empty());
    Ok(())
}

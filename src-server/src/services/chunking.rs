//! 向量检索专用细粒度切分（区别于 ingest_pipeline 给 LLM 的 context_budget 级粗切分）。
//! 按段落优先、超长按句子边界硬拆、带 overlap 滑窗；全部按 char 边界操作（UTF-8 安全）。

/// 将文本切分为向量检索小块。chunk_size/overlap 为**字符预算**（bge-m3 CJK ≈ 1 字符/token）。
/// 空文本或 chunk_size==0 → 空 Vec。overlap 自动夹到 < chunk_size。
pub fn chunk_for_embedding(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() || chunk_size == 0 {
        return Vec::new();
    }
    let overlap = overlap.min(chunk_size.saturating_sub(1));

    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let mut packed: Vec<String> = Vec::new();
    let mut buf = String::new();
    for para in paragraphs {
        let pchars: Vec<char> = para.chars().collect();
        if pchars.len() > chunk_size {
            if !buf.is_empty() {
                packed.push(std::mem::take(&mut buf));
            }
            for piece in split_long_chars(&pchars, chunk_size) {
                packed.push(piece);
            }
        } else if buf.chars().count() + pchars.len() + 2 > chunk_size {
            // 仅当 buf 非空才 flush（与上方 overlong 分支一致；否则段落长度≈chunk_size 时会 push 空块）
            if !buf.is_empty() {
                packed.push(std::mem::take(&mut buf));
            }
            buf.push_str(&para);
        } else {
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(&para);
        }
    }
    if !buf.is_empty() {
        packed.push(buf);
    }

    apply_overlap(packed, overlap)
}

fn split_long_chars(chars: &[char], chunk_size: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf: Vec<char> = Vec::new();
    let mut cur_sentence: Vec<char> = Vec::new();
    for &c in chars {
        cur_sentence.push(c);
        if matches!(c, '。' | '.' | '!' | '?' | '！' | '？' | '\n') {
            let slen = cur_sentence.len();
            if slen > chunk_size {
                if !buf.is_empty() {
                    out.push(buf.iter().collect());
                    buf.clear();
                }
                let mut start = 0usize;
                while start < cur_sentence.len() {
                    let end = (start + chunk_size).min(cur_sentence.len());
                    out.push(cur_sentence[start..end].iter().collect());
                    start = end;
                }
            } else if buf.len() + slen + 1 > chunk_size {
                if !buf.is_empty() {
                    out.push(buf.iter().collect());
                }
                buf = cur_sentence.clone();
            } else {
                if !buf.is_empty() {
                    buf.push(' ');
                }
                buf.extend_from_slice(&cur_sentence);
            }
            cur_sentence.clear();
        }
    }
    if !cur_sentence.is_empty() {
        let slen = cur_sentence.len();
        if slen > chunk_size {
            let mut start = 0usize;
            while start < cur_sentence.len() {
                let end = (start + chunk_size).min(cur_sentence.len());
                out.push(cur_sentence[start..end].iter().collect());
                start = end;
            }
        } else if buf.len() + slen + 1 > chunk_size {
            if !buf.is_empty() {
                out.push(buf.iter().collect());
            }
            buf = cur_sentence.clone();
        } else {
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.extend_from_slice(&cur_sentence);
        }
    }
    if !buf.is_empty() {
        out.push(buf.iter().collect());
    }
    out
}

fn apply_overlap(packed: Vec<String>, overlap: usize) -> Vec<String> {
    if overlap == 0 || packed.len() <= 1 {
        return packed;
    }
    let mut out = Vec::with_capacity(packed.len());
    out.push(packed[0].clone());
    for i in 1..packed.len() {
        let prev_tail: String = packed[i - 1].chars().rev().take(overlap).collect::<Vec<_>>().into_iter().rev().collect();
        let mut merged = prev_tail;
        merged.push_str(&packed[i]);
        out.push(merged);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::chunk_for_embedding;

    #[test]
    fn empty_or_zero_returns_empty() {
        assert!(chunk_for_embedding("", 384, 64).is_empty());
        assert!(chunk_for_embedding("   ", 384, 64).is_empty());
        assert!(chunk_for_embedding("x", 0, 0).is_empty());
    }

    #[test]
    fn short_text_single_chunk() {
        let out = chunk_for_embedding("hello world", 384, 64);
        assert_eq!(out, vec!["hello world".to_string()]);
    }

    #[test]
    fn paragraphs_packed_into_chunks() {
        let text = "段落一很短。\n\n段落二也很短。";
        let out = chunk_for_embedding(text, 100, 0);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("段落一") && out[0].contains("段落二"));
    }

    #[test]
    fn overlong_paragraph_split_by_sentence() {
        let long = "这是一句话。".repeat(50);
        let out = chunk_for_embedding(&long, 30, 0);
        assert!(out.len() > 1, "应拆成多块，got {} 块", out.len());
        for chunk in &out {
            assert!(chunk.chars().count() <= 30 + 6, "每块不超过 chunk_size+一句：{} 字符", chunk.chars().count());
        }
    }

    #[test]
    fn overlap_shared_between_adjacent_chunks() {
        let text = (0..10).map(|i| format!("段落{}", i)).collect::<Vec<_>>().join("\n\n");
        let out = chunk_for_embedding(&text, 20, 5);
        if out.len() >= 2 {
            let tail: String = out[0].chars().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect();
            assert!(out[1].starts_with(&tail), "第二块应以第一块尾部开头；tail={:?}, out[1]={:?}", tail, out[1]);
        }
    }

    #[test]
    fn chinese_no_panic_utf8_safe() {
        let long = "量化交易".repeat(200);
        let out = chunk_for_embedding(&long, 100, 10);
        assert!(!out.is_empty());
        for chunk in &out {
            let _ = chunk.chars().count();
        }
    }

    #[test]
    fn no_empty_chunk_at_chunk_size_boundary() {
        // review：段落长度 == chunk_size（或 chunk_size-1）时，packing 的 else-if 分支不得push 空 buf
        // （否则空 chunk 被送去 embedding，若服务拒空输入则 ingest 断；且 chunk_index 错位）
        let out = chunk_for_embedding(&"a".repeat(384), 384, 0);
        assert!(out.iter().all(|c| !c.is_empty()), "不应有空 chunk；got {:?}", out);
        assert_eq!(out.len(), 1, "单段 == chunk_size 应合成 1 块；got {} 块", out.len());
        // chunk_size-1 边界同样
        let out2 = chunk_for_embedding(&"a".repeat(383), 384, 0);
        assert!(out2.iter().all(|c| !c.is_empty()), "got {:?}", out2);
    }
}

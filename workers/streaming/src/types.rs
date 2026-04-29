pub fn chunk_markdown_aware(text: &str, min_size: usize, max_size: usize) -> Vec<String> {
    if text.chars().count() <= max_size {
        return vec![text.to_string()];
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut remaining: String = text.to_string();
    let mut in_code_fence = false;

    while !remaining.is_empty() {
        if remaining.chars().count() <= max_size {
            chunks.push(remaining.clone());
            break;
        }

        let chars: Vec<char> = remaining.chars().collect();
        let window_end = max_size.min(chars.len());
        let window: String = chars[..window_end].iter().collect();

        let mut split_at = max_size;

        let window_chars: Vec<char> = window.chars().collect();
        for i in 0..window_chars.len() {
            if i + 3 <= window_chars.len()
                && window_chars[i] == '`'
                && window_chars[i + 1] == '`'
                && window_chars[i + 2] == '`'
            {
                in_code_fence = !in_code_fence;
            }
        }

        if in_code_fence {
            let fence = find_substring_after(&remaining, "```", 3);
            if let Some(fence_idx) = fence
                && fence_idx < max_size * 2 {
                    let after_fence = remaining[fence_idx + 3..].find('\n');
                    split_at = match after_fence {
                        Some(nl) => fence_idx + 3 + nl + 1,
                        None => fence_idx + 3,
                    };
                    in_code_fence = false;
                }
        } else {
            let para_break = window.rfind("\n\n");
            if let Some(idx) = para_break.filter(|i| *i > min_size) {
                split_at = idx + 2;
            } else {
                let newline = window.rfind('\n');
                if let Some(idx) = newline.filter(|i| *i > min_size) {
                    split_at = idx + 1;
                } else {
                    let sentence_end = window.rfind(". ");
                    if let Some(idx) = sentence_end.filter(|i| *i > min_size) {
                        split_at = idx + 2;
                    }
                }
            }
        }

        let split_at = split_at.min(remaining.len());
        let split_at = floor_char_boundary(&remaining, split_at);
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].to_string();
    }

    chunks
}

fn find_substring_after(s: &str, needle: &str, start: usize) -> Option<usize> {
    if start >= s.len() {
        return None;
    }
    s[start..].find(needle).map(|i| i + start)
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) && idx > 0 {
        idx -= 1;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_single_chunk() {
        let chunks = chunk_markdown_aware("hello", 20, 100);
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn long_text_multiple_chunks() {
        let text = "a".repeat(500);
        let chunks = chunk_markdown_aware(&text, 20, 100);
        assert!(chunks.len() > 1);
        let recombined: String = chunks.concat();
        assert_eq!(recombined, text);
    }

    #[test]
    fn empty_text_returns_empty() {
        let chunks = chunk_markdown_aware("", 20, 100);
        assert_eq!(chunks, vec!["".to_string()]);
    }

    #[test]
    fn paragraph_break_preferred() {
        let mut text = String::new();
        text.push_str(&"a".repeat(50));
        text.push_str("\n\n");
        text.push_str(&"b".repeat(80));
        let chunks = chunk_markdown_aware(&text, 20, 100);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].ends_with("\n\n"));
    }
}

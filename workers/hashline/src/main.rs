use iii_sdk::error::IIIError;
use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const HASH_CHARS: &[u8] = b"ZPMQVRWSNKTXJBYH";

fn workspace_root() -> PathBuf {
    if let Ok(p) = std::env::var("AGENTOS_WORKSPACE") {
        return PathBuf::from(p);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

fn assert_path_contained(resolved: &Path) -> Result<(), IIIError> {
    let root = workspace_root();
    let real_resolved = std::fs::canonicalize(resolved).unwrap_or_else(|_| resolved.to_path_buf());
    let real_root = std::fs::canonicalize(&root).unwrap_or(root.clone());
    if !real_resolved.starts_with(&real_root) {
        return Err(IIIError::Handler(format!(
            "Path traversal denied: {}",
            resolved.display()
        )));
    }
    Ok(())
}

/// JS expression `(hash << 5) - hash + ch + seed | 0` — mirror with i32 wrapping.
pub fn compute_line_hash(line_number: i64, content: &str) -> String {
    let stripped: &str = content.trim_end_matches(|c: char| c == ' ' || c == '\t' || c == '\n' || c == '\r');
    let has_alnum = stripped.chars().any(|c| c.is_alphanumeric());
    let seed: i32 = if has_alnum { 0 } else { line_number as i32 };

    let mut hash: i32 = 0;
    for ch in stripped.chars() {
        // JS: charCodeAt returns UTF-16 code unit. For BMP chars this equals u32 code point;
        // for non-BMP it's a surrogate. For ASCII source we mimic with u32 codepoints.
        let code = ch as u32 as i32;
        let shifted = hash.wrapping_shl(5);
        hash = shifted.wrapping_sub(hash).wrapping_add(code).wrapping_add(seed);
        // `| 0` is a no-op for i32 wrapping arithmetic since result is already 32-bit.
    }
    let unsigned = hash as u32;
    let idx = (unsigned % 256) as usize;
    let hi = HASH_CHARS[idx >> 4] as char;
    let lo = HASH_CHARS[idx & 0xf] as char;
    let mut s = String::with_capacity(2);
    s.push(hi);
    s.push(lo);
    s
}

#[derive(Debug, Clone, Copy)]
struct ParsedPos {
    line: usize,
    hash: [u8; 2],
}

fn parse_pos(pos: &str) -> Result<ParsedPos, IIIError> {
    let bytes = pos.as_bytes();
    let hash_idx = pos.find('#').ok_or_else(|| {
        IIIError::Handler(format!("Invalid position format: {pos}"))
    })?;
    let line_str = &pos[..hash_idx];
    let hash_str = &pos[hash_idx + 1..];
    if hash_str.len() != 2 {
        return Err(IIIError::Handler(format!("Invalid position format: {pos}")));
    }
    let line: usize = line_str
        .parse()
        .map_err(|_| IIIError::Handler(format!("Invalid position format: {pos}")))?;
    let h0 = hash_str.as_bytes()[0];
    let h1 = hash_str.as_bytes()[1];
    if !(h0.is_ascii_uppercase() && h1.is_ascii_uppercase()) {
        return Err(IIIError::Handler(format!("Invalid position format: {pos}")));
    }
    let _ = bytes;
    Ok(ParsedPos { line, hash: [h0, h1] })
}

fn validate_hash(lines: &[String], line_number: usize, expected: [u8; 2]) -> Result<(), IIIError> {
    if line_number < 1 || line_number > lines.len() {
        return Err(IIIError::Handler(format!(
            "Line {line_number} out of range (file has {} lines)",
            lines.len()
        )));
    }
    let actual = compute_line_hash(line_number as i64, &lines[line_number - 1]);
    let expected_str = std::str::from_utf8(&expected).unwrap_or("??").to_string();
    if actual != expected_str {
        let mut context: Vec<String> = Vec::new();
        let start = (line_number.saturating_sub(2)).max(1);
        let end = (line_number + 2).min(lines.len());
        for i in start..=end {
            let h = compute_line_hash(i as i64, &lines[i - 1]);
            context.push(format!("{i}#{h}|{}", lines[i - 1]));
        }
        return Err(IIIError::Handler(format!(
            "Hash mismatch at line {line_number}: expected {expected_str}, got {actual}. Current context:\n{}",
            context.join("\n")
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
struct EditInput {
    op: String,
    pos: Option<String>,
    end: Option<String>,
    #[serde(default)]
    lines: Value,
}

fn normalize_edit_lines(v: &Value) -> Option<Vec<String>> {
    if v.is_null() {
        return None;
    }
    if let Some(s) = v.as_str() {
        return Some(s.split('\n').map(String::from).collect());
    }
    if let Some(arr) = v.as_array() {
        return Some(
            arr.iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect(),
        );
    }
    None
}

#[derive(Debug, Clone)]
struct ParsedEdit {
    op: String,
    pos: Option<ParsedPos>,
    end: Option<ParsedPos>,
    lines: Option<Vec<String>>, // None means delete
    lines_present: bool,        // true when the edit explicitly provides lines (vs missing)
    idx: usize,
}

fn parse_edits(edits: &[EditInput]) -> Result<Vec<ParsedEdit>, IIIError> {
    let mut parsed = Vec::with_capacity(edits.len());
    for (idx, e) in edits.iter().enumerate() {
        let pos = match &e.pos {
            Some(p) => Some(parse_pos(p)?),
            None => None,
        };
        let end = match &e.end {
            Some(p) => Some(parse_pos(p)?),
            None => None,
        };
        let lines_present = !e.lines.is_null();
        let lines = normalize_edit_lines(&e.lines);
        parsed.push(ParsedEdit {
            op: e.op.clone(),
            pos,
            end,
            lines,
            lines_present,
            idx,
        });
    }
    Ok(parsed)
}

fn apply_edits(file_lines: &[String], edits: &[ParsedEdit]) -> Result<Vec<String>, IIIError> {
    let mut sorted: Vec<&ParsedEdit> = edits.iter().collect();
    sorted.sort_by(|a, b| {
        let la = a.pos.map(|p| p.line as i64).unwrap_or(0);
        let lb = b.pos.map(|p| p.line as i64).unwrap_or(0);
        lb.cmp(&la).then(b.idx.cmp(&a.idx))
    });

    let mut result: Vec<String> = file_lines.to_vec();

    for edit in sorted {
        match edit.op.as_str() {
            "replace" => {
                let start = edit
                    .pos
                    .ok_or_else(|| IIIError::Handler("replace requires pos".into()))?;
                validate_hash(&result, start.line, start.hash)?;
                if let Some(endp) = edit.end {
                    validate_hash(&result, endp.line, endp.hash)?;
                    if endp.line < start.line {
                        return Err(IIIError::Handler("end line must be >= start line".into()));
                    }
                    let count = endp.line - start.line + 1;
                    let drained_start = start.line - 1;
                    let new_lines = edit.lines.clone();
                    if let Some(nl) = new_lines {
                        result.splice(drained_start..drained_start + count, nl);
                    } else {
                        result.drain(drained_start..drained_start + count);
                    }
                } else {
                    let pos = start.line - 1;
                    let new_lines = edit.lines.clone();
                    if let Some(nl) = new_lines {
                        result.splice(pos..pos + 1, nl);
                    } else {
                        result.drain(pos..pos + 1);
                    }
                }
            }
            "append" => {
                let new_lines = edit.lines.clone().unwrap_or_default();
                if let Some(anchor) = edit.pos {
                    validate_hash(&result, anchor.line, anchor.hash)?;
                    let insert_at = anchor.line; // insert AFTER anchor
                    result.splice(insert_at..insert_at, new_lines);
                } else {
                    result.extend(new_lines);
                }
            }
            "prepend" => {
                let new_lines = edit.lines.clone().unwrap_or_default();
                if let Some(anchor) = edit.pos {
                    validate_hash(&result, anchor.line, anchor.hash)?;
                    let insert_at = anchor.line - 1;
                    result.splice(insert_at..insert_at, new_lines);
                } else {
                    let _ = edit.lines_present;
                    let mut new = new_lines;
                    new.extend(result);
                    result = new;
                }
            }
            other => {
                return Err(IIIError::Handler(format!("unknown op: {other}")));
            }
        }
    }

    Ok(result)
}

fn format_region(lines: &[String], start_line: usize, end_line: usize) -> Vec<String> {
    let s = start_line.max(1);
    let e = end_line.min(lines.len());
    let mut out = Vec::new();
    if s == 0 || e == 0 || s > e {
        return out;
    }
    for i in s..=e {
        let h = compute_line_hash(i as i64, &lines[i - 1]);
        out.push(format!("{i}#{h}|{}", lines[i - 1]));
    }
    out
}

fn extract_body(input: &Value) -> Value {
    if let Some(b) = input.get("body") {
        if !b.is_null() {
            return b.clone();
        }
    }
    input.clone()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("tool::hashline_read", move |input: Value| {
            let _iii = iii_ref.clone();
            async move {
                let body = extract_body(&input);
                let path = body["path"].as_str().unwrap_or("").to_string();
                let start_line = body["startLine"].as_i64().filter(|v| *v > 0);
                let end_line = body["endLine"].as_i64().filter(|v| *v > 0);

                let resolved = workspace_root().join(&path);
                assert_path_contained(&resolved)?;

                let content = tokio::fs::read_to_string(&resolved)
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                let lines: Vec<String> =
                    content.split('\n').map(String::from).collect();

                let start = match start_line {
                    Some(v) => v as usize,
                    None => 1,
                };
                let end = match end_line {
                    Some(v) if (v as usize) <= lines.len() => v as usize,
                    _ => lines.len(),
                };

                let output = format_region(&lines, start, end);

                let _ = _iii.trigger(TriggerRequest {
                    function_id: "metrics::record".to_string(),
                    payload: json!({
                        "name": "tool_execution_total",
                        "value": 1,
                        "labels": { "toolId": "tool::hashline_read", "status": "success" }
                    }),
                    action: None,
                    timeout_ms: None,
                }).await;

                Ok::<Value, IIIError>(json!({
                    "path": resolved.to_string_lossy(),
                    "totalLines": lines.len(),
                    "startLine": start,
                    "endLine": end,
                    "lines": output,
                }))
            }
        })
        .description("Read a file with hash-anchored line numbers")
        .metadata(json!({ "category": "hashline" })),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("tool::hashline_edit", move |input: Value| {
            let _iii = iii_ref.clone();
            async move {
                let body = extract_body(&input);
                let path = body["path"].as_str().unwrap_or("").to_string();
                let edits_val = body.get("edits").cloned().unwrap_or(json!([]));
                let edits: Vec<EditInput> = serde_json::from_value(edits_val)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;

                if edits.is_empty() {
                    return Err(IIIError::Handler(
                        "edits must be a non-empty array".into(),
                    ));
                }

                let resolved = workspace_root().join(&path);
                assert_path_contained(&resolved)?;

                let content = tokio::fs::read_to_string(&resolved)
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                let file_lines: Vec<String> =
                    content.split('\n').map(String::from).collect();

                let parsed = parse_edits(&edits)?;
                let result_lines = apply_edits(&file_lines, &parsed)?;

                tokio::fs::write(&resolved, result_lines.join("\n"))
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;

                let mut min_line: i64 = 1;
                let mut max_line: i64 = result_lines.len() as i64;
                for p in &parsed {
                    if let Some(pos) = p.pos {
                        let pl = pos.line as i64;
                        min_line = min_line.min(pl - 2).max(1);
                        max_line = max_line.max(pl + 5).min(result_lines.len() as i64);
                    }
                }

                let affected = if max_line >= min_line && min_line > 0 {
                    format_region(&result_lines, min_line as usize, max_line as usize)
                } else {
                    Vec::new()
                };

                let _ = _iii.trigger(TriggerRequest {
                    function_id: "metrics::record".to_string(),
                    payload: json!({
                        "name": "tool_execution_total",
                        "value": 1,
                        "labels": { "toolId": "tool::hashline_edit", "status": "success" }
                    }),
                    action: None,
                    timeout_ms: None,
                }).await;

                Ok::<Value, IIIError>(json!({
                    "path": resolved.to_string_lossy(),
                    "totalLines": result_lines.len(),
                    "editsApplied": edits.len(),
                    "affectedRegion": affected,
                }))
            }
        })
        .description("Apply hash-validated edits to a file")
        .metadata(json!({ "category": "hashline" })),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("tool::hashline_diff", move |input: Value| {
            let _iii = iii_ref.clone();
            async move {
                let body = extract_body(&input);
                let path = body["path"].as_str().unwrap_or("").to_string();
                let edits_val = body.get("edits").cloned().unwrap_or(json!([]));
                let edits: Vec<EditInput> = serde_json::from_value(edits_val)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;

                if edits.is_empty() {
                    return Err(IIIError::Handler(
                        "edits must be a non-empty array".into(),
                    ));
                }

                let resolved = workspace_root().join(&path);
                assert_path_contained(&resolved)?;

                let content = tokio::fs::read_to_string(&resolved)
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                let original_lines: Vec<String> =
                    content.split('\n').map(String::from).collect();

                let parsed = parse_edits(&edits)?;
                let edited_lines = apply_edits(&original_lines, &parsed)?;

                let mut diff = Vec::new();
                let mut i = 0usize;
                let mut j = 0usize;
                while i < original_lines.len() || j < edited_lines.len() {
                    if i < original_lines.len() && j < edited_lines.len() {
                        if original_lines[i] == edited_lines[j] {
                            diff.push(format!(" {}", original_lines[i]));
                            i += 1;
                            j += 1;
                        } else {
                            diff.push(format!("-{}", original_lines[i]));
                            i += 1;
                            if j < edited_lines.len() {
                                diff.push(format!("+{}", edited_lines[j]));
                                j += 1;
                            }
                        }
                    } else if i < original_lines.len() {
                        diff.push(format!("-{}", original_lines[i]));
                        i += 1;
                    } else {
                        diff.push(format!("+{}", edited_lines[j]));
                        j += 1;
                    }
                }

                let _ = _iii.trigger(TriggerRequest {
                    function_id: "metrics::record".to_string(),
                    payload: json!({
                        "name": "tool_execution_total",
                        "value": 1,
                        "labels": { "toolId": "tool::hashline_diff", "status": "success" }
                    }),
                    action: None,
                    timeout_ms: None,
                }).await;

                Ok::<Value, IIIError>(json!({
                    "path": resolved.to_string_lossy(),
                    "originalLines": original_lines.len(),
                    "editedLines": edited_lines.len(),
                    "diff": diff.join("\n"),
                }))
            }
        })
        .description("Show diff between original and edited content (dry run)")
        .metadata(json!({ "category": "hashline" })),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "tool::hashline_read".to_string(),
        config: json!({ "api_path": "api/hashline/read", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "tool::hashline_edit".to_string(),
        config: json!({ "api_path": "api/hashline/edit", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "tool::hashline_diff".to_string(),
        config: json!({ "api_path": "api/hashline/diff", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("hashline worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_line_hash_two_chars_from_alphabet() {
        let h = compute_line_hash(1, "function hello() {");
        assert_eq!(h.len(), 2);
        assert!(h.chars().all(|c| HASH_CHARS.contains(&(c as u8))));
    }

    #[test]
    fn compute_line_hash_differs_on_content() {
        let h1 = compute_line_hash(1, "function hello() {");
        let h2 = compute_line_hash(1, "function goodbye() {");
        assert_ne!(h1, h2);
    }

    #[test]
    fn compute_line_hash_seed_for_non_alnum() {
        let h1 = compute_line_hash(1, "---");
        let h2 = compute_line_hash(2, "---");
        assert_ne!(h1, h2);
    }

    #[test]
    fn compute_line_hash_deterministic() {
        let h1 = compute_line_hash(5, "const x = 42;");
        let h2 = compute_line_hash(5, "const x = 42;");
        assert_eq!(h1, h2);
    }

    #[test]
    fn parse_pos_valid() {
        let p = parse_pos("12#AB").unwrap();
        assert_eq!(p.line, 12);
        assert_eq!(&p.hash, b"AB");
    }

    #[test]
    fn parse_pos_invalid() {
        assert!(parse_pos("bad").is_err());
        assert!(parse_pos("1#A").is_err());
        assert!(parse_pos("1#abc").is_err());
    }

    fn lines5() -> Vec<String> {
        vec!["line one", "line two", "line three", "line four", "line five"]
            .into_iter()
            .map(String::from)
            .collect()
    }

    #[test]
    fn format_region_basic() {
        let l = lines5();
        let out = format_region(&l, 1, 5);
        assert_eq!(out.len(), 5);
        assert!(out[0].starts_with("1#") && out[0].ends_with("|line one"));
        assert!(out[1].starts_with("2#") && out[1].ends_with("|line two"));
    }

    #[test]
    fn format_region_subrange() {
        let l = lines5();
        let out = format_region(&l, 2, 3);
        assert_eq!(out.len(), 2);
        assert!(out[0].starts_with("2#") && out[0].ends_with("|line two"));
    }

    fn pos_for(lines: &[String], n: usize) -> String {
        let h = compute_line_hash(n as i64, &lines[n - 1]);
        format!("{n}#{h}")
    }

    #[test]
    fn replace_single_line_with_valid_hash() {
        let l = lines5();
        let p = pos_for(&l, 1);
        let edits = vec![EditInput {
            op: "replace".into(),
            pos: Some(p),
            end: None,
            lines: json!("replaced line one"),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 5);
        assert_eq!(result[0], "replaced line one");
    }

    #[test]
    fn replace_rejects_hash_mismatch() {
        let l = lines5();
        let edits = vec![EditInput {
            op: "replace".into(),
            pos: Some("1#ZZ".into()),
            end: None,
            lines: json!("bad"),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let err = apply_edits(&l, &parsed).unwrap_err();
        assert!(err.to_string().contains("Hash mismatch"));
    }

    #[test]
    fn append_after_position() {
        let l = lines5();
        let p = pos_for(&l, 2);
        let edits = vec![EditInput {
            op: "append".into(),
            pos: Some(p),
            end: None,
            lines: json!(["inserted A", "inserted B"]),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 7);
        assert_eq!(result[2], "inserted A");
        assert_eq!(result[3], "inserted B");
    }

    #[test]
    fn append_to_end_without_pos() {
        let l = lines5();
        let edits = vec![EditInput {
            op: "append".into(),
            pos: None,
            end: None,
            lines: json!("new last line"),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 6);
        assert_eq!(result[5], "new last line");
    }

    #[test]
    fn prepend_before_position() {
        let l = lines5();
        let p = pos_for(&l, 3);
        let edits = vec![EditInput {
            op: "prepend".into(),
            pos: Some(p),
            end: None,
            lines: json!("before three"),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 6);
        assert_eq!(result[2], "before three");
        assert_eq!(result[3], "line three");
    }

    #[test]
    fn prepend_to_start_without_pos() {
        let l = lines5();
        let edits = vec![EditInput {
            op: "prepend".into(),
            pos: None,
            end: None,
            lines: json!("new first line"),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 6);
        assert_eq!(result[0], "new first line");
    }

    #[test]
    fn delete_single_line_with_null() {
        let l = lines5();
        let p = pos_for(&l, 4);
        let edits = vec![EditInput {
            op: "replace".into(),
            pos: Some(p),
            end: None,
            lines: Value::Null,
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 4);
    }

    #[test]
    fn replace_range_of_lines() {
        let l = lines5();
        let p2 = pos_for(&l, 2);
        let p4 = pos_for(&l, 4);
        let edits = vec![EditInput {
            op: "replace".into(),
            pos: Some(p2),
            end: Some(p4),
            lines: json!(["combined line"]),
        }];
        let parsed = parse_edits(&edits).unwrap();
        let result = apply_edits(&l, &parsed).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], "line one");
        assert_eq!(result[1], "combined line");
        assert_eq!(result[2], "line five");
    }

    #[test]
    fn normalize_edit_lines_string_splits_on_newline() {
        let v = json!("a\nb\nc");
        let out = normalize_edit_lines(&v).unwrap();
        assert_eq!(out, vec!["a", "b", "c"]);
    }

    #[test]
    fn normalize_edit_lines_null_returns_none() {
        assert!(normalize_edit_lines(&Value::Null).is_none());
    }
}

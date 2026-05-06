use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

const TS_EXTENSIONS: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const RUST_EXTENSIONS: &[&str] = &[".rs"];

const GREP_INCLUDE_FLAGS: &[&str] = &[
    "--include=*.ts",
    "--include=*.tsx",
    "--include=*.js",
    "--include=*.jsx",
    "--include=*.rs",
    "--include=*.py",
];

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

fn http_ok(input: &Value, data: Value) -> Value {
    if input.get("headers").is_some() {
        json!({ "status_code": 200, "body": data })
    } else {
        data
    }
}

fn body_or_self(input: &Value) -> Value {
    input.get("body").cloned().unwrap_or_else(|| input.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lang {
    TypeScript,
    Rust,
    Unknown,
}

fn detect_language(path: &Path) -> Lang {
    let s = path.to_string_lossy().to_lowercase();
    for ext in TS_EXTENSIONS {
        if s.ends_with(ext) {
            return Lang::TypeScript;
        }
    }
    for ext in RUST_EXTENSIONS {
        if s.ends_with(ext) {
            return Lang::Rust;
        }
    }
    Lang::Unknown
}

fn parse_ts_diagnostics(output: &str) -> Vec<Value> {
    let pat = regex::Regex::new(r"^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$").unwrap();
    output
        .lines()
        .filter_map(|line| {
            pat.captures(line).map(|m| {
                json!({
                    "file": m.get(1).unwrap().as_str(),
                    "line": m.get(2).unwrap().as_str().parse::<u64>().unwrap_or(0),
                    "column": m.get(3).unwrap().as_str().parse::<u64>().unwrap_or(0),
                    "severity": m.get(4).unwrap().as_str(),
                    "message": m.get(5).unwrap().as_str(),
                })
            })
        })
        .collect()
}

fn parse_rust_diagnostics(output: &str) -> Vec<Value> {
    let mut diags = Vec::new();
    for line in output.lines() {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if msg.get("reason").and_then(|v| v.as_str()) != Some("compiler-message") {
            continue;
        }
        let message = match msg.get("message") {
            Some(m) => m,
            None => continue,
        };
        let spans = message.get("spans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let primary = spans
            .iter()
            .find(|s| s.get("is_primary").and_then(|b| b.as_bool()) == Some(true))
            .or_else(|| spans.first())
            .cloned();
        if let Some(span) = primary {
            diags.push(json!({
                "file": span.get("file_name").and_then(|v| v.as_str()).unwrap_or(""),
                "line": span.get("line_start").and_then(|v| v.as_u64()).unwrap_or(0),
                "column": span.get("column_start").and_then(|v| v.as_u64()).unwrap_or(0),
                "severity": message.get("level").and_then(|v| v.as_str()).unwrap_or("error"),
                "message": message.get("message").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }
    diags
}

fn extract_symbols(content: &str) -> Vec<Value> {
    let patterns: Vec<(regex::Regex, &str)> = vec![
        (regex::Regex::new(r"^(export\s+)?(?:async\s+)?function\s+(\w+)").unwrap(), "function"),
        (regex::Regex::new(r"^(export\s+)?class\s+(\w+)").unwrap(), "class"),
        (regex::Regex::new(r"^(export\s+)?(?:const|let|var)\s+(\w+)").unwrap(), "variable"),
        (regex::Regex::new(r"^(export\s+)?type\s+(\w+)").unwrap(), "type"),
        (regex::Regex::new(r"^(export\s+)?interface\s+(\w+)").unwrap(), "interface"),
        (regex::Regex::new(r"^(export\s+)?enum\s+(\w+)").unwrap(), "enum"),
        (regex::Regex::new(r"^export\s+default\s+(?:async\s+)?function\s+(\w+)?").unwrap(), "function"),
        (regex::Regex::new(r"^export\s+default\s+class\s+(\w+)?").unwrap(), "class"),
    ];

    let mut symbols = Vec::new();
    for (i, line) in content.lines().enumerate() {
        for (re, kind) in &patterns {
            if let Some(caps) = re.captures(line) {
                let exported = line.trim_start().starts_with("export");
                let name = if *kind == "function" || *kind == "class" {
                    caps.get(2).or_else(|| caps.get(1)).map(|m| m.as_str().to_string())
                } else {
                    caps.get(2).map(|m| m.as_str().to_string())
                };
                if let Some(n) = name
                    && !n.is_empty()
                    && n != "export"
                    && n != "async"
                {
                    symbols.push(json!({
                        "name": n,
                        "kind": kind,
                        "line": i + 1,
                        "exported": exported,
                    }));
                }
                break;
            }
        }
    }
    symbols
}

const DEFINITION_PATTERNS: &[(&str, &str)] = &[
    (r"(?:async\s+)?function\s+{SYMBOL}\b", "function"),
    (r"class\s+{SYMBOL}\b", "class"),
    (r"(?:const|let|var)\s+{SYMBOL}\b", "variable"),
    (r"type\s+{SYMBOL}\b", "type"),
    (r"interface\s+{SYMBOL}\b", "interface"),
    (r"enum\s+{SYMBOL}\b", "enum"),
];

async fn run_cmd(
    cmd: &str,
    args: &[&str],
    cwd: &Path,
    timeout_ms: u64,
) -> (String, String) {
    let mut command = Command::new(cmd);
    command.args(args).current_dir(cwd);

    let fut = async {
        match command.output().await {
            Ok(out) => (
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ),
            Err(_) => (String::new(), String::new()),
        }
    };

    tokio::time::timeout(Duration::from_millis(timeout_ms), fut)
        .await
        .unwrap_or_default()
}

fn rel_to_root(p: &Path) -> String {
    let root = workspace_root();
    p.strip_prefix(&root)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("lsp::diagnostics", move |input: Value| async move {
            let body = body_or_self(&input);
            let path = body
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("path is required".into()))?;
            let resolved = workspace_root().join(path);
            assert_path_contained(&resolved)?;

            let lang = detect_language(&resolved);
            let lang_str = match lang {
                Lang::TypeScript => "typescript",
                Lang::Rust => "rust",
                Lang::Unknown => "unknown",
            };

            let root = workspace_root();
            let rel_path = rel_to_root(&resolved);
            let diagnostics: Vec<Value>;

            match lang {
                Lang::TypeScript => {
                    let (stdout, stderr) =
                        run_cmd("npx", &["tsc", "--noEmit", "--pretty", "false"], &root, 30_000).await;
                    let combined = format!("{stdout}\n{stderr}");
                    diagnostics = parse_ts_diagnostics(&combined)
                        .into_iter()
                        .filter(|d| {
                            let f = d.get("file").and_then(|v| v.as_str()).unwrap_or("");
                            f == rel_path || f == resolved.to_string_lossy()
                        })
                        .collect();
                }
                Lang::Rust => {
                    let (stdout, stderr) =
                        run_cmd("cargo", &["check", "--message-format=json"], &root, 30_000).await;
                    let combined = format!("{stdout}\n{stderr}");
                    diagnostics = parse_rust_diagnostics(&combined)
                        .into_iter()
                        .filter(|d| {
                            let f = d.get("file").and_then(|v| v.as_str()).unwrap_or("");
                            f == rel_path || f == resolved.to_string_lossy()
                        })
                        .collect();
                }
                Lang::Unknown => {
                    return Ok::<Value, IIIError>(http_ok(
                        &input,
                        json!({
                            "path": resolved.to_string_lossy(),
                            "language": lang_str,
                            "diagnostics": [],
                            "unsupported": true,
                        }),
                    ));
                }
            }

            Ok::<Value, IIIError>(http_ok(
                &input,
                json!({
                    "path": resolved.to_string_lossy(),
                    "language": lang_str,
                    "diagnostics": diagnostics,
                }),
            ))
        })
        .description("Get compiler/linter errors for a file"),
    );

    iii.register_function(
        RegisterFunction::new_async("lsp::symbols", move |input: Value| async move {
            let body = body_or_self(&input);
            let path = body
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("path is required".into()))?;
            let resolved = workspace_root().join(path);
            assert_path_contained(&resolved)?;

            let content = tokio::fs::read_to_string(&resolved)
                .await
                .map_err(|e| IIIError::Handler(format!("read failed: {e}")))?;
            let symbols = extract_symbols(&content);

            Ok::<Value, IIIError>(http_ok(
                &input,
                json!({
                    "path": resolved.to_string_lossy(),
                    "symbols": symbols,
                }),
            ))
        })
        .description("List all symbols in a file"),
    );

    iii.register_function(
        RegisterFunction::new_async("lsp::references", move |input: Value| async move {
            let body = body_or_self(&input);
            let symbol = body
                .get("symbol")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("symbol is required".into()))?;
            if symbol.is_empty() {
                return Err(IIIError::Handler("symbol is required".into()));
            }
            let path = body.get("path").and_then(|v| v.as_str());
            let search_path = match path {
                Some(p) => {
                    let r = workspace_root().join(p);
                    assert_path_contained(&r)?;
                    r
                }
                None => workspace_root(),
            };
            let root = workspace_root();

            let mut grep_args: Vec<&str> = vec!["-rn"];
            grep_args.extend_from_slice(GREP_INCLUDE_FLAGS);
            grep_args.push("-w");
            grep_args.push(symbol);
            let search_str = search_path.to_string_lossy().into_owned();
            grep_args.push(&search_str);

            let (stdout, _stderr) = run_cmd("grep", &grep_args, &root, 10_000).await;
            let line_pat = regex::Regex::new(r"^(.+?):(\d+):(.+)$").unwrap();

            let mut references: Vec<Value> = Vec::new();
            for line in stdout.lines() {
                if line.is_empty() {
                    continue;
                }
                if let Some(c) = line_pat.captures(line) {
                    let file = c.get(1).unwrap().as_str();
                    let line_num: u64 = c.get(2).unwrap().as_str().parse().unwrap_or(0);
                    let content = c.get(3).unwrap().as_str().trim();
                    references.push(json!({
                        "file": rel_to_root(Path::new(file)),
                        "line": line_num,
                        "content": content,
                    }));
                }
                if references.len() >= 200 {
                    break;
                }
            }

            Ok::<Value, IIIError>(http_ok(
                &input,
                json!({
                    "symbol": symbol,
                    "references": references,
                }),
            ))
        })
        .description("Find all references to a symbol"),
    );

    iii.register_function(
        RegisterFunction::new_async("lsp::rename", move |input: Value| async move {
            let body = body_or_self(&input);
            let old_name = body
                .get("oldName")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("oldName and newName are required".into()))?;
            let new_name = body
                .get("newName")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("oldName and newName are required".into()))?;
            if old_name.is_empty() || new_name.is_empty() {
                return Err(IIIError::Handler("oldName and newName are required".into()));
            }

            let path = body.get("path").and_then(|v| v.as_str());
            let search_path = match path {
                Some(p) => {
                    let r = workspace_root().join(p);
                    assert_path_contained(&r)?;
                    r
                }
                None => workspace_root(),
            };
            let root = workspace_root();

            let mut grep_args: Vec<&str> = vec!["-rln"];
            grep_args.extend_from_slice(GREP_INCLUDE_FLAGS);
            grep_args.push("-w");
            grep_args.push(old_name);
            let search_str = search_path.to_string_lossy().into_owned();
            grep_args.push(&search_str);

            let (stdout, _stderr) = run_cmd("grep", &grep_args, &root, 10_000).await;
            let files: Vec<String> = stdout
                .lines()
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect();

            let dry_run = body
                .get("dryRun")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let escaped = regex::escape(old_name);
            let word_re = regex::Regex::new(&format!(r"\b{}\b", escaped))
                .map_err(|e| IIIError::Handler(e.to_string()))?;

            let mut planned: Vec<(String, String, u64)> = Vec::new();
            let mut total: u64 = 0;
            for file_path in &files {
                let p = Path::new(file_path);
                assert_path_contained(p)?;
                let content = match tokio::fs::read_to_string(p).await {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(file = %file_path, error = %e, "lsp_rename read failed");
                        continue;
                    }
                };
                let count = word_re.find_iter(&content).count() as u64;
                if count == 0 {
                    continue;
                }
                let updated = word_re.replace_all(&content, new_name).into_owned();
                planned.push((file_path.clone(), updated, count));
                total += count;
            }

            if dry_run {
                let preview: Vec<String> = planned
                    .iter()
                    .map(|(f, _, _)| rel_to_root(Path::new(f)))
                    .collect();
                return Ok::<Value, IIIError>(http_ok(
                    &input,
                    json!({
                        "oldName": old_name,
                        "newName": new_name,
                        "dryRun": true,
                        "wouldModify": preview,
                        "occurrences": total,
                    }),
                ));
            }

            let mut modified = 0u64;
            let mut failed: Vec<Value> = Vec::new();
            for (file_path, updated, count) in planned {
                let p = Path::new(&file_path);
                if let Err(e) = tokio::fs::write(p, updated).await {
                    tracing::error!(file = %file_path, error = %e, "lsp_rename write failed");
                    failed.push(json!({
                        "file": rel_to_root(p),
                        "error": e.to_string(),
                    }));
                    continue;
                }
                modified += 1;
                let _ = count;
            }

            Ok::<Value, IIIError>(http_ok(
                &input,
                json!({
                    "oldName": old_name,
                    "newName": new_name,
                    "filesModified": modified,
                    "occurrences": total,
                    "failed": failed,
                }),
            ))
        })
        .description("Rename a symbol across the project"),
    );

    iii.register_function(
        RegisterFunction::new_async("lsp::goto_definition", move |input: Value| async move {
            let body = body_or_self(&input);
            let symbol = body
                .get("symbol")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("symbol is required".into()))?;
            if symbol.is_empty() {
                return Err(IIIError::Handler("symbol is required".into()));
            }

            let escaped = regex::escape(symbol);
            let root = workspace_root();
            let line_pat = regex::Regex::new(r"^(.+?):(\d+):(.+)$").unwrap();

            for (regex_template, kind) in DEFINITION_PATTERNS {
                let pattern = regex_template.replace("{SYMBOL}", &escaped);
                let mut grep_args: Vec<&str> = vec!["-rn"];
                grep_args.extend_from_slice(GREP_INCLUDE_FLAGS);
                grep_args.push("-E");
                grep_args.push(&pattern);
                let root_str = root.to_string_lossy().into_owned();
                grep_args.push(&root_str);

                let (stdout, _stderr) = run_cmd("grep", &grep_args, &root, 5_000).await;
                if let Some(line) = stdout.lines().find(|l| !l.is_empty())
                    && let Some(c) = line_pat.captures(line)
                {
                    let file = c.get(1).unwrap().as_str();
                    let line_num: u64 = c.get(2).unwrap().as_str().parse().unwrap_or(0);
                    return Ok::<Value, IIIError>(http_ok(
                        &input,
                        json!({
                            "symbol": symbol,
                            "file": rel_to_root(Path::new(file)),
                            "line": line_num,
                            "kind": kind,
                        }),
                    ));
                }
            }

            Ok::<Value, IIIError>(http_ok(
                &input,
                json!({
                    "symbol": symbol,
                    "file": Value::Null,
                    "line": Value::Null,
                    "kind": Value::Null,
                    "notFound": true,
                }),
            ))
        })
        .description("Find where a symbol is defined"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "lsp::diagnostics".to_string(),
        config: json!({ "api_path": "api/lsp/diagnostics", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "lsp::symbols".to_string(),
        config: json!({ "api_path": "api/lsp/symbols", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "lsp::references".to_string(),
        config: json!({ "api_path": "api/lsp/references", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "lsp::rename".to_string(),
        config: json!({ "api_path": "api/lsp/rename", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "lsp::goto_definition".to_string(),
        config: json!({ "api_path": "api/lsp/goto-definition", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("lsp-tools worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_typescript() {
        assert_eq!(detect_language(Path::new("foo.ts")), Lang::TypeScript);
        assert_eq!(detect_language(Path::new("a.tsx")), Lang::TypeScript);
        assert_eq!(detect_language(Path::new("b.js")), Lang::TypeScript);
    }

    #[test]
    fn test_detect_rust() {
        assert_eq!(detect_language(Path::new("foo.rs")), Lang::Rust);
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(detect_language(Path::new("foo.py")), Lang::Unknown);
        assert_eq!(detect_language(Path::new("foo.txt")), Lang::Unknown);
    }

    #[test]
    fn test_parse_ts_diag_basic() {
        let s = "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.";
        let diags = parse_ts_diagnostics(s);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0]["line"], 10);
        assert_eq!(diags[0]["column"], 5);
        assert_eq!(diags[0]["severity"], "error");
    }

    #[test]
    fn test_parse_ts_diag_warning() {
        let s = "src/foo.ts(2,3): warning TS6133: 'x' is declared but never used.";
        let diags = parse_ts_diagnostics(s);
        assert_eq!(diags[0]["severity"], "warning");
    }

    #[test]
    fn test_parse_ts_diag_no_match() {
        let diags = parse_ts_diagnostics("random text");
        assert!(diags.is_empty());
    }

    #[test]
    fn test_parse_rust_diag_basic() {
        let line = r#"{"reason":"compiler-message","message":{"level":"error","message":"oops","spans":[{"is_primary":true,"file_name":"src/lib.rs","line_start":3,"column_start":1}]}}"#;
        let diags = parse_rust_diagnostics(line);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0]["line"], 3);
    }

    #[test]
    fn test_parse_rust_diag_skips_non_compiler() {
        let line = r#"{"reason":"build-script-executed"}"#;
        let diags = parse_rust_diagnostics(line);
        assert!(diags.is_empty());
    }

    #[test]
    fn test_extract_symbol_function() {
        let symbols = extract_symbols("export function add(a, b) { return a + b; }");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["name"], "add");
        assert_eq!(symbols[0]["kind"], "function");
        assert_eq!(symbols[0]["exported"], true);
    }

    #[test]
    fn test_extract_symbol_class() {
        let symbols = extract_symbols("class Foo {}");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["name"], "Foo");
        assert_eq!(symbols[0]["kind"], "class");
        assert_eq!(symbols[0]["exported"], false);
    }

    #[test]
    fn test_extract_symbol_const() {
        let symbols = extract_symbols("export const PI = 3.14;");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["name"], "PI");
        assert_eq!(symbols[0]["kind"], "variable");
    }

    #[test]
    fn test_extract_symbol_interface() {
        let symbols = extract_symbols("interface Bar { x: number; }");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["kind"], "interface");
    }

    #[test]
    fn test_extract_symbol_type() {
        let symbols = extract_symbols("export type Id = string;");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["kind"], "type");
    }

    #[test]
    fn test_extract_symbol_enum() {
        let symbols = extract_symbols("enum Color { Red, Blue }");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0]["kind"], "enum");
    }

    #[test]
    fn test_extract_symbol_async_function() {
        let symbols = extract_symbols("export async function foo() {}");
        assert_eq!(symbols[0]["name"], "foo");
        assert_eq!(symbols[0]["kind"], "function");
    }

    #[test]
    fn test_extract_symbol_multi_line() {
        let src = "export function f() {}\nclass C {}\nconst x = 1;";
        let symbols = extract_symbols(src);
        assert_eq!(symbols.len(), 3);
    }

    #[test]
    fn test_http_ok_with_headers() {
        let input = json!({ "headers": {} });
        let res = http_ok(&input, json!({ "ok": true }));
        assert_eq!(res, json!({ "status_code": 200, "body": { "ok": true } }));
    }

    #[test]
    fn test_http_ok_no_headers() {
        let input = json!({});
        let res = http_ok(&input, json!({ "ok": true }));
        assert_eq!(res, json!({ "ok": true }));
    }

    #[test]
    fn test_body_or_self_with_body() {
        let v = json!({ "body": { "x": 1 } });
        assert_eq!(body_or_self(&v), json!({ "x": 1 }));
    }

    #[test]
    fn test_body_or_self_no_body() {
        let v = json!({ "y": 2 });
        assert_eq!(body_or_self(&v), json!({ "y": 2 }));
    }
}

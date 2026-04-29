use iii_sdk::error::IIIError;
use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, register_worker};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

const SAFE_ENV_KEYS: &[&str] = &["PATH", "HOME", "USER", "LANG", "TERM", "NODE_ENV", "SHELL"];

fn safe_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in SAFE_ENV_KEYS {
        if let Ok(value) = std::env::var(key) {
            env.insert((*key).to_string(), value);
        }
    }
    env
}

fn workspace_root() -> PathBuf {
    std::env::var("WORKSPACE_ROOT")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

struct CliResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

async fn run_skillkit(args: &[&str], timeout_ms: u64) -> CliResult {
    let mut cmd = Command::new("npx");
    cmd.arg("skillkit").args(args);
    cmd.env_clear();
    for (k, v) in safe_env() {
        cmd.env(k, v);
    }
    cmd.current_dir(workspace_root());

    let timeout = Duration::from_millis(timeout_ms);
    let exec = cmd.output();

    match tokio::time::timeout(timeout, exec).await {
        Ok(Ok(output)) => {
            let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();
            stdout.truncate(100_000);
            stderr.truncate(50_000);
            let exit_code = output.status.code().unwrap_or(if output.status.success() { 0 } else { 1 });
            CliResult {
                stdout,
                stderr,
                exit_code,
            }
        }
        Ok(Err(e)) => CliResult {
            stdout: String::new(),
            stderr: format!("spawn failed: {e}"),
            exit_code: 1,
        },
        Err(_) => CliResult {
            stdout: String::new(),
            stderr: "skillkit timed out".to_string(),
            exit_code: 124,
        },
    }
}

fn parse_json_or_raw(stdout: &str, fallback_key: &str) -> Value {
    match serde_json::from_str::<Value>(stdout) {
        Ok(v) => json!({ fallback_key: v, "exitCode": 0 }),
        Err(_) => {
            let mut raw = stdout.to_string();
            raw.truncate(10_000);
            json!({ fallback_key: [], "raw": raw, "exitCode": 0 })
        }
    }
}

fn is_valid_skill_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '@' | '/' | '.'))
}

fn is_valid_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("skillkit::search", move |input: Value| async move {
            let query = input["query"].as_str().unwrap_or("").to_string();
            if query.len() < 2 {
                return Err(IIIError::Handler("Query must be at least 2 characters".into()));
            }
            let limit = input["limit"].as_u64().map(|l| l.min(50));

            let mut args: Vec<String> = vec!["search".into(), query, "--json".into()];
            if let Some(l) = limit {
                args.push("--limit".into());
                args.push(l.to_string());
            }
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

            let result = run_skillkit(&arg_refs, 30_000).await;
            if result.exit_code != 0 {
                return Ok::<Value, IIIError>(json!({
                    "results": [],
                    "error": result.stderr,
                    "exitCode": result.exit_code,
                }));
            }
            Ok(parse_json_or_raw(&result.stdout, "results"))
        })
        .description("Search the SkillKit marketplace for skills"),
    );

    iii.register_function(
        RegisterFunction::new_async("skillkit::install", move |input: Value| async move {
            let id = input["id"].as_str().unwrap_or("").to_string();
            if !is_valid_skill_id(&id) {
                return Err(IIIError::Handler("Invalid skill ID format".into()));
            }
            let agent = input["agent"].as_str().map(String::from);

            let mut args: Vec<String> = vec!["install".into(), id, "--json".into()];
            if let Some(ref a) = agent {
                if !is_valid_agent_name(a) {
                    return Err(IIIError::Handler("Invalid agent name".into()));
                }
                args.push("--agent".into());
                args.push(a.clone());
            }
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

            let result = run_skillkit(&arg_refs, 60_000).await;
            if result.exit_code != 0 {
                return Ok::<Value, IIIError>(json!({
                    "installed": false,
                    "error": result.stderr,
                    "exitCode": result.exit_code,
                }));
            }
            match serde_json::from_str::<Value>(&result.stdout) {
                Ok(v) => Ok(json!({ "installed": true, "result": v, "exitCode": 0 })),
                Err(_) => {
                    let mut raw = result.stdout;
                    raw.truncate(10_000);
                    Ok(json!({ "installed": true, "raw": raw, "exitCode": 0 }))
                }
            }
        })
        .description("Install a skill from the SkillKit marketplace"),
    );

    iii.register_function(
        RegisterFunction::new_async("skillkit::list", move |_: Value| async move {
            let result = run_skillkit(&["list", "--json"], 30_000).await;
            if result.exit_code != 0 {
                return Ok::<Value, IIIError>(json!({
                    "skills": [],
                    "error": result.stderr,
                    "exitCode": result.exit_code,
                }));
            }
            Ok(parse_json_or_raw(&result.stdout, "skills"))
        })
        .description("List installed SkillKit skills"),
    );

    iii.register_function(
        RegisterFunction::new_async("skillkit::recommend", move |input: Value| async move {
            let context = input["context"].as_str().map(String::from);
            let mut args: Vec<String> = vec!["recommend".into(), "--json".into()];
            if let Some(ref c) = context {
                args.push("--context".into());
                args.push(c.clone());
            }
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

            let result = run_skillkit(&arg_refs, 30_000).await;
            if result.exit_code != 0 {
                return Ok::<Value, IIIError>(json!({
                    "recommendations": [],
                    "error": result.stderr,
                    "exitCode": result.exit_code,
                }));
            }
            Ok(parse_json_or_raw(&result.stdout, "recommendations"))
        })
        .description("Get skill recommendations based on workspace context"),
    );

    iii.register_function(
        RegisterFunction::new_async("skillkit::scan", move |input: Value| async move {
            let scan_path = input["path"].as_str().unwrap_or(".");
            let root = workspace_root().join(scan_path);
            let mut found: Vec<Value> = Vec::new();
            scan_dir(&root, 0, &mut found).await;
            let count = found.len();
            Ok::<Value, IIIError>(json!({
                "found": found,
                "count": count,
                "root": root.to_string_lossy(),
            }))
        })
        .description("Scan workspace for .well-known/ and SKILL.md files"),
    );

    let triggers = [
        ("skillkit::search", "GET", "api/skillkit/search"),
        ("skillkit::install", "POST", "api/skillkit/install"),
        ("skillkit::list", "GET", "api/skillkit/list"),
        ("skillkit::recommend", "GET", "api/skillkit/recommend"),
        ("skillkit::scan", "GET", "api/skillkit/scan"),
    ];
    for (fid, method, path) in triggers {
        iii.register_trigger(RegisterTriggerInput {
            trigger_type: "http".to_string(),
            function_id: fid.to_string(),
            config: json!({ "http_method": method, "api_path": path }),
            metadata: None,
        })?;
    }

    tracing::info!("skillkit-bridge worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

fn scan_dir<'a>(
    dir: &'a Path,
    depth: u32,
    found: &'a mut Vec<Value>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        if depth > 3 || found.len() >= 50 {
            return;
        }
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e,
            Err(_) => return,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            if found.len() >= 50 {
                return;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();

            if name_str.starts_with('.') && name_str != ".well-known" {
                continue;
            }
            if name_str == "node_modules" {
                continue;
            }

            let full_path = entry.path();
            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };

            if name_str == "SKILL.md"
                && metadata.is_file()
                && let Ok(content) = tokio::fs::read_to_string(&full_path).await
            {
                let mut snippet = content;
                snippet.truncate(5_000);
                found.push(json!({
                    "type": "skill",
                    "path": full_path.to_string_lossy(),
                    "content": snippet,
                }));
            }

            if name_str == ".well-known"
                && metadata.is_dir()
                && let Ok(mut wk_entries) = tokio::fs::read_dir(&full_path).await
            {
                while let Ok(Some(wk)) = wk_entries.next_entry().await {
                    if found.len() >= 50 {
                        return;
                    }
                    if let Ok(wk_meta) = wk.metadata().await
                        && wk_meta.is_file()
                    {
                        let wk_path = wk.path();
                        let content = tokio::fs::read_to_string(&wk_path)
                            .await
                            .unwrap_or_default();
                        let mut snippet = content;
                        snippet.truncate(5_000);
                        found.push(json!({
                            "type": "well-known",
                            "path": wk_path.to_string_lossy(),
                            "content": snippet,
                        }));
                    }
                }
            }

            if metadata.is_dir() && depth < 3 && name_str != ".well-known" {
                scan_dir(&full_path, depth + 1, found).await;
            }
        }
    })
}

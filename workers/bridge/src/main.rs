use iii_sdk::{register_worker, InitOptions, III};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use dashmap::DashMap;
use std::sync::Arc;

mod types;

use types::{
    CancelRequest, InvokeRuntimeRequest, RegisterRuntimeRequest, RunStatus, RuntimeConfig,
    RuntimeKind, RuntimeRun,
};

fn runtimes_scope() -> &'static str {
    "bridge:runtimes"
}

fn runs_scope() -> &'static str {
    "bridge:runs"
}

async fn register_runtime(iii: &III, req: RegisterRuntimeRequest) -> Result<Value, IIIError> {
    let id = format!("rt-{}", uuid::Uuid::new_v4());

    let config = RuntimeConfig {
        id: id.clone(),
        kind: req.kind,
        name: req.name,
        command: req.command,
        args: req.args,
        url: req.url,
        headers: req.headers,
        env_vars: req.env_vars,
        work_dir: req.work_dir,
        timeout_secs: req.timeout_secs,
    };

    match config.kind {
        RuntimeKind::Process | RuntimeKind::ClaudeCode | RuntimeKind::Codex | RuntimeKind::Cursor | RuntimeKind::OpenCode => {
            if config.command.is_none() {
                return Err(IIIError::Handler("process-based runtimes require 'command'".into()));
            }
        }
        RuntimeKind::Http => {
            if config.url.is_none() {
                return Err(IIIError::Handler("http runtime requires 'url'".into()));
            }
        }
        RuntimeKind::Custom => {}
    }

    let value = serde_json::to_value(&config).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": runtimes_scope(),
        "key": &id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(serde_json::to_value(&config).unwrap())
}

async fn invoke_runtime(
    iii: &III,
    req: InvokeRuntimeRequest,
    active_runs: &Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
) -> Result<Value, IIIError> {
    let config_val = iii
        .trigger("state::get", json!({
            "scope": runtimes_scope(),
            "key": &req.runtime_id,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let config: RuntimeConfig =
        serde_json::from_value(config_val).map_err(|e| IIIError::Handler(format!("runtime {} not found: {e}", req.runtime_id)))?;

    let run_id = format!("brun-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let run = RuntimeRun {
        id: run_id.clone(),
        runtime_id: req.runtime_id.clone(),
        agent_id: req.agent_id.clone(),
        status: RunStatus::Running,
        output: None,
        error: None,
        exit_code: None,
        started_at: now,
        finished_at: None,
    };

    let run_val = serde_json::to_value(&run).map_err(|e| IIIError::Handler(e.to_string()))?;
    iii.trigger("state::set", json!({
        "scope": runs_scope(),
        "key": &run_id,
        "value": run_val,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let iii_bg = iii.clone();
    let run_id_bg = run_id.clone();
    let timeout = req.timeout_secs.or(config.timeout_secs).unwrap_or(300);

    let handle = tokio::spawn(async move {
        let result = execute_runtime(&iii_bg, &config, &req.context, timeout).await;

        let (status, output, error, exit_code) = match result {
            Ok(out) => (RunStatus::Completed, Some(out), None, Some(0)),
            Err(e) => (RunStatus::Failed, None, Some(e.to_string()), Some(1)),
        };

        let finished_run = RuntimeRun {
            id: run_id_bg.clone(),
            runtime_id: config.id.clone(),
            agent_id: req.agent_id.clone(),
            status,
            output,
            error,
            exit_code,
            started_at: run.started_at.clone(),
            finished_at: Some(chrono::Utc::now().to_rfc3339()),
        };

        let val = serde_json::to_value(&finished_run).unwrap();
        let _ = iii_bg.trigger("state::set", json!({
            "scope": runs_scope(),
            "key": &run_id_bg,
            "value": val,
        }))
        .await;

        let _ = iii_bg.trigger_void("publish", json!({
            "topic": "bridge.run.completed",
            "data": { "runId": run_id_bg, "status": format!("{:?}", finished_run.status).to_lowercase() },
        }));
    });

    active_runs.insert(run_id.clone(), handle);

    Ok(json!({
        "runId": run_id,
        "status": "running",
    }))
}

async fn execute_runtime(iii: &III, config: &RuntimeConfig, context: &Value, timeout_secs: u64) -> Result<String, IIIError> {
    let timeout = std::time::Duration::from_secs(timeout_secs);

    match config.kind {
        RuntimeKind::Http => {
            let url = config.url.as_deref().ok_or_else(|| IIIError::Handler("missing url".into()))?;

            let result = iii
                .trigger("http::post", json!({
                    "url": url,
                    "body": context,
                    "headers": config.headers,
                    "timeoutMs": timeout_secs * 1000,
                }))
                .await
                .map_err(|e| IIIError::Handler(format!("http invoke failed: {e}")))?;

            Ok(result.to_string())
        }

        RuntimeKind::Process | RuntimeKind::ClaudeCode | RuntimeKind::Codex | RuntimeKind::Cursor | RuntimeKind::OpenCode | RuntimeKind::Custom => {
            let cmd = config.command.as_deref().ok_or_else(|| IIIError::Handler("missing command".into()))?;
            let args = config.args.as_deref().unwrap_or(&[]);
            let context_str = serde_json::to_string(context).unwrap_or_default();

            let work_dir = if let Some(ref dir) = config.work_dir {
                let canonical = std::path::Path::new(dir)
                    .canonicalize()
                    .map_err(|e| IIIError::Handler(format!("invalid work_dir: {e}")))?;
                if !canonical.starts_with(std::env::current_dir().unwrap_or_default()) && !canonical.starts_with("/tmp") {
                    return Err(IIIError::Handler("work_dir must be under cwd or /tmp".into()));
                }
                canonical
            } else {
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
            };

            let mut command_args = args.to_vec();
            command_args.push(context_str);

            let result = tokio::time::timeout(timeout, async {
                let mut cmd_builder = tokio::process::Command::new(cmd);
                cmd_builder.args(&command_args).current_dir(&work_dir);

                if let Some(ref env_vars) = config.env_vars {
                    if let Some(obj) = env_vars.as_object() {
                        for (k, v) in obj {
                            if let Some(val) = v.as_str() {
                                cmd_builder.env(k, val);
                            }
                        }
                    }
                }

                let output = cmd_builder
                    .output()
                    .await
                    .map_err(|e| IIIError::Handler(format!("spawn failed: {e}")))?;

                if output.status.success() {
                    Ok(String::from_utf8_lossy(&output.stdout).to_string())
                } else {
                    Err(IIIError::Handler(
                        String::from_utf8_lossy(&output.stderr).to_string(),
                    ))
                }
            })
            .await
            .map_err(|_| IIIError::Handler("runtime execution timed out".into()))?;

            result
        }
    }
}

async fn cancel_run(
    active_runs: &Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
    iii: &III,
    req: CancelRequest,
) -> Result<Value, IIIError> {
    if let Some((_, handle)) = active_runs.remove(&req.run_id) {
        handle.abort();

        let _ = iii.trigger("state::update", json!({
            "scope": runs_scope(),
            "key": &req.run_id,
            "path": "status",
            "value": "cancelled",
        }))
        .await;

        Ok(json!({ "cancelled": true, "runId": req.run_id }))
    } else {
        Err(IIIError::Handler(format!("run {} not found or already completed", req.run_id)))
    }
}

async fn list_runtimes(iii: &III) -> Result<Value, IIIError> {
    iii.trigger("state::list", json!({ "scope": runtimes_scope() }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn get_run(iii: &III, run_id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::get", json!({
        "scope": runs_scope(),
        "key": run_id,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default())?;
    let active_runs: Arc<DashMap<String, tokio::task::JoinHandle<()>>> = Arc::new(DashMap::new());

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "bridge::register",
        "Register an external agent runtime",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: RegisterRuntimeRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                register_runtime(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    let runs_clone = active_runs.clone();
    iii.register_function_with_description(
        "bridge::invoke",
        "Invoke an agent through its runtime bridge",
        move |input: Value| {
            let iii = iii_clone.clone();
            let runs = runs_clone.clone();
            async move {
                let req: InvokeRuntimeRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                invoke_runtime(&iii, req, &runs).await
            }
        },
    );

    let iii_clone = iii.clone();
    let runs_clone = active_runs.clone();
    iii.register_function_with_description(
        "bridge::cancel",
        "Cancel a running bridge invocation",
        move |input: Value| {
            let iii = iii_clone.clone();
            let runs = runs_clone.clone();
            async move {
                let req: CancelRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                cancel_run(&runs, &iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "bridge::list",
        "List registered runtimes",
        move |_: Value| {
            let iii = iii_clone.clone();
            async move { list_runtimes(&iii).await }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "bridge::run",
        "Get status of a bridge run",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let run_id = input["runId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing runId".into()))?;
                get_run(&iii, run_id).await
            }
        },
    );

    iii.register_trigger("http", "bridge::register", json!({ "method": "POST", "path": "/api/bridge/runtimes" }))?;
    iii.register_trigger("http", "bridge::invoke", json!({ "method": "POST", "path": "/api/bridge/invoke" }))?;
    iii.register_trigger("http", "bridge::cancel", json!({ "method": "POST", "path": "/api/bridge/cancel" }))?;
    iii.register_trigger("http", "bridge::list", json!({ "method": "GET", "path": "/api/bridge/runtimes" }))?;
    iii.register_trigger("http", "bridge::run", json!({ "method": "GET", "path": "/api/bridge/runs/:runId" }))?;

    tracing::info!("bridge worker started");
    tokio::signal::ctrl_c().await?;

    for entry in active_runs.iter() {
        entry.value().abort();
    }
    active_runs.clear();

    iii.shutdown_async().await;
    Ok(())
}

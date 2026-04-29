use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker,
};
use serde_json::{Map, Value, json};

mod types;

use types::{ErrorMode, StepMode, StepResult, Workflow, WorkflowStep, sanitize_id};

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn interpolate(template: &str, vars: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len()
            && bytes[i] == b'{'
            && bytes[i + 1] == b'{'
            && let Some(end) = template[i + 2..].find("}}")
        {
            let key = &template[i + 2..i + 2 + end];
            if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                match vars.get(key) {
                    Some(Value::String(s)) => out.push_str(s),
                    Some(other) => out.push_str(&other.to_string()),
                    None => {
                        out.push_str("{{");
                        out.push_str(key);
                        out.push_str("}}");
                    }
                }
                i += 2 + end + 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn state_update(
    iii: &III,
    scope: &str,
    key: &str,
    operations: Value,
) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::update".to_string(),
        payload: json!({ "scope": scope, "key": key, "operations": operations }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn mark_run_failed(
    iii: &III,
    run_id: &str,
    error: &str,
    results: &[StepResult],
) -> Result<(), IIIError> {
    state_update(
        iii,
        "workflow_runs",
        run_id,
        json!([
            { "type": "set", "path": "status", "value": "failed" },
            { "type": "set", "path": "failedAt", "value": now_ms() },
            { "type": "set", "path": "error", "value": error },
            { "type": "set", "path": "results", "value": results },
        ]),
    )
    .await
}

async fn create_workflow(iii: &III, input: Value) -> Result<Value, IIIError> {
    let id = match input.get("id").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => sanitize_id(s).map_err(IIIError::Handler)?,
        _ => uuid::Uuid::new_v4().to_string(),
    };

    let mut workflow_value = input.clone();
    if let Some(obj) = workflow_value.as_object_mut() {
        obj.insert("id".into(), Value::String(id.clone()));
        obj.insert("createdAt".into(), json!(now_ms()));
    }

    state_set(iii, "workflows", &id, workflow_value).await?;
    Ok(json!({ "id": id }))
}

async fn run_step(
    iii: &III,
    workflow: &Workflow,
    step: &WorkflowStep,
    vars: &mut Map<String, Value>,
    results: &mut Vec<StepResult>,
    start_ms: u128,
    i: &mut usize,
) -> Result<(), IIIError> {
    match step.mode {
        StepMode::Sequential => {
            let template = step.prompt_template.as_deref().unwrap_or("{{input}}");
            let prompt = interpolate(template, vars);
            let mut payload = vars.clone();
            payload.insert("prompt".into(), Value::String(prompt));
            let output = iii
                .trigger(TriggerRequest {
                    function_id: step.function_id.clone(),
                    payload: Value::Object(payload),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .map_err(|e| IIIError::Handler(e.to_string()))?;
            if let Some(var) = &step.output_var {
                vars.insert(var.clone(), output.clone());
            }
            vars.insert("input".into(), output.clone());
            results.push(StepResult {
                step_name: step.name.clone(),
                output,
                duration_ms: now_ms().saturating_sub(start_ms),
                error: None,
            });
        }
        StepMode::Fanout => {
            let mut fanout_steps: Vec<&WorkflowStep> = Vec::new();
            let mut j = *i;
            while j < workflow.steps.len() && workflow.steps[j].mode == StepMode::Fanout {
                fanout_steps.push(&workflow.steps[j]);
                j += 1;
            }

            let mut handles = Vec::with_capacity(fanout_steps.len());
            for fs in &fanout_steps {
                let template = fs.prompt_template.as_deref().unwrap_or("{{input}}");
                let prompt = interpolate(template, vars);
                let mut payload = vars.clone();
                payload.insert("prompt".into(), Value::String(prompt));
                let iii_clone = iii.clone();
                let function_id = fs.function_id.clone();
                handles.push(tokio::spawn(async move {
                    iii_clone
                        .trigger(TriggerRequest {
                            function_id,
                            payload: Value::Object(payload),
                            action: None,
                            timeout_ms: None,
                        })
                        .await
                        .map_err(|e| IIIError::Handler(e.to_string()))
                }));
            }

            let mut fanout_results: Vec<Value> = Vec::with_capacity(handles.len());
            for h in handles {
                let v = h.await.map_err(|e| IIIError::Handler(e.to_string()))??;
                fanout_results.push(v);
            }

            vars.insert("__fanout".into(), Value::Array(fanout_results.clone()));
            for (idx, fs) in fanout_steps.iter().enumerate() {
                if let Some(var) = &fs.output_var {
                    vars.insert(var.clone(), fanout_results[idx].clone());
                }
                results.push(StepResult {
                    step_name: fs.name.clone(),
                    output: fanout_results[idx].clone(),
                    duration_ms: now_ms().saturating_sub(start_ms),
                    error: None,
                });
            }

            *i = j - 1;
        }
        StepMode::Collect => {
            let template = step.prompt_template.as_deref().unwrap_or("{{__fanout}}");
            let prompt = interpolate(template, vars);
            let mut payload = vars.clone();
            payload.insert(
                "fanoutResults".into(),
                vars.get("__fanout").cloned().unwrap_or(Value::Null),
            );
            payload.insert("prompt".into(), Value::String(prompt));
            let output = iii
                .trigger(TriggerRequest {
                    function_id: step.function_id.clone(),
                    payload: Value::Object(payload),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .map_err(|e| IIIError::Handler(e.to_string()))?;
            if let Some(var) = &step.output_var {
                vars.insert(var.clone(), output.clone());
            }
            vars.insert("input".into(), output.clone());
            results.push(StepResult {
                step_name: step.name.clone(),
                output,
                duration_ms: now_ms().saturating_sub(start_ms),
                error: None,
            });
        }
        StepMode::Conditional => {
            let prev_output = vars
                .get("input")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    vars.get("input")
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                });
            if let Some(cond) = &step.condition
                && !prev_output.to_lowercase().contains(&cond.to_lowercase())
            {
                results.push(StepResult {
                    step_name: step.name.clone(),
                    output: Value::String("skipped".into()),
                    duration_ms: now_ms().saturating_sub(start_ms),
                    error: None,
                });
                return Ok(());
            }
            let template = step.prompt_template.as_deref().unwrap_or("{{input}}");
            let prompt = interpolate(template, vars);
            let mut payload = vars.clone();
            payload.insert("prompt".into(), Value::String(prompt));
            let output = iii
                .trigger(TriggerRequest {
                    function_id: step.function_id.clone(),
                    payload: Value::Object(payload),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .map_err(|e| IIIError::Handler(e.to_string()))?;
            if let Some(var) = &step.output_var {
                vars.insert(var.clone(), output.clone());
            }
            vars.insert("input".into(), output.clone());
            results.push(StepResult {
                step_name: step.name.clone(),
                output,
                duration_ms: now_ms().saturating_sub(start_ms),
                error: None,
            });
        }
        StepMode::Loop => {
            let max = step.max_iterations.unwrap_or(10);
            let mut loop_output: Value = Value::Null;
            for iter in 0..max {
                let template = step.prompt_template.as_deref().unwrap_or("{{input}}");
                let prompt = interpolate(template, vars);
                let mut payload = vars.clone();
                payload.insert("prompt".into(), Value::String(prompt));
                payload.insert("iteration".into(), json!(iter));
                loop_output = iii
                    .trigger(TriggerRequest {
                        function_id: step.function_id.clone(),
                        payload: Value::Object(payload),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                if let Some(var) = &step.output_var {
                    vars.insert(var.clone(), loop_output.clone());
                }
                vars.insert("input".into(), loop_output.clone());

                if let Some(until) = &step.until {
                    let s = match &loop_output {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    if s.to_lowercase().contains(&until.to_lowercase()) {
                        break;
                    }
                }
            }
            results.push(StepResult {
                step_name: step.name.clone(),
                output: loop_output,
                duration_ms: now_ms().saturating_sub(start_ms),
                error: None,
            });
        }
    }
    Ok(())
}

async fn run_workflow(iii: &III, input: Value) -> Result<Value, IIIError> {
    let workflow_id = input
        .get("workflowId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("workflowId is required".into()))?;
    let safe_workflow_id = sanitize_id(workflow_id).map_err(IIIError::Handler)?;
    let agent_id = input.get("agentId").and_then(Value::as_str).map(String::from);
    let user_input = input.get("input").cloned().unwrap_or(Value::Null);

    let workflow_value = state_get(iii, "workflows", &safe_workflow_id).await?;
    if workflow_value.is_null() {
        return Err(IIIError::Handler(format!(
            "Workflow {safe_workflow_id} not found"
        )));
    }
    let workflow: Workflow = serde_json::from_value(workflow_value)
        .map_err(|e| IIIError::Handler(format!("invalid workflow definition: {e}")))?;

    if let Some(agent_id) = &agent_id {
        for step in &workflow.steps {
            let cap = step
                .function_id
                .split("::")
                .next()
                .unwrap_or(&step.function_id);
            iii.trigger(TriggerRequest {
                function_id: "security::check_capability".to_string(),
                payload: json!({
                    "agentId": agent_id,
                    "capability": cap,
                    "resource": step.function_id,
                }),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        }
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let safe_run_id = sanitize_id(&run_id).map_err(IIIError::Handler)?;

    let mut vars: Map<String, Value> = Map::new();
    vars.insert("input".into(), user_input);

    let mut results: Vec<StepResult> = Vec::new();

    state_set(
        iii,
        "workflow_runs",
        &safe_run_id,
        json!({
            "runId": safe_run_id,
            "workflowId": safe_workflow_id,
            "status": "running",
            "startedAt": now_ms(),
        }),
    )
    .await?;

    let mut i = 0;
    while i < workflow.steps.len() {
        let step = workflow.steps[i].clone();
        let start_ms = now_ms();

        let step_outcome = run_step(iii, &workflow, &step, &mut vars, &mut results, start_ms, &mut i).await;

        if let Err(err) = step_outcome {
            let err_msg = err.to_string();
            match step.error_mode {
                ErrorMode::Skip => {
                    results.push(StepResult {
                        step_name: step.name.clone(),
                        output: Value::Null,
                        duration_ms: now_ms().saturating_sub(start_ms),
                        error: Some(err_msg),
                    });
                }
                ErrorMode::Retry => {
                    let max_retries = step.max_retries.unwrap_or(3);
                    let mut retried = false;
                    for _ in 0..max_retries {
                        let template = step.prompt_template.as_deref().unwrap_or("{{input}}");
                        let prompt = interpolate(template, &vars);
                        let mut payload = vars.clone();
                        payload.insert("prompt".into(), Value::String(prompt));
                        match iii
                            .trigger(TriggerRequest {
                                function_id: step.function_id.clone(),
                                payload: Value::Object(payload),
                                action: None,
                                timeout_ms: None,
                            })
                            .await
                        {
                            Ok(output) => {
                                if let Some(var) = &step.output_var {
                                    vars.insert(var.clone(), output.clone());
                                }
                                vars.insert("input".into(), output.clone());
                                results.push(StepResult {
                                    step_name: step.name.clone(),
                                    output,
                                    duration_ms: now_ms().saturating_sub(start_ms),
                                    error: None,
                                });
                                retried = true;
                                break;
                            }
                            Err(_) => continue,
                        }
                    }
                    if !retried {
                        mark_run_failed(iii, &safe_run_id, &err_msg, &results).await?;
                        return Err(err);
                    }
                }
                ErrorMode::Fail => {
                    mark_run_failed(iii, &safe_run_id, &err_msg, &results).await?;
                    return Err(err);
                }
            }
        }

        i += 1;
    }

    state_update(
        iii,
        "workflow_runs",
        &safe_run_id,
        json!([
            { "type": "set", "path": "status", "value": "completed" },
            { "type": "set", "path": "completedAt", "value": now_ms() },
            { "type": "set", "path": "results", "value": results },
        ]),
    )
    .await?;

    Ok::<Value, IIIError>(json!({
        "runId": safe_run_id,
        "results": results,
        "vars": vars,
    }))
}

async fn list_workflows(iii: &III) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": "workflows" }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

fn safe_pagination(limit: Option<i64>, offset: Option<i64>) -> (usize, usize) {
    let limit = limit.unwrap_or(50).clamp(1, 500) as usize;
    let offset = offset.unwrap_or(0).max(0) as usize;
    (limit, offset)
}

async fn list_runs(iii: &III, input: Value) -> Result<Value, IIIError> {
    let workflow_id = input
        .get("workflowId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("workflowId is required".into()))?;
    let safe_workflow_id = sanitize_id(workflow_id).map_err(IIIError::Handler)?;

    let (limit, offset) = safe_pagination(
        input.get("limit").and_then(Value::as_i64),
        input.get("offset").and_then(Value::as_i64),
    );

    let all = iii
        .trigger(TriggerRequest {
            function_id: "state::list".to_string(),
            payload: json!({ "scope": "workflow_runs" }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let arr = all.as_array().cloned().unwrap_or_default();
    let total = arr.len();
    let filtered: Vec<Value> = arr
        .into_iter()
        .filter(|r| {
            r.get("value")
                .and_then(|v| v.get("workflowId"))
                .and_then(Value::as_str)
                .map(|w| w == safe_workflow_id)
                .unwrap_or(false)
        })
        .skip(offset)
        .take(limit)
        .collect();

    Ok::<Value, IIIError>(json!({
        "runs": filtered,
        "total": total,
        "limit": limit,
        "offset": offset,
    }))
}

async fn get_run_state(iii: &III, run_id: &str) -> Result<Value, IIIError> {
    let safe_run_id = sanitize_id(run_id).map_err(IIIError::Handler)?;
    state_get(iii, "workflow_runs", &safe_run_id).await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("workflow::create", move |input: Value| {
            let iii = iii_clone.clone();
            async move { create_workflow(&iii, input).await }
        })
        .description("Register a workflow definition"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("workflow::run", move |input: Value| {
            let iii = iii_clone.clone();
            async move { run_workflow(&iii, input).await }
        })
        .description("Execute a workflow"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("workflow::list", move |_input: Value| {
            let iii = iii_clone.clone();
            async move { list_workflows(&iii).await }
        })
        .description("List all workflows"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("workflow::runs", move |input: Value| {
            let iii = iii_clone.clone();
            async move { list_runs(&iii, input).await }
        })
        .description("List runs for a workflow"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("workflow::get_run_state", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let run_id = input
                    .get("runId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| IIIError::Handler("runId is required".into()))?;
                get_run_state(&iii, run_id).await
            }
        })
        .description("Read a workflow run by ID"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "workflow::run".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/workflows/run" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "workflow::create".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/workflows" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "workflow::list".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/workflows" }),
        metadata: None,
    })?;

    tracing::info!("workflow worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolate_replaces_string() {
        let mut vars = Map::new();
        vars.insert("input".into(), Value::String("hello".into()));
        assert_eq!(interpolate("hi {{input}}!", &vars), "hi hello!");
    }

    #[test]
    fn interpolate_keeps_unknown() {
        let vars = Map::new();
        assert_eq!(interpolate("{{missing}}", &vars), "{{missing}}");
    }

    #[test]
    fn interpolate_serializes_non_string() {
        let mut vars = Map::new();
        vars.insert("count".into(), json!(42));
        assert_eq!(interpolate("n={{count}}", &vars), "n=42");
    }

    #[test]
    fn safe_pagination_clamps() {
        assert_eq!(safe_pagination(Some(0), Some(-5)), (1, 0));
        assert_eq!(safe_pagination(Some(10000), Some(20)), (500, 20));
        assert_eq!(safe_pagination(None, None), (50, 0));
    }
}

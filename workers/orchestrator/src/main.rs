use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Plan {
    id: String,
    description: String,
    complexity: String,
    agents: Vec<String>,
    reactions: Vec<Reaction>,
    #[serde(rename = "createdAt")]
    created_at: i64,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Reaction {
    from: String,
    to: String,
    action: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Run {
    #[serde(rename = "planId")]
    plan_id: String,
    #[serde(rename = "rootId")]
    root_id: String,
    #[serde(rename = "startedAt")]
    started_at: i64,
    status: String,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed);
    trimmed.trim().to_string()
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ':' | '.'))
        .take(256)
        .collect()
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".into(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_list(iii: &III, scope: &str) -> Vec<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".into(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

async fn plan_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let description = body["description"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("description is required".into()))?
        .to_string();
    let model = body["model"].as_str().unwrap_or("default").to_string();

    let llm_result = iii
        .trigger(TriggerRequest {
            function_id: "llm::chat".into(),
            payload: json!({
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "Analyze the following feature request. Return JSON: { \"complexity\": \"low\"|\"medium\"|\"high\", \"agents\": [\"<template-name>\", ...], \"reactions\": [{ \"from\": \"<lifecycle-state>\", \"to\": \"<lifecycle-state>\", \"action\": \"send_to_agent\"|\"notify\"|\"escalate\", \"payload\": {} }], \"summary\": \"...\" }",
                    },
                    { "role": "user", "content": description },
                ],
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(Value::Null);

    let content = llm_result
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(&strip_code_fences(content))
        .unwrap_or_else(|_| {
            tracing::warn!("Failed to parse LLM plan");
            json!({
                "complexity": "medium",
                "agents": ["general"],
                "reactions": [],
                "summary": description,
            })
        });

    let plan_id = uuid::Uuid::new_v4().to_string();
    let plan = Plan {
        id: plan_id.clone(),
        description: description.clone(),
        complexity: parsed["complexity"].as_str().unwrap_or("medium").to_string(),
        agents: parsed["agents"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_else(|| vec!["general".to_string()]),
        reactions: parsed["reactions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        created_at: now_ms(),
        status: "planned".into(),
    };

    let plan_value = serde_json::to_value(&plan).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "orchestrator_plans", &plan_id, plan_value).await?;

    tracing::info!(plan_id = %plan_id, complexity = %plan.complexity, "Plan created");
    Ok(serde_json::to_value(&plan).unwrap())
}

async fn execute_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let plan_id = body["planId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId is required".into()))?
        .to_string();

    let plan_val = state_get(iii, "orchestrator_plans", &plan_id).await?;
    if plan_val.is_null() {
        return Err(IIIError::Handler("Plan not found".into()));
    }
    let mut plan: Plan = serde_json::from_value(plan_val.clone())
        .map_err(|e| IIIError::Handler(format!("plan decode: {e}")))?;
    if plan.status != "planned" {
        return Err(IIIError::Handler(format!(
            "Cannot execute plan in status: {}",
            plan.status
        )));
    }

    let decompose = iii
        .trigger(TriggerRequest {
            function_id: "task::decompose".into(),
            payload: json!({ "description": plan.description }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("task::decompose failed: {e}")))?;

    let root_id = decompose["rootId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("Task decomposition failed".into()))?
        .to_string();

    let run = Run {
        plan_id: plan_id.clone(),
        root_id: root_id.clone(),
        started_at: now_ms(),
        status: "running".into(),
    };

    state_set(iii, "orchestrator_runs", &plan_id, serde_json::to_value(&run).unwrap()).await?;

    for reaction in &plan.reactions {
        let reaction_id = uuid::Uuid::new_v4().to_string();
        let _ = state_set(
            iii,
            "lifecycle_reactions",
            &reaction_id,
            json!({
                "id": reaction_id,
                "from": reaction.from,
                "to": reaction.to,
                "action": reaction.action,
                "payload": reaction.payload,
                "escalateAfter": 3,
                "attempts": 0,
            }),
        )
        .await;
    }

    plan.status = "executing".into();
    state_set(
        iii,
        "orchestrator_plans",
        &plan_id,
        serde_json::to_value(&plan).unwrap(),
    )
    .await?;

    let workspace_scope = format!("workspace:{plan_id}");
    let _ = state_set(
        iii,
        &workspace_scope,
        "_meta",
        json!({
            "key": "_meta",
            "value": { "planId": plan_id, "rootId": root_id, "description": plan.description },
            "writtenBy": "orchestrator",
            "writtenAt": now_ms(),
        }),
    )
    .await;

    let spawn_result = iii
        .trigger(TriggerRequest {
            function_id: "task::spawn_workers".into(),
            payload: json!({ "rootId": root_id }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(Value::Null);

    let spawned = spawn_result
        .get("spawned")
        .cloned()
        .unwrap_or_else(|| json!([]));

    Ok(json!({
        "planId": plan_id,
        "rootId": root_id,
        "workspaceScope": workspace_scope,
        "spawned": spawned,
    }))
}

async fn status_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let plan_id = body["planId"].as_str().map(String::from);

    let Some(plan_id) = plan_id else {
        let plans = state_list(iii, "orchestrator_plans").await;
        let summaries: Vec<Value> = plans
            .into_iter()
            .map(|p| {
                let p = p.get("value").cloned().unwrap_or(p);
                json!({
                    "id": p.get("id"),
                    "status": p.get("status"),
                    "complexity": p.get("complexity"),
                    "createdAt": p.get("createdAt"),
                })
            })
            .collect();
        let count = summaries.len();
        return Ok(json!({ "count": count, "plans": summaries }));
    };

    let plan = state_get(iii, "orchestrator_plans", &plan_id).await?;
    if plan.is_null() {
        return Err(IIIError::Handler("Plan not found".into()));
    }

    let run = state_get(iii, "orchestrator_runs", &plan_id)
        .await
        .unwrap_or(Value::Null);
    if run.is_null() {
        return Ok(json!({ "plan": plan, "progress": null }));
    }

    let root_id = run.get("rootId").and_then(|v| v.as_str()).unwrap_or("");
    let task_scope = format!("tasks:{root_id}");
    let task_entries = state_list(iii, &task_scope).await;
    let tasks: Vec<Value> = task_entries
        .into_iter()
        .map(|e| e.get("value").cloned().unwrap_or(e))
        .collect();
    let total = tasks.len();
    let completed = tasks
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("complete"))
        .count();
    let failed = tasks
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("failed"))
        .count();
    let percentage = if total > 0 {
        (completed as f64 / total as f64 * 100.0).round() as i64
    } else {
        0
    };

    Ok(json!({
        "plan": plan,
        "progress": {
            "rootId": root_id,
            "total": total,
            "completed": completed,
            "failed": failed,
            "percentage": percentage,
            "runStatus": run.get("status"),
        },
    }))
}

async fn intervene_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let plan_id = body["planId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId and action are required".into()))?
        .to_string();
    let action = body["action"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId and action are required".into()))?
        .to_string();
    let redirect_to = body["redirectTo"].as_str().map(String::from);

    let valid = ["pause", "resume", "cancel", "redirect"];
    if !valid.contains(&action.as_str()) {
        return Err(IIIError::Handler(format!(
            "Invalid action: {action}. Must be one of: pause, resume, cancel, redirect"
        )));
    }

    let plan_val = state_get(iii, "orchestrator_plans", &plan_id).await?;
    if plan_val.is_null() {
        return Err(IIIError::Handler("Plan not found".into()));
    }
    let mut plan: Plan = serde_json::from_value(plan_val)
        .map_err(|e| IIIError::Handler(format!("plan decode: {e}")))?;

    let run_val = state_get(iii, "orchestrator_runs", &plan_id)
        .await
        .unwrap_or(Value::Null);
    let mut run: Option<Run> = if run_val.is_null() {
        None
    } else {
        serde_json::from_value(run_val).ok()
    };

    match action.as_str() {
        "pause" => {
            plan.status = "paused".into();
            if let Some(r) = run.as_mut() {
                r.status = "paused".into();
                let _ = state_set(iii, "orchestrator_runs", &plan_id, serde_json::to_value(r).unwrap()).await;
            }
        }
        "resume" => {
            plan.status = "executing".into();
            if let Some(r) = run.as_mut() {
                r.status = "running".into();
                let root_id = r.root_id.clone();
                let _ = state_set(iii, "orchestrator_runs", &plan_id, serde_json::to_value(r).unwrap()).await;
                let iii_clone = iii.clone();
                tokio::spawn(async move {
                    let _ = iii_clone
                        .trigger(TriggerRequest {
                            function_id: "task::spawn_workers".into(),
                            payload: json!({ "rootId": root_id }),
                            action: None,
                            timeout_ms: None,
                        })
                        .await;
                });
            }
        }
        "cancel" => {
            plan.status = "cancelled".into();
            if let Some(r) = run.as_mut() {
                r.status = "cancelled".into();
                let _ = state_set(iii, "orchestrator_runs", &plan_id, serde_json::to_value(r).unwrap()).await;
            }
        }
        "redirect" => {
            let new_desc = redirect_to
                .ok_or_else(|| IIIError::Handler("redirectTo is required for redirect action".into()))?;
            plan.description = new_desc;
            plan.status = "planned".into();
            if let Some(r) = run.as_mut() {
                r.status = "cancelled".into();
                let _ = state_set(iii, "orchestrator_runs", &plan_id, serde_json::to_value(r).unwrap()).await;
            }
        }
        _ => unreachable!(),
    }

    state_set(
        iii,
        "orchestrator_plans",
        &plan_id,
        serde_json::to_value(&plan).unwrap(),
    )
    .await?;

    Ok(json!({
        "planId": plan_id,
        "action": action,
        "newStatus": plan.status,
    }))
}

async fn workspace_write_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let plan_id = body["planId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId and key are required".into()))?
        .to_string();
    let key = body["key"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId and key are required".into()))?
        .to_string();
    let value = body.get("value").cloned().unwrap_or(Value::Null);
    let agent_id = body["agentId"].as_str().map(String::from);

    let safe_plan_id = sanitize_id(&plan_id);
    let safe_key = sanitize_id(&key);
    let safe_agent_id = agent_id.as_deref().map(sanitize_id);
    let written_by = safe_agent_id.unwrap_or_else(|| "system".to_string());

    let entry = json!({
        "key": &safe_key,
        "value": value,
        "writtenBy": written_by,
        "writtenAt": now_ms(),
    });

    let scope = format!("workspace:{safe_plan_id}");
    state_set(iii, &scope, &safe_key, entry).await?;

    Ok(json!({ "written": true, "key": safe_key, "planId": safe_plan_id }))
}

async fn workspace_read_handler(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let plan_id = body["planId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("planId is required".into()))?
        .to_string();
    let key = body["key"].as_str().map(String::from);

    let safe_plan_id = sanitize_id(&plan_id);
    let scope = format!("workspace:{safe_plan_id}");

    if let Some(k) = key {
        let safe_key = sanitize_id(&k);
        let entry = state_get(iii, &scope, &safe_key).await?;
        return Ok(entry);
    }

    let entries = state_list(iii, &scope).await;
    let count = entries.len();
    let mapped: Vec<Value> = entries
        .into_iter()
        .map(|e| e.get("value").cloned().unwrap_or(e))
        .collect();

    Ok(json!({
        "planId": safe_plan_id,
        "count": count,
        "entries": mapped,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::plan", move |input: Value| {
            let iii = iii_clone.clone();
            async move { plan_handler(&iii, input).await }
        })
        .description("Analyze a feature request and create an execution plan with agents and reactions"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::execute", move |input: Value| {
            let iii = iii_clone.clone();
            async move { execute_handler(&iii, input).await }
        })
        .description("Decompose tasks, register lifecycle reactions, and spawn workers for a plan"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::status", move |input: Value| {
            let iii = iii_clone.clone();
            async move { status_handler(&iii, input).await }
        })
        .description("Get plan progress or list all plans"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::intervene", move |input: Value| {
            let iii = iii_clone.clone();
            async move { intervene_handler(&iii, input).await }
        })
        .description("Intervene in plan execution: pause, resume, cancel, or redirect"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::workspace_write", move |input: Value| {
            let iii = iii_clone.clone();
            async move { workspace_write_handler(&iii, input).await }
        })
        .description("Write to shared plan workspace"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("orchestrator::workspace_read", move |input: Value| {
            let iii = iii_clone.clone();
            async move { workspace_read_handler(&iii, input).await }
        })
        .description("Read from shared plan workspace"),
    );

    let triggers = [
        ("orchestrator::plan", "POST", "api/orchestrator/plan"),
        ("orchestrator::execute", "POST", "api/orchestrator/execute"),
        ("orchestrator::status", "POST", "api/orchestrator/status"),
        ("orchestrator::intervene", "POST", "api/orchestrator/intervene"),
        ("orchestrator::workspace_write", "POST", "api/orchestrator/workspace"),
        ("orchestrator::workspace_read", "GET", "api/orchestrator/workspace"),
    ];
    for (fid, method, path) in triggers {
        iii.register_trigger(RegisterTriggerInput {
            trigger_type: "http".into(),
            function_id: fid.to_string(),
            config: json!({ "http_method": method, "api_path": path }),
            metadata: None,
        })?;
    }

    tracing::info!("orchestrator worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_json_fence() {
        assert_eq!(strip_code_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fences("```\nx\n```"), "x");
        assert_eq!(strip_code_fences("plain"), "plain");
    }

    #[test]
    fn sanitize_id_strips_unsafe_chars() {
        assert_eq!(sanitize_id("plan/../etc"), "plan..etc");
        assert_eq!(sanitize_id("workspace:abc-123"), "workspace:abc-123");
    }
}

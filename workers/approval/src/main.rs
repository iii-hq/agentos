use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker,
};
use serde_json::{Value, json};

mod types;

use types::sanitize_id;

const MAX_PENDING_PER_AGENT: usize = 5;
const DEFAULT_TIMEOUT_MS: u64 = 300_000;

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn fire_and_forget(iii: &III, function_id: &str, payload: Value) {
    let iii_clone = iii.clone();
    let function_id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii_clone
            .trigger(TriggerRequest {
                function_id,
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

async fn check(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let tool_name = input
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("toolName is required".into()))?;
    let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
    let params = input.get("params").cloned().unwrap_or(json!({}));

    let policy = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "approval_policy", "key": "default" }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(Value::Null);

    if policy.is_null() {
        return Ok::<Value, IIIError>(json!({ "required": false }));
    }

    let tools = policy
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requires_approval = tools.iter().any(|p| match p.as_str() {
        Some("*") => true,
        Some(pat) if pat.ends_with("::*") => tool_name.starts_with(&pat[..pat.len() - 1]),
        Some(pat) => tool_name == pat,
        None => false,
    });

    if !requires_approval {
        return Ok::<Value, IIIError>(json!({ "required": false }));
    }

    let pending = iii
        .trigger(TriggerRequest {
            function_id: "state::list".to_string(),
            payload: json!({ "scope": format!("approvals:{safe_agent_id}") }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!([]));

    let pending_count = pending
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|p| {
                    p.get("value")
                        .and_then(|v| v.get("status"))
                        .and_then(Value::as_str)
                        == Some("pending")
                })
                .count()
        })
        .unwrap_or(0);

    if pending_count >= MAX_PENDING_PER_AGENT {
        return Err(IIIError::Handler(format!(
            "Agent {safe_agent_id} has {pending_count} pending approvals (max {MAX_PENDING_PER_AGENT})"
        )));
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let timeout_ms = policy
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    let request = json!({
        "id": request_id,
        "agentId": safe_agent_id,
        "toolName": tool_name,
        "params": params,
        "reason": format!("Agent {safe_agent_id} wants to execute {tool_name}"),
        "createdAt": now_ms(),
        "timeoutMs": timeout_ms,
        "status": "pending",
    });

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": format!("approvals:{safe_agent_id}"),
            "key": request_id,
            "value": request,
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": "approval.requested",
            "data": { "requestId": request_id, "agentId": safe_agent_id, "toolName": tool_name },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "required": true,
        "approved": false,
        "status": "pending",
        "requestId": request_id,
    }))
}

async fn decide(iii: &III, input: Value) -> Result<Value, IIIError> {
    let request_id = input
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("requestId is required".into()))?;
    let agent_id = input
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let decision = input
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("decision is required".into()))?;

    let safe_request_id = sanitize_id(request_id).map_err(IIIError::Handler)?;
    let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
    let status = if decision == "approve" {
        "approved"
    } else {
        "denied"
    };
    let decided_by = input
        .get("decidedBy")
        .and_then(Value::as_str)
        .unwrap_or("system");

    iii.trigger(TriggerRequest {
        function_id: "state::update".to_string(),
        payload: json!({
            "scope": format!("approvals:{safe_agent_id}"),
            "key": safe_request_id,
            "operations": [
                { "type": "set", "path": "status", "value": status },
                { "type": "set", "path": "decidedBy", "value": decided_by },
                { "type": "set", "path": "decidedAt", "value": now_ms() },
            ],
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": "approval.decided",
            "data": {
                "requestId": safe_request_id,
                "agentId": safe_agent_id,
                "decision": status,
                "decidedBy": decided_by,
            },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "requestId": safe_request_id,
        "status": status,
    }))
}

async fn list(iii: &III, input: Value) -> Result<Value, IIIError> {
    let filter_status = input
        .get("status")
        .and_then(Value::as_str)
        .map(String::from);

    if let Some(agent_id) = input.get("agentId").and_then(Value::as_str) {
        let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
        let items = iii
            .trigger(TriggerRequest {
                function_id: "state::list".to_string(),
                payload: json!({ "scope": format!("approvals:{safe_agent_id}") }),
                action: None,
                timeout_ms: None,
            })
            .await
            .unwrap_or(json!([]));
        let arr = items.as_array().cloned().unwrap_or_default();
        let out: Vec<Value> = arr
            .into_iter()
            .filter_map(|i| i.get("value").cloned())
            .filter(|v| match &filter_status {
                None => true,
                Some(s) => v.get("status").and_then(Value::as_str) == Some(s),
            })
            .collect();
        return Ok::<Value, IIIError>(Value::Array(out));
    }

    let scopes = iii
        .trigger(TriggerRequest {
            function_id: "state::list_groups".to_string(),
            payload: json!({}),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!([]));
    let scopes_arr = scopes.as_array().cloned().unwrap_or_default();

    let mut all: Vec<Value> = Vec::new();
    for scope_v in scopes_arr {
        let scope = match scope_v.as_str() {
            Some(s) if s.starts_with("approvals:") => s.to_string(),
            _ => continue,
        };
        let items = iii
            .trigger(TriggerRequest {
                function_id: "state::list".to_string(),
                payload: json!({ "scope": scope }),
                action: None,
                timeout_ms: None,
            })
            .await
            .unwrap_or(json!([]));
        let arr = items.as_array().cloned().unwrap_or_default();
        for item in arr {
            if let Some(value) = item.get("value").cloned() {
                let pass = match &filter_status {
                    None => true,
                    Some(s) => value.get("status").and_then(Value::as_str) == Some(s),
                };
                if pass {
                    all.push(value);
                }
            }
        }
    }

    all.sort_by(|a, b| {
        let a_t = a.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
        let b_t = b.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
        b_t.cmp(&a_t)
    });

    Ok::<Value, IIIError>(Value::Array(all))
}

async fn wait(iii: &III, input: Value) -> Result<Value, IIIError> {
    let request_id = input
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("requestId is required".into()))?;
    let agent_id = input
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let safe_request_id = sanitize_id(request_id).map_err(IIIError::Handler)?;
    let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;

    let current = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
                "scope": format!("approvals:{safe_agent_id}"),
                "key": safe_request_id,
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(Value::Null);

    if current.is_null() {
        return Ok::<Value, IIIError>(json!({ "status": "not_found" }));
    }

    let status = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending")
        .to_string();

    if status == "approved" || status == "denied" {
        let audit_type = if status == "approved" {
            "approval_granted"
        } else {
            "approval_denied"
        };
        let tool_name = current
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let decided_by = current
            .get("decidedBy")
            .and_then(Value::as_str)
            .unwrap_or("");
        fire_and_forget(
            iii,
            "security::audit",
            json!({
                "type": audit_type,
                "agentId": safe_agent_id,
                "detail": {
                    "requestId": safe_request_id,
                    "toolName": tool_name,
                    "decidedBy": decided_by,
                },
            }),
        );
    }

    let mut response = json!({ "status": status, "requestId": safe_request_id });
    if status != "pending" {
        response["decision"] = current;
    }
    Ok::<Value, IIIError>(response)
}

async fn set_policy(iii: &III, input: Value) -> Result<Value, IIIError> {
    let tools = input.get("tools").cloned().unwrap_or(json!([]));
    let timeout_ms = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": "approval_policy",
            "key": "default",
            "value": { "tools": tools, "timeoutMs": timeout_ms },
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok::<Value, IIIError>(json!({ "updated": true }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::check", move |input: Value| {
            let iii = iii_clone.clone();
            async move { check(&iii, input).await }
        })
        .description("Check if tool requires approval and gate execution"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::decide", move |input: Value| {
            let iii = iii_clone.clone();
            async move { decide(&iii, input).await }
        })
        .description("Approve or deny a pending request"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::list", move |input: Value| {
            let iii = iii_clone.clone();
            async move { list(&iii, input).await }
        })
        .description("List pending approvals"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::wait", move |input: Value| {
            let iii = iii_clone.clone();
            async move { wait(&iii, input).await }
        })
        .description("Poll approval status (non-blocking)"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::set_policy", move |input: Value| {
            let iii = iii_clone.clone();
            async move { set_policy(&iii, input).await }
        })
        .description("Set approval policy"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::list".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/approvals" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::decide".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/approvals/decide" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::wait".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/approvals/wait" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::set_policy".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/approvals/policy" }),
        metadata: None,
    })?;

    tracing::info!("approval worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

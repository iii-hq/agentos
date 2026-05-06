use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;

mod types;

use types::{ApprovalTier, sanitize_id};

fn auto_tools() -> &'static HashSet<&'static str> {
    static AUTO: OnceLock<HashSet<&'static str>> = OnceLock::new();
    AUTO.get_or_init(|| {
        [
            "fn::file_read",
            "fn::file_list",
            "fn::web_search",
            "fn::web_fetch",
            "memory::recall",
            "memory::search",
            "fn::code_analyze",
            "fn::code_explain",
            "fn::uuid_generate",
            "fn::hash_compute",
            "fn::json_parse",
            "fn::json_stringify",
            "fn::json_query",
            "fn::csv_parse",
            "fn::csv_stringify",
            "fn::yaml_parse",
            "fn::yaml_stringify",
            "fn::regex_match",
            "fn::regex_replace",
            "skill::list",
            "skill::get",
            "skill::search",
            "a2a::well_known",
            "a2a::list_cards",
        ]
        .into_iter()
        .collect()
    })
}

fn async_tools() -> &'static HashSet<&'static str> {
    static ASYNC: OnceLock<HashSet<&'static str>> = OnceLock::new();
    ASYNC.get_or_init(|| {
        [
            "fn::file_write",
            "fn::apply_patch",
            "fn::code_format",
            "fn::code_lint",
            "fn::todo_create",
            "fn::todo_update",
            "fn::todo_list",
            "fn::cron_create",
            "fn::cron_list",
            "fn::cron_delete",
            "memory::store",
            "memory::forget",
            "skill::install",
            "skill::uninstall",
        ]
        .into_iter()
        .collect()
    })
}

fn sync_tools() -> &'static HashSet<&'static str> {
    static SYNC: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SYNC.get_or_init(|| {
        [
            "fn::shell_exec",
            "fn::agent_spawn",
            "fn::agent_send",
            "fn::agent_delegate",
            "fn::media_download",
            "fn::network_check",
            "fn::code_test",
            "fn::env_get",
            "agent::create",
            "agent::delete",
            "swarm::create",
            "swarm::dissolve",
        ]
        .into_iter()
        .collect()
    })
}

fn safe_shell_commands() -> &'static HashSet<&'static str> {
    static SAFE: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SAFE.get_or_init(|| {
        [
            "ls", "cat", "head", "tail", "wc", "grep", "find", "echo", "date", "whoami", "pwd",
            "which",
        ]
        .into_iter()
        .collect()
    })
}

fn classify_tool(tool_id: &str) -> ApprovalTier {
    if auto_tools().contains(tool_id) {
        return ApprovalTier::Auto;
    }
    if async_tools().contains(tool_id) {
        return ApprovalTier::Async;
    }
    if sync_tools().contains(tool_id) {
        return ApprovalTier::Sync;
    }
    let prefix = tool_id.split("::").next().unwrap_or("");
    if prefix == "memory" || prefix == "skill" {
        ApprovalTier::Auto
    } else {
        ApprovalTier::Async
    }
}

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

fn validate_tier_input(input: &Value) -> Result<(), IIIError> {
    if let Some(raw_cost) = input.get("cost") {
        if raw_cost.is_null() {
            return Ok(());
        }
        let cost = raw_cost
            .as_f64()
            .ok_or_else(|| IIIError::Handler("invalid cost: must be a number".into()))?;
        if cost < 0.0 || !cost.is_finite() {
            return Err(IIIError::Handler(format!(
                "invalid cost: {cost} (must be non-negative)"
            )));
        }
    }
    Ok(())
}

async fn classify(iii: &III, input: Value) -> Result<Value, IIIError> {
    validate_tier_input(&input)?;
    let tool_id = input
        .get("toolId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("toolId is required".into()))?
        .to_string();

    let mut tier = classify_tool(&tool_id);

    if let Some(agent_id) = input.get("agentId").and_then(Value::as_str) {
        let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
        let config = iii
            .trigger(TriggerRequest {
                function_id: "state::get".to_string(),
                payload: json!({ "scope": "agents", "key": safe_agent_id }),
                action: None,
                timeout_ms: None,
            })
            .await
            .unwrap_or(Value::Null);

        if let Some(overrides) = config
            .get("approvalOverrides")
            .and_then(Value::as_object)
            && let Some(override_str) = overrides.get(&tool_id).and_then(Value::as_str)
            && let Some(t) = ApprovalTier::from_str(override_str)
        {
            tier = t;
        }
    }

    if tool_id == "fn::shell_exec"
        && tier == ApprovalTier::Sync
        && let Some(command) = input
            .get("args")
            .and_then(|a| a.get("command"))
            .and_then(Value::as_str)
    {
        let cmd = command.split_whitespace().next().unwrap_or("");
        if safe_shell_commands().contains(cmd) {
            tier = ApprovalTier::Async;
        }
    }

    Ok::<Value, IIIError>(json!({
        "toolId": tool_id,
        "tier": tier.as_str(),
    }))
}

async fn decide_tier(iii: &III, input: Value) -> Result<Value, IIIError> {
    validate_tier_input(&input)?;
    let tool_id = input
        .get("toolId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("toolId is required".into()))?
        .to_string();
    let agent_id = input
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
    let args = input.get("args").cloned().unwrap_or(Value::Null);

    let classification = iii
        .trigger(TriggerRequest {
            function_id: "approval::classify".to_string(),
            payload: json!({
                "toolId": tool_id,
                "args": args,
                "agentId": safe_agent_id,
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let tier_str = classification
        .get("tier")
        .and_then(Value::as_str)
        .unwrap_or("async");
    let tier = ApprovalTier::from_str(tier_str).unwrap_or(ApprovalTier::Async);

    fire_and_forget(
        iii,
        "security::audit",
        json!({
            "type": "approval_tier_classified",
            "agentId": safe_agent_id,
            "detail": { "toolId": tool_id, "tier": tier.as_str() },
        }),
    );

    if tier == ApprovalTier::Auto {
        return Ok::<Value, IIIError>(json!({
            "approved": true,
            "tier": tier.as_str(),
            "toolId": tool_id,
        }));
    }

    let approval_id = uuid::Uuid::new_v4().to_string();
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": format!("tier_approvals:{safe_agent_id}"),
            "key": approval_id,
            "value": {
                "id": approval_id,
                "agentId": safe_agent_id,
                "toolId": tool_id,
                "args": args,
                "tier": tier.as_str(),
                "status": "pending",
                "createdAt": now_ms(),
            },
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
            "data": {
                "approvalId": approval_id,
                "agentId": safe_agent_id,
                "toolId": tool_id,
                "tier": tier.as_str(),
            },
        }),
    );

    if tier == ApprovalTier::Async {
        return Ok::<Value, IIIError>(json!({
            "approved": false,
            "tier": tier.as_str(),
            "status": "pending",
            "approvalId": approval_id,
        }));
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut poll_interval = std::time::Duration::from_millis(500);
    while std::time::Instant::now() < deadline {
        let current = iii
            .trigger(TriggerRequest {
                function_id: "state::get".to_string(),
                payload: json!({
                    "scope": format!("tier_approvals:{safe_agent_id}"),
                    "key": approval_id,
                }),
                action: None,
                timeout_ms: None,
            })
            .await
            .unwrap_or(Value::Null);

        let status = current.get("status").and_then(Value::as_str);
        if status == Some("approved") {
            return Ok::<Value, IIIError>(json!({
                "approved": true,
                "tier": tier.as_str(),
                "approvalId": approval_id,
            }));
        }
        if status == Some("denied") {
            return Ok::<Value, IIIError>(json!({
                "approved": false,
                "tier": tier.as_str(),
                "approvalId": approval_id,
                "reason": "denied",
            }));
        }

        tokio::time::sleep(poll_interval).await;
        let next = poll_interval.as_millis() as f64 * 1.5;
        let capped = next.min(5000.0) as u64;
        poll_interval = std::time::Duration::from_millis(capped);
    }

    iii.trigger(TriggerRequest {
        function_id: "state::update".to_string(),
        payload: json!({
            "scope": format!("tier_approvals:{safe_agent_id}"),
            "key": approval_id,
            "operations": [
                { "type": "set", "path": "status", "value": "timed_out" },
            ],
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok::<Value, IIIError>(json!({
        "approved": false,
        "tier": tier.as_str(),
        "approvalId": approval_id,
        "reason": "timeout",
    }))
}

async fn list_pending_tiers(iii: &III, input: Value) -> Result<Value, IIIError> {
    if let Some(agent_id) = input.get("agentId").and_then(Value::as_str) {
        let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
        let items = iii
            .trigger(TriggerRequest {
                function_id: "state::list".to_string(),
                payload: json!({ "scope": format!("tier_approvals:{safe_agent_id}") }),
                action: None,
                timeout_ms: None,
            })
            .await
            .unwrap_or(json!([]));

        let arr = items.as_array().cloned().unwrap_or_default();
        let mut out: Vec<Value> = arr
            .into_iter()
            .filter_map(|i| i.get("value").cloned())
            .filter(|v| v.get("status").and_then(Value::as_str) == Some("pending"))
            .collect();
        out.sort_by(|a, b| {
            let a_t = a.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
            let b_t = b.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
            b_t.cmp(&a_t)
        });
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
            Some(s) if s.starts_with("tier_approvals:") => s.to_string(),
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
            if let Some(value) = item.get("value").cloned()
                && value.get("status").and_then(Value::as_str) == Some("pending")
            {
                all.push(value);
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

async fn decide_tier_request(iii: &III, input: Value) -> Result<Value, IIIError> {
    let approval_id = input
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("approvalId is required".into()))?;
    let agent_id = input
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let decision = input
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("decision is required".into()))?;

    let safe_approval_id = sanitize_id(approval_id).map_err(IIIError::Handler)?;
    let safe_agent_id = sanitize_id(agent_id).map_err(IIIError::Handler)?;
    let status = match decision {
        "approve" => "approved",
        "deny" => "denied",
        other => {
            return Err(IIIError::Handler(format!(
                "Invalid decision: {other} (expected approve|deny)"
            )));
        }
    };
    let decided_by = input
        .get("decidedBy")
        .and_then(Value::as_str)
        .unwrap_or("system");

    iii.trigger(TriggerRequest {
        function_id: "state::update".to_string(),
        payload: json!({
            "scope": format!("tier_approvals:{safe_agent_id}"),
            "key": safe_approval_id,
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
        "security::audit",
        json!({
            "type": format!("approval_tier_{status}"),
            "agentId": safe_agent_id,
            "detail": { "approvalId": safe_approval_id, "decidedBy": decided_by },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "approvalId": safe_approval_id,
        "status": status,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::classify", move |input: Value| {
            let iii = iii_clone.clone();
            async move { classify(&iii, input).await }
        })
        .description("Classify a tool invocation into an approval tier"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::decide_tier", move |input: Value| {
            let iii = iii_clone.clone();
            async move { decide_tier(&iii, input).await }
        })
        .description("Route a tool call to the appropriate approval tier"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::list_pending_tiers", move |input: Value| {
            let iii = iii_clone.clone();
            async move { list_pending_tiers(&iii, input).await }
        })
        .description("List pending tier-based approval requests"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("approval::decide_tier_request", move |input: Value| {
            let iii = iii_clone.clone();
            async move { decide_tier_request(&iii, input).await }
        })
        .description("Approve or deny a tier-based approval request"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::list_pending_tiers".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/approvals/pending" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "approval::decide_tier_request".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/approvals/:id/decide" }),
        metadata: None,
    })?;

    tracing::info!("approval-tiers worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_known_auto() {
        assert_eq!(classify_tool("fn::file_read"), ApprovalTier::Auto);
        assert_eq!(classify_tool("memory::recall"), ApprovalTier::Auto);
    }

    #[test]
    fn classify_known_async() {
        assert_eq!(classify_tool("fn::file_write"), ApprovalTier::Async);
        assert_eq!(classify_tool("skill::install"), ApprovalTier::Async);
    }

    #[test]
    fn classify_known_sync() {
        assert_eq!(classify_tool("fn::shell_exec"), ApprovalTier::Sync);
        assert_eq!(classify_tool("agent::create"), ApprovalTier::Sync);
    }

    #[test]
    fn classify_falls_back_to_prefix() {
        assert_eq!(classify_tool("memory::weird_new"), ApprovalTier::Auto);
        assert_eq!(classify_tool("skill::weird_new"), ApprovalTier::Auto);
        assert_eq!(classify_tool("custom::tool"), ApprovalTier::Async);
    }

    #[test]
    fn validate_rejects_negative_cost() {
        let bad = json!({ "toolId": "x", "cost": -1.0 });
        assert!(validate_tier_input(&bad).is_err());
    }

    #[test]
    fn validate_rejects_negative_via_string_to_number_path() {
        let bad: Value =
            serde_json::from_str(r#"{ "toolId": "x", "cost": -0.5 }"#).expect("parse");
        assert!(validate_tier_input(&bad).is_err());
    }

    #[test]
    fn validate_accepts_zero_cost() {
        let ok = json!({ "toolId": "x", "cost": 0.0 });
        assert!(validate_tier_input(&ok).is_ok());
    }

    #[test]
    fn validate_accepts_missing_cost() {
        let ok = json!({ "toolId": "x" });
        assert!(validate_tier_input(&ok).is_ok());
    }

    #[test]
    fn validate_rejects_non_numeric_cost() {
        let bad = json!({ "toolId": "x", "cost": "not-a-number" });
        assert!(validate_tier_input(&bad).is_err());
        let bad = json!({ "toolId": "x", "cost": [1, 2, 3] });
        assert!(validate_tier_input(&bad).is_err());
        let bad = json!({ "toolId": "x", "cost": true });
        assert!(validate_tier_input(&bad).is_err());
    }

    #[test]
    fn validate_accepts_null_cost() {
        let ok = json!({ "toolId": "x", "cost": null });
        assert!(validate_tier_input(&ok).is_ok());
    }
}

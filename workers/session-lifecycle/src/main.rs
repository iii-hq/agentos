use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerAction, TriggerRequest,
    register_worker,
};
use serde_json::{Value, json};

mod types;

use types::{LifecycleState, Reaction};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn fire_void(iii: &III, function_id: &str, payload: Value) {
    let iii = iii.clone();
    let id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: id,
                payload,
                action: Some(TriggerAction::Void),
                timeout_ms: None,
            })
            .await;
    });
}

async fn safe_state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".into(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .filter(|v| !v.is_null())
}

async fn safe_state_list(iii: &III, scope: &str) -> Vec<Value> {
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

async fn transition(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("agentId required".into()))?;
    let new_state_str = input["newState"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("newState required".into()))?;
    let new_state = LifecycleState::from_str(new_state_str)
        .ok_or_else(|| IIIError::Handler(format!("invalid newState: {new_state_str}")))?;
    let reason = input["reason"].as_str().unwrap_or("").to_string();

    let scope = format!("lifecycle:{agent_id}");
    let current = safe_state_get(iii, &scope, "state").await;
    let current_state_str = current
        .as_ref()
        .and_then(|v| v["state"].as_str())
        .unwrap_or("spawning");
    let current_state = LifecycleState::from_str(current_state_str).unwrap_or(LifecycleState::Spawning);

    if current_state.is_terminal() {
        return Ok(json!({
            "transitioned": false,
            "reason": format!("Cannot transition from terminal state: {}", current_state.as_str()),
        }));
    }

    if !current_state.allows(new_state) {
        return Ok(json!({
            "transitioned": false,
            "reason": format!("Invalid transition: {} → {}", current_state.as_str(), new_state.as_str()),
        }));
    }

    let entry = json!({
        "state": new_state.as_str(),
        "previousState": current_state.as_str(),
        "reason": reason,
        "transitionedAt": now_ms(),
    });

    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({ "scope": &scope, "key": "state", "value": entry }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger(TriggerRequest {
        function_id: "state::update".into(),
        payload: json!({
            "scope": &scope,
            "key": "history",
            "operations": [
                { "type": "merge", "path": "transitions", "value": [entry] }
            ]
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    fire_void(
        iii,
        "hook::fire",
        json!({
            "type": "SessionStateChange",
            "agentId": agent_id,
            "from": current_state.as_str(),
            "to": new_state.as_str(),
            "reason": reason,
        }),
    );

    let agent_scope = format!("lifecycle_reactions:{agent_id}");
    let agent_reactions = safe_state_list(iii, &agent_scope).await;
    let global_reactions = safe_state_list(iii, "lifecycle_reactions").await;

    let mut combined: Vec<(String, Value)> = Vec::new();
    for r in &agent_reactions {
        combined.push((agent_scope.clone(), r.clone()));
    }
    for r in &global_reactions {
        combined.push(("lifecycle_reactions".into(), r.clone()));
    }

    for (scope_name, raw) in combined {
        let value = &raw["value"];
        let Ok(reaction) = serde_json::from_value::<Reaction>(value.clone()) else {
            continue;
        };
        if reaction.from != current_state || reaction.to != new_state {
            continue;
        }

        if reaction.attempts >= reaction.escalate_after {
            fire_void(
                iii,
                "hook::fire",
                json!({
                    "type": "LifecycleEscalation",
                    "agentId": agent_id,
                    "reaction": reaction.id,
                    "attempts": reaction.attempts,
                }),
            );
            continue;
        }

        match reaction.action.as_str() {
            "send_to_agent" => {
                let message = reaction.payload["message"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| {
                        format!(
                            "State changed: {} → {}",
                            current_state.as_str(),
                            new_state.as_str()
                        )
                    });
                fire_void(
                    iii,
                    "tool::agent_send",
                    json!({ "targetAgentId": agent_id, "message": message }),
                );
            }
            "auto_recover" => {
                fire_void(iii, "recovery::recover", json!({ "agentId": agent_id }));
            }
            "notify" => {
                fire_void(
                    iii,
                    "hook::fire",
                    json!({
                        "type": "LifecycleNotification",
                        "agentId": agent_id,
                        "from": current_state.as_str(),
                        "to": new_state.as_str(),
                        "payload": reaction.payload,
                    }),
                );
            }
            "escalate" => {
                fire_void(
                    iii,
                    "hook::fire",
                    json!({
                        "type": "LifecycleEscalation",
                        "agentId": agent_id,
                        "reaction": reaction.id,
                        "attempts": reaction.attempts,
                        "immediate": true,
                    }),
                );
            }
            _ => {}
        }

        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::update".into(),
                payload: json!({
                    "scope": scope_name,
                    "key": reaction.id,
                    "operations": [
                        { "type": "increment", "path": "attempts", "value": 1 },
                        { "type": "set", "path": "lastFiredAt", "value": now_ms() }
                    ]
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    }

    tracing::info!(
        agent_id = agent_id,
        from = current_state.as_str(),
        to = new_state.as_str(),
        "Lifecycle transition"
    );

    Ok(json!({
        "transitioned": true,
        "from": current_state.as_str(),
        "to": new_state.as_str(),
    }))
}

async fn get_state(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("agentId required".into()))?;
    let scope = format!("lifecycle:{agent_id}");
    let state = safe_state_get(iii, &scope, "state").await;
    Ok(state.unwrap_or_else(|| json!({ "state": "spawning", "transitionedAt": now_ms() })))
}

async fn add_reaction(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("agentId required".into()))?;
    let from = input["from"]
        .as_str()
        .and_then(LifecycleState::from_str)
        .ok_or_else(|| IIIError::Handler("invalid from state".into()))?;
    let to = input["to"]
        .as_str()
        .and_then(LifecycleState::from_str)
        .ok_or_else(|| IIIError::Handler("invalid to state".into()))?;
    let action = input["action"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("action required".into()))?
        .to_string();
    let payload = input.get("payload").cloned().unwrap_or_else(|| json!({}));
    let raw_escalate = input["escalateAfter"].as_i64().unwrap_or(3);
    let escalate_after = raw_escalate.max(1) as u32;

    let id = format!(
        "rxn_{}_{}",
        now_ms(),
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    );

    let reaction = Reaction {
        id: id.clone(),
        from,
        to,
        action,
        payload,
        escalate_after,
        attempts: 0,
    };

    let scope = format!("lifecycle_reactions:{agent_id}");
    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({
            "scope": scope,
            "key": &id,
            "value": serde_json::to_value(&reaction).map_err(|e| IIIError::Handler(e.to_string()))?
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({ "id": id, "registered": true }))
}

async fn list_reactions(iii: &III, input: Value) -> Result<Value, IIIError> {
    let scope = match input["agentId"].as_str() {
        Some(id) if !id.is_empty() => format!("lifecycle_reactions:{id}"),
        _ => "lifecycle_reactions".to_string(),
    };
    let entries = safe_state_list(iii, &scope).await;
    let values: Vec<Value> = entries
        .into_iter()
        .filter_map(|e| {
            let v = e.get("value").cloned()?;
            if v.is_null() { None } else { Some(v) }
        })
        .collect();
    Ok(json!(values))
}

async fn check_all(iii: &III) -> Result<Value, IIIError> {
    let agents = safe_state_list(iii, "agents").await;
    let valid_agents: Vec<String> = agents
        .iter()
        .filter_map(|a| a["key"].as_str().map(String::from))
        .filter(|k| !k.is_empty())
        .collect();

    let mut active: Vec<(String, Value)> = Vec::new();
    for agent_id in &valid_agents {
        let scope = format!("lifecycle:{agent_id}");
        if let Some(state) = safe_state_get(iii, &scope, "state").await {
            let is_terminal = state["state"]
                .as_str()
                .and_then(LifecycleState::from_str)
                .map(|s| s.is_terminal())
                .unwrap_or(false);
            if !is_terminal {
                active.push((agent_id.clone(), state));
            }
        }
    }

    let mut transitioned = 0;
    let two_hours_ms: i64 = 2 * 60 * 60 * 1000;
    let now = now_ms();

    for (agent_id, state) in active {
        let guard_stats = iii
            .trigger(TriggerRequest {
                function_id: "guard::stats".into(),
                payload: json!({ "agentId": &agent_id }),
                action: None,
                timeout_ms: None,
            })
            .await
            .ok();

        let circuit_broken = guard_stats
            .as_ref()
            .and_then(|s| s["circuitBroken"].as_bool())
            .unwrap_or(false);

        let state_name = state["state"].as_str().unwrap_or("");

        if circuit_broken && state_name == "working" {
            let _ = iii
                .trigger(TriggerRequest {
                    function_id: "lifecycle::transition".into(),
                    payload: json!({
                        "agentId": &agent_id,
                        "newState": "blocked",
                        "reason": "Circuit breaker tripped"
                    }),
                    action: None,
                    timeout_ms: None,
                })
                .await;
            transitioned += 1;
            continue;
        }

        if state_name == "working"
            && let Some(transitioned_at) = state["transitionedAt"].as_i64()
                && now - transitioned_at > two_hours_ms {
                    let _ = iii
                        .trigger(TriggerRequest {
                            function_id: "lifecycle::transition".into(),
                            payload: json!({
                                "agentId": &agent_id,
                                "newState": "blocked",
                                "reason": "Inactive for 2+ hours"
                            }),
                            action: None,
                            timeout_ms: None,
                        })
                        .await;
                    transitioned += 1;
                }
    }

    Ok(json!({ "checked": valid_agents.len(), "transitioned": transitioned }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("lifecycle::transition", move |input: Value| {
            let iii = iii_ref.clone();
            async move { transition(&iii, input).await }
        })
        .description("Move session to new state, validate transition, fire reactions"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("lifecycle::get_state", move |input: Value| {
            let iii = iii_ref.clone();
            async move { get_state(&iii, input).await }
        })
        .description("Get current lifecycle state for a session"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("lifecycle::add_reaction", move |input: Value| {
            let iii = iii_ref.clone();
            async move { add_reaction(&iii, input).await }
        })
        .description("Register a declarative reaction rule for state transitions"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("lifecycle::list_reactions", move |input: Value| {
            let iii = iii_ref.clone();
            async move { list_reactions(&iii, input).await }
        })
        .description("List configured reaction rules"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("lifecycle::check_all", move |_input: Value| {
            let iii = iii_ref.clone();
            async move { check_all(&iii).await }
        })
        .description("Scan all sessions, detect state changes, auto-transition"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "lifecycle::transition".into(),
        config: json!({ "http_method": "POST", "api_path": "api/lifecycle/transition" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "lifecycle::get_state".into(),
        config: json!({ "http_method": "GET", "api_path": "api/lifecycle/state/:agentId" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "lifecycle::add_reaction".into(),
        config: json!({ "http_method": "POST", "api_path": "api/lifecycle/reactions" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "lifecycle::list_reactions".into(),
        config: json!({ "http_method": "GET", "api_path": "api/lifecycle/reactions" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".into(),
        function_id: "lifecycle::check_all".into(),
        config: json!({ "expression": "*/2 * * * *" }),
        metadata: None,
    })?;

    tracing::info!("session-lifecycle worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

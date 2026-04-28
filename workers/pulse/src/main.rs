use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{ContextMode, InvokeRequest, PulseConfig, PulseRun, PulseStatus, RegisterPulseRequest};




fn config_scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:pulse:config")
}

fn runs_scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:pulse:runs")
}

async fn build_context(iii: &III, agent_id: &str, realm_id: &str, mode: &ContextMode) -> Value {
    match mode {
        ContextMode::Thin => {
            json!({
                "agentId": agent_id,
                "realmId": realm_id,
                "mode": "thin",
            })
        }
        ContextMode::Full => {
            let missions = iii
                .trigger(TriggerRequest {
                    function_id: "mission::list".to_string(),
                    payload: json!({
                    "realmId": realm_id,
                    "assigneeId": agent_id,
                    "status": "active",
                }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .unwrap_or(json!({ "missions": [] }));

            let budget = iii
                .trigger(TriggerRequest {
                    function_id: "ledger::check".to_string(),
                    payload: json!({
                    "realmId": realm_id,
                    "agentId": agent_id,
                }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .unwrap_or(json!({ "allowed": true }));

            let hierarchy = iii
                .trigger(TriggerRequest {
                    function_id: "hierarchy::chain".to_string(),
                    payload: json!({
                    "realmId": realm_id,
                    "agentId": agent_id,
                }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .unwrap_or(json!({ "chain": [] }));

            let directives = iii
                .trigger(TriggerRequest {
                    function_id: "directive::list".to_string(),
                    payload: json!({
                    "realmId": realm_id,
                    "status": "active",
                }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .unwrap_or(json!({ "directives": [] }));

            json!({
                "agentId": agent_id,
                "realmId": realm_id,
                "mode": "full",
                "missions": missions["missions"],
                "budget": budget,
                "chain": hierarchy["chain"],
                "directives": directives["directives"],
            })
        }
    }
}

async fn register_pulse(iii: &III, req: RegisterPulseRequest) -> Result<Value, IIIError> {
    let config = PulseConfig {
        agent_id: req.agent_id.clone(),
        realm_id: req.realm_id.clone(),
        cron: req.cron.clone(),
        enabled: true,
        context_mode: req.context_mode.unwrap_or(ContextMode::Thin),
        timeout_secs: req.timeout_secs,
        max_retries: req.max_retries,
    };

    let value = serde_json::to_value(&config).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
        "scope": config_scope(&req.realm_id),
        "key": &req.agent_id,
        "value": value,
    }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "engine::triggers::register".to_string(),
            payload: json!({
            "type": "cron",
            "function": "pulse::tick",
            "config": {
                "schedule": req.cron,
                "data": { "agentId": req.agent_id, "realmId": req.realm_id },
            },
        }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("failed to register cron trigger: {e}")))?;

    Ok(serde_json::to_value(&config).unwrap())
}

async fn invoke_pulse(iii: &III, req: InvokeRequest) -> Result<Value, IIIError> {
    let realm_id = &req.realm_id;
    let mode = req.context_mode.unwrap_or(ContextMode::Thin);
    let context = build_context(iii, &req.agent_id, &realm_id, &mode).await;

    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let run = PulseRun {
        id: run_id.clone(),
        agent_id: req.agent_id.clone(),
        realm_id: realm_id.clone(),
        status: PulseStatus::Running,
        source: "manual".into(),
        context_snapshot: Some(context.clone()),
        started_at: now.clone(),
        finished_at: None,
        error: None,
    };

    let run_val = serde_json::to_value(&run).map_err(|e| IIIError::Handler(e.to_string()))?;
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
        "scope": runs_scope(&realm_id),
        "key": &run_id,
        "value": run_val,
    }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let result = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
            "agentId": req.agent_id,
            "message": "You have been invoked via pulse. Review your current context and take appropriate action.",
            "context": context,
        }),
            action: None,
            timeout_ms: None,
        })
        .await;

    let (final_status, error) = match result {
        Ok(_) => (PulseStatus::Completed, None),
        Err(e) => (PulseStatus::Failed, Some(e.to_string())),
    };

    let finished_run = PulseRun {
        status: final_status,
        finished_at: Some(chrono::Utc::now().to_rfc3339()),
        error,
        ..run
    };

    let run_val = serde_json::to_value(&finished_run).map_err(|e| IIIError::Handler(e.to_string()))?;
    let _ = iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
        "scope": runs_scope(&realm_id),
        "key": &run_id,
        "value": run_val,
    }),
        action: None,
        timeout_ms: None,
    })
    .await;

    Ok(serde_json::to_value(&finished_run).unwrap())
}

async fn tick(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("missing agentId in tick".into()))?;
    let realm_id = input["realmId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("missing realmId in tick".into()))?;

    let config_val = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let config: PulseConfig =
        serde_json::from_value(config_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if !config.enabled {
        return Ok(json!({ "skipped": true, "reason": "disabled" }));
    }

    let budget_check = iii
        .trigger(TriggerRequest {
            function_id: "ledger::check".to_string(),
            payload: json!({
            "realmId": realm_id,
            "agentId": agent_id,
        }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!({ "allowed": true }));

    if budget_check["allowed"] == false {
        return Ok(json!({ "skipped": true, "reason": "budget_exceeded" }));
    }

    invoke_pulse(iii, InvokeRequest {
        agent_id: agent_id.to_string(),
        realm_id: realm_id.to_string(),
        context_mode: Some(config.context_mode),
    })
    .await
}

async fn get_pulse_status(iii: &III, realm_id: &str, agent_id: &str) -> Result<Value, IIIError> {
    let config = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    let runs = iii
        .trigger(TriggerRequest {
            function_id: "state::list".to_string(),
            payload: json!({ "scope": runs_scope(realm_id) }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    let recent_runs: Vec<Value> = runs
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter(|r| r["agentId"].as_str() == Some(agent_id))
                .rev()
                .take(10)
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "config": config,
        "recentRuns": recent_runs,
    }))
}

async fn toggle_pulse(iii: &III, realm_id: &str, agent_id: &str, enabled: bool) -> Result<Value, IIIError> {
    let config_val = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut config: PulseConfig =
        serde_json::from_value(config_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    config.enabled = enabled;

    let value = serde_json::to_value(&config).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
        "scope": config_scope(realm_id),
        "key": agent_id,
        "value": value,
    }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({ "enabled": enabled, "agentId": agent_id }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("pulse::register", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: RegisterPulseRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                register_pulse(&iii, req).await
            }
        })
        .description("Register scheduled pulse for an agent"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("pulse::invoke", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: InvokeRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                invoke_pulse(&iii, req).await
            }
        })
        .description("Manually invoke agent pulse"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("pulse::tick", move |input: Value| {
            let iii = iii_clone.clone();
            async move { tick(&iii, input).await }
        })
        .description("Internal: cron-triggered pulse execution"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("pulse::status", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let agent_id = input["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                get_pulse_status(&iii, realm_id, agent_id).await
            }
        })
        .description("Get pulse config and recent runs"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("pulse::toggle", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let agent_id = input["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let enabled = input["enabled"].as_bool().unwrap_or(true);
                toggle_pulse(&iii, realm_id, agent_id, enabled).await
            }
        })
        .description("Enable or disable agent pulse"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "pulse::register".to_string(),
        config: json!({ "method": "POST", "path": "/api/pulse/register" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "pulse::invoke".to_string(),
        config: json!({ "method": "POST", "path": "/api/pulse/invoke" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "pulse::status".to_string(),
        config: json!({ "method": "GET", "path": "/api/pulse/:realmId/:agentId" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "pulse::toggle".to_string(),
        config: json!({ "method": "PATCH", "path": "/api/pulse/:realmId/:agentId" }),
        metadata: None,
    })?;

    tracing::info!("pulse worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

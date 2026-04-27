use iii_sdk::{III, InitOptions, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{ContextMode, InvokeRequest, PulseConfig, PulseRun, PulseStatus, RegisterPulseRequest};

#[allow(dead_code)]
mod iii_compat {
    use iii_sdk::{
        III, RegisterFunction, RegisterTriggerInput, TriggerRequest, FunctionRef, Trigger,
        Value,
    };
    use iii_sdk::error::IIIError;
    use std::future::Future;

    pub trait IIIExt {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError>;

        fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> impl Future<Output = Result<Value, IIIError>> + Send;

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError>;
    }

    impl IIIExt for III {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(
                RegisterFunction::new_async(id.to_string(), f).description(desc.to_string()),
            )
        }

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(RegisterFunction::new_async(id.to_string(), f))
        }

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError> {
            self.register_trigger(RegisterTriggerInput {
                trigger_type: kind.to_string(),
                function_id: function_id.to_string(),
                config,
                metadata: None,
            })
        }

        async fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<Value, IIIError> {
            self.trigger(TriggerRequest {
                function_id: function_id.to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await
        }

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError> {
            let iii = self.clone();
            let fid = function_id.to_string();
            tokio::spawn(async move {
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: fid,
                        payload,
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            });
            Ok(())
        }
    }
}
use iii_compat::IIIExt as _;



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
                .trigger_v0("mission::list", json!({
                    "realmId": realm_id,
                    "assigneeId": agent_id,
                    "status": "active",
                }))
                .await
                .unwrap_or(json!({ "missions": [] }));

            let budget = iii
                .trigger_v0("ledger::check", json!({
                    "realmId": realm_id,
                    "agentId": agent_id,
                }))
                .await
                .unwrap_or(json!({ "allowed": true }));

            let hierarchy = iii
                .trigger_v0("hierarchy::chain", json!({
                    "realmId": realm_id,
                    "agentId": agent_id,
                }))
                .await
                .unwrap_or(json!({ "chain": [] }));

            let directives = iii
                .trigger_v0("directive::list", json!({
                    "realmId": realm_id,
                    "status": "active",
                }))
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

    iii.trigger_v0("state::set", json!({
        "scope": config_scope(&req.realm_id),
        "key": &req.agent_id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii
        .trigger_v0("engine::triggers::register", json!({
            "type": "cron",
            "function": "pulse::tick",
            "config": {
                "schedule": req.cron,
                "data": { "agentId": req.agent_id, "realmId": req.realm_id },
            },
        }))
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
    iii.trigger_v0("state::set", json!({
        "scope": runs_scope(&realm_id),
        "key": &run_id,
        "value": run_val,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let result = iii
        .trigger_v0("agent::chat", json!({
            "agentId": req.agent_id,
            "message": "You have been invoked via pulse. Review your current context and take appropriate action.",
            "context": context,
        }))
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
    let _ = iii.trigger_v0("state::set", json!({
        "scope": runs_scope(&realm_id),
        "key": &run_id,
        "value": run_val,
    }))
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
        .trigger_v0("state::get", json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let config: PulseConfig =
        serde_json::from_value(config_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if !config.enabled {
        return Ok(json!({ "skipped": true, "reason": "disabled" }));
    }

    let budget_check = iii
        .trigger_v0("ledger::check", json!({
            "realmId": realm_id,
            "agentId": agent_id,
        }))
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
        .trigger_v0("state::get", json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }))
        .await
        .ok();

    let runs = iii
        .trigger_v0("state::list", json!({ "scope": runs_scope(realm_id) }))
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
        .trigger_v0("state::get", json!({
            "scope": config_scope(realm_id),
            "key": agent_id,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut config: PulseConfig =
        serde_json::from_value(config_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    config.enabled = enabled;

    let value = serde_json::to_value(&config).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger_v0("state::set", json!({
        "scope": config_scope(realm_id),
        "key": agent_id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({ "enabled": enabled, "agentId": agent_id }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "pulse::register",
        "Register scheduled pulse for an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: RegisterPulseRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                register_pulse(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "pulse::invoke",
        "Manually invoke agent pulse",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: InvokeRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                invoke_pulse(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "pulse::tick",
        "Internal: cron-triggered pulse execution",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move { tick(&iii, input).await }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "pulse::status",
        "Get pulse config and recent runs",
        move |input: Value| {
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
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "pulse::toggle",
        "Enable or disable agent pulse",
        move |input: Value| {
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
        },
    );

    iii.register_trigger_v0("http", "pulse::register", json!({ "method": "POST", "path": "/api/pulse/register" }))?;
    iii.register_trigger_v0("http", "pulse::invoke", json!({ "method": "POST", "path": "/api/pulse/invoke" }))?;
    iii.register_trigger_v0("http", "pulse::status", json!({ "method": "GET", "path": "/api/pulse/:realmId/:agentId" }))?;
    iii.register_trigger_v0("http", "pulse::toggle", json!({ "method": "PATCH", "path": "/api/pulse/:realmId/:agentId" }))?;

    tracing::info!("pulse worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

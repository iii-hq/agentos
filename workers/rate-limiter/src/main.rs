use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const TOKENS_PER_MINUTE: f64 = 500.0;
const EMISSION_INTERVAL_MS: f64 = 60_000.0 / TOKENS_PER_MINUTE;
const BURST_LIMIT: f64 = TOKENS_PER_MINUTE;

const DEFAULT_AGENT_TOKENS_PER_MIN: f64 = 100.0;
const DEFAULT_AGENT_MAX_CONCURRENT: i64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GcraState {
    tat: f64,
    tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
struct RateCheckResult {
    allowed: bool,
    remaining: i64,
    #[serde(rename = "retryAfter")]
    retry_after: Option<i64>,
    limit: i64,
}

fn operation_cost(op: &str) -> f64 {
    match op {
        "health" => 1.0,
        "agents_list" => 2.0,
        "agents_get" => 2.0,
        "agents_create" => 10.0,
        "agents_delete" => 5.0,
        "message" => 30.0,
        "workflow_run" => 100.0,
        "workflow_list" => 2.0,
        "tool_call" => 20.0,
        "memory_store" => 10.0,
        "memory_recall" => 5.0,
        "memory_evict" => 50.0,
        "sandbox_execute" => 50.0,
        "sandbox_validate" => 20.0,
        "audit_verify" => 5.0,
        "scan_injection" => 3.0,
        _ => 5.0,
    }
}

fn cost_table() -> Value {
    json!({
        "health": 1,
        "agents_list": 2,
        "agents_get": 2,
        "agents_create": 10,
        "agents_delete": 5,
        "message": 30,
        "workflow_run": 100,
        "workflow_list": 2,
        "tool_call": 20,
        "memory_store": 10,
        "memory_recall": 5,
        "memory_evict": 50,
        "sandbox_execute": 50,
        "sandbox_validate": 20,
        "audit_verify": 5,
        "scan_injection": 3,
        "default": 5,
    })
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn fire_and_forget(iii: &III, function_id: &str, payload: Value) {
    let iii_clone = iii.clone();
    let id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii_clone
            .trigger(TriggerRequest {
                function_id: id,
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    let res = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": scope, "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok()?;
    if res.is_null() { None } else { Some(res) }
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

fn gcra_compute(
    state: Option<&GcraState>,
    cost: f64,
    now: f64,
    burst_limit: f64,
    emission_interval_ms: f64,
    tokens_per_minute: i64,
) -> (RateCheckResult, Option<GcraState>) {
    let increment = cost * emission_interval_ms;

    if state.is_none() {
        let new_tat = now + increment;
        let new_state = GcraState {
            tat: new_tat,
            tokens: (burst_limit - cost) as i64,
        };
        return (
            RateCheckResult {
                allowed: true,
                remaining: (burst_limit - cost) as i64,
                retry_after: None,
                limit: tokens_per_minute,
            },
            Some(new_state),
        );
    }

    let state = state.unwrap();
    let tat = state.tat.max(now);
    let new_tat = tat + increment;
    let allow_at = new_tat - burst_limit * emission_interval_ms;

    if allow_at > now {
        let retry_after_ms = (allow_at - now).ceil();
        let retry_after_secs = (retry_after_ms / 1000.0).ceil() as i64;
        return (
            RateCheckResult {
                allowed: false,
                remaining: 0,
                retry_after: Some(retry_after_secs),
                limit: tokens_per_minute,
            },
            None,
        );
    }

    let remaining = (((burst_limit * emission_interval_ms - (new_tat - now)) / emission_interval_ms)
        .floor() as i64)
        .max(0);

    let new_state = GcraState {
        tat: new_tat,
        tokens: remaining,
    };

    (
        RateCheckResult {
            allowed: true,
            remaining,
            retry_after: None,
            limit: tokens_per_minute,
        },
        Some(new_state),
    )
}

async fn gcra_check(iii: &III, key: &str, cost: f64, now: f64) -> Result<RateCheckResult, IIIError> {
    let state_val = state_get(iii, "rate_limiter", key).await;
    let state: Option<GcraState> = state_val.and_then(|v| serde_json::from_value(v).ok());

    let (result, new_state) = gcra_compute(
        state.as_ref(),
        cost,
        now,
        BURST_LIMIT,
        EMISSION_INTERVAL_MS,
        TOKENS_PER_MINUTE as i64,
    );

    if let Some(ns) = new_state {
        let val = serde_json::to_value(&ns).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(iii, "rate_limiter", key, val).await?;
    }

    Ok(result)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::check", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let ip = input["ip"].as_str().unwrap_or("").to_string();
                let operation = input["operation"].as_str().unwrap_or("default").to_string();
                let cost = operation_cost(&operation);
                let now = now_ms();
                let key = format!("ip:{ip}");

                let result = gcra_check(&iii, &key, cost, now).await?;

                let current_state = state_get(&iii, "rate_limiter", &key).await;
                fire_and_forget(
                    &iii,
                    "state::set",
                    json!({
                        "scope": "rate_limits",
                        "key": key,
                        "value": {
                            "ip": ip,
                            "lastCheck": now,
                            "lastOperation": operation,
                            "lastCost": cost,
                            "allowed": result.allowed,
                            "remaining": result.remaining,
                            "state": current_state,
                        }
                    }),
                );

                if !result.allowed {
                    fire_and_forget(
                        &iii,
                        "security::audit",
                        json!({
                            "type": "rate_limited",
                            "detail": {
                                "ip": ip,
                                "operation": operation,
                                "cost": cost,
                                "retryAfter": result.retry_after,
                            }
                        }),
                    );
                }

                Ok::<Value, IIIError>(serde_json::to_value(&result).unwrap())
            }
        })
        .description("GCRA rate limit check per IP and operation"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::get_status", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let ip = input["ip"].as_str().unwrap_or("").to_string();
                let key = format!("ip:{ip}");
                let state_val = state_get(&iii, "rate_limiter", &key).await;
                let state: Option<GcraState> =
                    state_val.and_then(|v| serde_json::from_value(v).ok());

                if let Some(s) = state {
                    let now = now_ms();
                    let remaining = (((BURST_LIMIT * EMISSION_INTERVAL_MS - (s.tat - now))
                        / EMISSION_INTERVAL_MS)
                        .floor() as i64)
                        .max(0);
                    Ok::<Value, IIIError>(json!({
                        "ip": ip,
                        "remaining": remaining,
                        "limit": TOKENS_PER_MINUTE as i64,
                        "tracked": true,
                        "tat": s.tat,
                    }))
                } else {
                    Ok::<Value, IIIError>(json!({
                        "ip": ip,
                        "remaining": TOKENS_PER_MINUTE as i64,
                        "limit": TOKENS_PER_MINUTE as i64,
                        "tracked": false,
                    }))
                }
            }
        })
        .description("Get rate limit status for an IP"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::reset", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let body = if input.get("body").is_some() {
                    input["body"].clone()
                } else {
                    input.clone()
                };
                let ip = body["ip"].as_str().unwrap_or("").to_string();
                let key = format!("ip:{ip}");
                state_set(&iii, "rate_limiter", &key, Value::Null).await?;
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: "state::delete".to_string(),
                        payload: json!({ "scope": "rate_limits", "key": key }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
                Ok::<Value, IIIError>(json!({ "reset": true, "ip": ip }))
            }
        })
        .description("Reset rate limit for an IP"),
    );

    iii.register_function(
        RegisterFunction::new_async("rate::get_costs", move |_input: Value| async move {
            Ok::<Value, IIIError>(json!({
                "tokensPerMinute": TOKENS_PER_MINUTE as i64,
                "costs": cost_table(),
            }))
        })
        .description("Get operation cost table"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::check_agent", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                let operation = input["operation"].as_str().unwrap_or("default").to_string();
                let limit = input["tokensPerMinute"]
                    .as_f64()
                    .filter(|v| *v > 0.0)
                    .unwrap_or(DEFAULT_AGENT_TOKENS_PER_MIN);
                let cost = operation_cost(&operation);
                let now = now_ms();
                let key = format!("agent:{agent_id}");
                let emission_ms = 60_000.0 / limit;

                let state_val = state_get(&iii, "rate_limiter", &key).await;
                let state: Option<GcraState> =
                    state_val.and_then(|v| serde_json::from_value(v).ok());

                let (result, new_state) =
                    gcra_compute(state.as_ref(), cost, now, limit, emission_ms, limit as i64);

                if let Some(ns) = new_state {
                    let val =
                        serde_json::to_value(&ns).map_err(|e| IIIError::Handler(e.to_string()))?;
                    state_set(&iii, "rate_limiter", &key, val).await?;
                }

                if !result.allowed {
                    fire_and_forget(
                        &iii,
                        "security::audit",
                        json!({
                            "type": "agent_rate_limited",
                            "detail": {
                                "agentId": agent_id,
                                "operation": operation,
                                "cost": cost,
                                "retryAfter": result.retry_after,
                            }
                        }),
                    );
                }

                Ok::<Value, IIIError>(serde_json::to_value(&result).unwrap())
            }
        })
        .description("Per-agent GCRA rate limit check"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::check_function", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let function_id = input["functionId"].as_str().unwrap_or("").to_string();
                let now = now_ms();
                let key = format!("fn:{function_id}");
                let result = gcra_check(&iii, &key, 1.0, now).await?;
                Ok::<Value, IIIError>(serde_json::to_value(&result).unwrap())
            }
        })
        .description("Per-function rate limit check"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::acquire_concurrent", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                let limit = input["maxConcurrent"]
                    .as_i64()
                    .filter(|v| *v > 0)
                    .unwrap_or(DEFAULT_AGENT_MAX_CONCURRENT);
                let current = state_get(&iii, "rate_concurrent", &agent_id)
                    .await
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if current >= limit {
                    return Ok::<Value, IIIError>(json!({
                        "acquired": false,
                        "current": current,
                        "limit": limit,
                    }));
                }
                state_set(
                    &iii,
                    "rate_concurrent",
                    &agent_id,
                    json!(current + 1),
                )
                .await?;
                Ok::<Value, IIIError>(json!({
                    "acquired": true,
                    "current": current + 1,
                    "limit": limit,
                }))
            }
        })
        .description("Acquire concurrent invocation slot for an agent"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("rate::release_concurrent", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                let current = state_get(&iii, "rate_concurrent", &agent_id)
                    .await
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let next = (current - 1).max(0);
                state_set(&iii, "rate_concurrent", &agent_id, json!(next)).await?;
                Ok::<Value, IIIError>(json!({ "released": true, "current": next }))
            }
        })
        .description("Release concurrent invocation slot for an agent"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "rate::check".to_string(),
        config: json!({ "api_path": "api/rate/check", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "rate::get_status".to_string(),
        config: json!({ "api_path": "api/rate/status", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "rate::reset".to_string(),
        config: json!({ "api_path": "api/rate/reset", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "rate::get_costs".to_string(),
        config: json!({ "api_path": "api/rate/costs", "http_method": "GET" }),
        metadata: None,
    })?;

    tracing::info!("rate-limiter worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(state: &mut Option<GcraState>, cost: f64, now: f64) -> RateCheckResult {
        let (result, new_state) = gcra_compute(
            state.as_ref(),
            cost,
            now,
            BURST_LIMIT,
            EMISSION_INTERVAL_MS,
            TOKENS_PER_MINUTE as i64,
        );
        if let Some(ns) = new_state {
            *state = Some(ns);
        }
        result
    }

    #[test]
    fn first_request_allowed() {
        let mut state = None;
        let r = check(&mut state, 1.0, 1000.0);
        assert!(r.allowed);
        assert_eq!(r.remaining, (BURST_LIMIT as i64) - 1);
        assert_eq!(r.retry_after, None);
        assert_eq!(r.limit, TOKENS_PER_MINUTE as i64);
        assert!(state.is_some());
    }

    #[test]
    fn subsequent_request_within_budget() {
        let mut state = None;
        check(&mut state, 5.0, 1000.0);
        let r = check(&mut state, 5.0, 1100.0);
        assert!(r.allowed);
    }

    #[test]
    fn remaining_decreases_with_each_request() {
        let mut state = None;
        let r1 = check(&mut state, 10.0, 1000.0);
        let r2 = check(&mut state, 10.0, 1001.0);
        assert!(r2.remaining < r1.remaining);
    }

    #[test]
    fn burst_exhaustion_blocks() {
        let mut state = None;
        for _ in 0..6 {
            check(&mut state, 100.0, 1000.0);
        }
        let r = check(&mut state, 100.0, 1000.0);
        assert!(!r.allowed);
        assert_eq!(r.remaining, 0);
        assert!(r.retry_after.is_some());
        assert!(r.retry_after.unwrap() > 0);
    }

    #[test]
    fn retry_after_in_seconds() {
        let mut state = None;
        for _ in 0..10 {
            check(&mut state, 100.0, 1000.0);
        }
        let r = check(&mut state, 100.0, 1000.0);
        if !r.allowed {
            if let Some(secs) = r.retry_after {
                assert!(secs >= 1);
            }
        }
    }

    #[test]
    fn token_recovery_after_time() {
        let mut state = None;
        for _ in 0..6 {
            check(&mut state, 100.0, 1000.0);
        }
        let blocked = check(&mut state, 100.0, 1000.0);
        if !blocked.allowed {
            let future = 1000.0 + 120_000.0;
            let r = check(&mut state, 1.0, future);
            assert!(r.allowed);
        }
    }

    #[test]
    fn token_recovery_proportional() {
        let mut state = None;
        check(&mut state, 200.0, 1000.0);
        let later = 1000.0 + 30_000.0;
        let r = check(&mut state, 1.0, later);
        assert!(r.allowed);
        assert!(r.remaining > 0);
    }

    #[test]
    fn operation_costs() {
        assert_eq!(operation_cost("health"), 1.0);
        assert_eq!(operation_cost("message"), 30.0);
        assert_eq!(operation_cost("workflow_run"), 100.0);
        assert_eq!(operation_cost("default"), 5.0);
        assert_eq!(operation_cost("tool_call"), 20.0);
        assert_eq!(operation_cost("sandbox_execute"), 50.0);
        assert_eq!(operation_cost("memory_store"), 10.0);
        assert_eq!(operation_cost("memory_recall"), 5.0);
        assert_eq!(operation_cost("agents_create"), 10.0);
        assert_eq!(operation_cost("scan_injection"), 3.0);
        assert_eq!(operation_cost("unknown_op"), 5.0);
    }

    #[test]
    fn high_cost_uses_more_burst() {
        let mut s1 = None;
        let mut s2 = None;
        let r1 = check(&mut s1, operation_cost("health"), 1000.0);
        let r2 = check(&mut s2, operation_cost("workflow_run"), 1000.0);
        assert!(r1.remaining > r2.remaining);
    }

    #[test]
    fn workflow_run_uses_100_tokens() {
        let mut state = None;
        let r = check(&mut state, operation_cost("workflow_run"), 1000.0);
        assert_eq!(r.remaining, (BURST_LIMIT as i64) - 100);
    }

    #[test]
    fn five_workflow_runs_exhaust_burst() {
        let mut state = None;
        for _ in 0..5 {
            check(&mut state, 100.0, 1000.0);
        }
        let r = check(&mut state, 100.0, 1000.0);
        assert!(!r.allowed);
    }

    #[test]
    fn zero_cost_allowed_with_full_burst() {
        let mut state = None;
        let r = check(&mut state, 0.0, 1000.0);
        assert!(r.allowed);
        assert_eq!(r.remaining, BURST_LIMIT as i64);
    }

    #[test]
    fn very_large_cost_first_request() {
        let mut state = None;
        let r = check(&mut state, 10000.0, 1000.0);
        assert!(r.allowed);
        assert_eq!(r.remaining, (BURST_LIMIT as i64) - 10000);
    }

    #[test]
    fn concurrent_requests_some_allowed_some_blocked() {
        let mut state = None;
        let mut allowed = 0;
        let mut blocked = 0;
        for _ in 0..20 {
            let r = check(&mut state, 30.0, 1000.0);
            if r.allowed {
                allowed += 1;
            } else {
                blocked += 1;
            }
        }
        assert!(allowed > 0);
        assert_eq!(allowed + blocked, 20);
    }

    #[test]
    fn emission_interval_calculated() {
        assert_eq!(EMISSION_INTERVAL_MS, 120.0);
    }

    #[test]
    fn burst_equals_tokens_per_minute() {
        assert_eq!(BURST_LIMIT, TOKENS_PER_MINUTE);
    }

    #[test]
    fn state_has_tat_and_tokens() {
        let mut state = None;
        check(&mut state, 1.0, 1000.0);
        let s = state.unwrap();
        assert!(s.tat > 0.0);
    }

    #[test]
    fn tat_advances_with_each_request() {
        let mut state = None;
        check(&mut state, 1.0, 1000.0);
        let tat1 = state.as_ref().unwrap().tat;
        check(&mut state, 1.0, 1001.0);
        let tat2 = state.as_ref().unwrap().tat;
        assert!(tat2 > tat1);
    }

    #[test]
    fn new_key_after_deletion_is_first_request() {
        let mut state = None;
        check(&mut state, 100.0, 1000.0);
        state = None;
        let r = check(&mut state, 1.0, 1000.0);
        assert_eq!(r.remaining, (BURST_LIMIT as i64) - 1);
    }
}

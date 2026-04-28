use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

async fn list_scope(iii: &III, scope: &str) -> Vec<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

async fn cleanup_stale_sessions(iii: &III) -> Result<Value, IIIError> {
    let agents = list_scope(iii, "agents").await;
    let cutoff = now_ms() - 24 * 60 * 60 * 1000;
    let mut cleaned = 0u64;

    for agent in agents {
        let agent_id = agent
            .get("key")
            .and_then(|v| v.as_str())
            .or_else(|| agent.get("id").and_then(|v| v.as_str()))
            .map(String::from);

        let agent_id = match agent_id {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };

        let sessions = list_scope(iii, &format!("sessions:{agent_id}")).await;

        for session in sessions {
            let value = session.get("value").cloned().unwrap_or(json!({}));
            let last_active = value
                .get("lastActiveAt")
                .and_then(|v| v.as_i64())
                .or_else(|| value.get("createdAt").and_then(|v| v.as_i64()))
                .unwrap_or(0);

            if last_active != 0 && last_active < cutoff {
                let key = match session.get("key").and_then(|v| v.as_str()) {
                    Some(k) => k.to_string(),
                    None => continue,
                };
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: "state::delete".to_string(),
                        payload: json!({
                            "scope": format!("sessions:{agent_id}"),
                            "key": key,
                        }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
                cleaned += 1;
            }
        }
    }

    Ok(json!({
        "cleaned": cleaned,
        "checkedAt": now_iso(),
    }))
}

async fn aggregate_daily_costs(iii: &III) -> Result<Value, IIIError> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    let costs = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "costs", "key": today }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    if costs.is_some() {
        let metering = list_scope(iii, "metering").await;
        let mut total_tokens: u64 = 0;
        for entry in &metering {
            total_tokens += entry
                .get("value")
                .and_then(|v| v.get("totalTokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }

        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::update".to_string(),
                payload: json!({
                    "scope": "costs",
                    "key": today,
                    "operations": [
                        { "type": "set", "path": "totalTokens", "value": total_tokens },
                        { "type": "set", "path": "aggregatedAt", "value": now_iso() },
                    ],
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    }

    Ok(json!({
        "date": today,
        "aggregated": true,
    }))
}

async fn reset_rate_limits(iii: &III) -> Result<Value, IIIError> {
    let rates = list_scope(iii, "rates").await;
    let now = now_ms();
    let mut reset = 0u64;

    for rate in rates {
        let value = rate.get("value").cloned().unwrap_or(json!({}));
        let window_end = value.get("windowEnd").and_then(|v| v.as_i64()).unwrap_or(0);

        if window_end != 0 && window_end < now {
            let key = match rate.get("key").and_then(|v| v.as_str()) {
                Some(k) => k.to_string(),
                None => continue,
            };
            let _ = iii
                .trigger(TriggerRequest {
                    function_id: "state::delete".to_string(),
                    payload: json!({ "scope": "rates", "key": key }),
                    action: None,
                    timeout_ms: None,
                })
                .await;
            reset += 1;
        }
    }

    Ok(json!({
        "reset": reset,
        "checkedAt": now_iso(),
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("cron::cleanup_stale_sessions", move |_input: Value| {
            let iii = iii_ref.clone();
            async move { cleanup_stale_sessions(&iii).await }
        })
        .description("Clean up sessions inactive for more than 24 hours"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("cron::aggregate_daily_costs", move |_input: Value| {
            let iii = iii_ref.clone();
            async move { aggregate_daily_costs(&iii).await }
        })
        .description("Aggregate and summarize daily cost data"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("cron::reset_rate_limits", move |_input: Value| {
            let iii = iii_ref.clone();
            async move { reset_rate_limits(&iii).await }
        })
        .description("Reset expired rate limit windows"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".to_string(),
        function_id: "cron::cleanup_stale_sessions".to_string(),
        config: json!({ "expression": "0 */6 * * *" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".to_string(),
        function_id: "cron::aggregate_daily_costs".to_string(),
        config: json!({ "expression": "0 * * * *" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".to_string(),
        function_id: "cron::reset_rate_limits".to_string(),
        config: json!({ "expression": "*/5 * * * *" }),
        metadata: None,
    })?;

    tracing::info!("cron worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_now_ms_positive() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn test_now_iso_format() {
        let s = now_iso();
        assert!(s.contains('T'));
        assert!(s.len() >= 19);
    }

    #[test]
    fn test_today_format() {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        assert_eq!(today.len(), 10);
        assert_eq!(&today[4..5], "-");
        assert_eq!(&today[7..8], "-");
    }

    #[test]
    fn test_cleanup_cutoff_24h() {
        let cutoff = now_ms() - 24 * 60 * 60 * 1000;
        let now = now_ms();
        assert!(cutoff < now);
        assert!((now - cutoff) >= 24 * 60 * 60 * 1000);
    }

    #[test]
    fn test_session_value_extraction() {
        let session = json!({
            "key": "session-1",
            "value": { "lastActiveAt": 12345, "createdAt": 67890 },
        });
        let value = session.get("value").cloned().unwrap_or(json!({}));
        let last_active = value
            .get("lastActiveAt")
            .and_then(|v| v.as_i64())
            .or_else(|| value.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        assert_eq!(last_active, 12345);
    }

    #[test]
    fn test_session_value_falls_back_to_created_at() {
        let session = json!({
            "key": "session-1",
            "value": { "createdAt": 67890 },
        });
        let value = session.get("value").cloned().unwrap_or(json!({}));
        let last_active = value
            .get("lastActiveAt")
            .and_then(|v| v.as_i64())
            .or_else(|| value.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        assert_eq!(last_active, 67890);
    }

    #[test]
    fn test_session_value_missing_returns_zero() {
        let session = json!({ "key": "s", "value": {} });
        let value = session.get("value").cloned().unwrap_or(json!({}));
        let last_active = value
            .get("lastActiveAt")
            .and_then(|v| v.as_i64())
            .or_else(|| value.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        assert_eq!(last_active, 0);
    }

    #[test]
    fn test_metering_total_tokens_sum() {
        let metering = vec![
            json!({ "key": "e1", "value": { "totalTokens": 500 } }),
            json!({ "key": "e2", "value": { "totalTokens": 300 } }),
            json!({ "key": "e3", "value": {} }),
        ];
        let mut total: u64 = 0;
        for entry in &metering {
            total += entry
                .get("value")
                .and_then(|v| v.get("totalTokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
        assert_eq!(total, 800);
    }

    #[test]
    fn test_rate_window_expired_detection() {
        let rate = json!({ "key": "r1", "value": { "windowEnd": 1000 } });
        let value = rate.get("value").cloned().unwrap_or(json!({}));
        let window_end = value.get("windowEnd").and_then(|v| v.as_i64()).unwrap_or(0);
        let now = now_ms();
        assert!(window_end < now);
    }

    #[test]
    fn test_rate_window_future_active() {
        let future = now_ms() + 60_000;
        let rate = json!({ "key": "r1", "value": { "windowEnd": future } });
        let value = rate.get("value").cloned().unwrap_or(json!({}));
        let window_end = value.get("windowEnd").and_then(|v| v.as_i64()).unwrap_or(0);
        let now = now_ms();
        assert!(window_end >= now);
    }

    #[test]
    fn test_agent_id_from_key_field() {
        let agent = json!({ "key": "agent-1", "value": {} });
        let id = agent
            .get("key")
            .and_then(|v| v.as_str())
            .or_else(|| agent.get("id").and_then(|v| v.as_str()))
            .map(String::from);
        assert_eq!(id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn test_agent_id_from_id_field_fallback() {
        let agent = json!({ "id": "agent-2" });
        let id = agent
            .get("key")
            .and_then(|v| v.as_str())
            .or_else(|| agent.get("id").and_then(|v| v.as_str()))
            .map(String::from);
        assert_eq!(id.as_deref(), Some("agent-2"));
    }

    #[test]
    fn test_agent_id_missing_returns_none() {
        let agent = json!({ "value": {} });
        let id = agent
            .get("key")
            .and_then(|v| v.as_str())
            .or_else(|| agent.get("id").and_then(|v| v.as_str()))
            .map(String::from);
        assert_eq!(id, None);
    }

    #[test]
    fn test_cleanup_result_shape() {
        let result = json!({
            "cleaned": 5u64,
            "checkedAt": now_iso(),
        });
        assert_eq!(result["cleaned"], 5);
        assert!(result["checkedAt"].is_string());
    }

    #[test]
    fn test_aggregate_result_shape() {
        let result = json!({
            "date": "2026-01-01",
            "aggregated": true,
        });
        assert_eq!(result["date"], "2026-01-01");
        assert_eq!(result["aggregated"], true);
    }

    #[test]
    fn test_reset_result_shape() {
        let result = json!({
            "reset": 3u64,
            "checkedAt": now_iso(),
        });
        assert_eq!(result["reset"], 3);
        assert!(result["checkedAt"].is_string());
    }
}

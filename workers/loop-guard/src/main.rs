use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, TriggerRequest, register_worker};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const HISTORY_SIZE: usize = 30;
const WARN_THRESHOLD: usize = 3;
const BLOCK_THRESHOLD: usize = 5;
const PER_AGENT_CIRCUIT_BREAKER: i64 = 100;
const POLL_MULTIPLIER: usize = 3;
const BACKOFF_SCHEDULE: &[i64] = &[5000, 10000, 30000, 60000];
const AGENT_TTL_MS: i64 = 3_600_000;

fn is_poll_tool(tool: &str) -> bool {
    matches!(tool, "fn::shell_exec" | "fn::web_fetch")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CallRecord {
    hash: String,
    #[serde(rename = "resultHash")]
    result_hash: String,
    #[serde(rename = "toolName")]
    tool_name: String,
    timestamp: i64,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn hash_call(tool_name: &str, params: &Value) -> String {
    // Mirror TS JSON.stringify({toolName, params}) — JS preserves insertion order;
    // the canonical form here uses `{"toolName":...,"params":...}`.
    let canonical = json!({ "toolName": tool_name, "params": params });
    let s = serde_json::to_string(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    hex[..16].to_string()
}

fn detect_ping_pong(history: &[CallRecord]) -> (bool, Option<String>) {
    if history.len() < 6 {
        return (false, None);
    }

    let len = history.len();
    let start = len.saturating_sub(10);
    let recent: Vec<&str> = history[start..].iter().map(|h| h.hash.as_str()).collect();

    for pattern_len in 2..=4usize {
        if recent.len() < pattern_len * 3 {
            continue;
        }

        let pattern_start = recent.len() - pattern_len;
        let pattern = &recent[pattern_start..];
        let mut repeats = 0usize;

        let mut i = recent.len() as isize - (pattern_len as isize) * 2;
        while i >= 0 {
            let chunk = &recent[i as usize..i as usize + pattern_len];
            if chunk.iter().zip(pattern.iter()).all(|(a, b)| a == b) {
                repeats += 1;
                i -= pattern_len as isize;
            } else {
                break;
            }
        }

        if repeats >= 2 {
            let tool_names: Vec<String> = history[history.len() - pattern_len..]
                .iter()
                .map(|h| {
                    h.tool_name
                        .rsplit("::")
                        .next()
                        .unwrap_or(&h.tool_name)
                        .to_string()
                })
                .collect();
            let pattern_str = format!("{} (×{})", tool_names.join(" → "), repeats + 1);
            return (true, Some(pattern_str));
        }
    }

    (false, None)
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

/// Atomic increment of an integer counter at scope/key. Returns the post-increment value.
async fn state_increment(
    iii: &III,
    scope: &str,
    key: &str,
    delta: i64,
) -> Result<i64, IIIError> {
    let res = iii
        .trigger(TriggerRequest {
            function_id: "state::update".to_string(),
            payload: json!({
                "scope": scope,
                "key": key,
                "operations": [
                    { "type": "increment", "path": "", "value": delta },
                ],
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(res
        .as_i64()
        .or_else(|| res.get("value").and_then(|v| v.as_i64()))
        .unwrap_or(0))
}

async fn get_agent_index(iii: &III) -> Vec<String> {
    state_get(iii, "loop_guard_history", "_index")
        .await
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

async fn set_agent_index(iii: &III, index: Vec<String>) -> Result<(), IIIError> {
    state_set(iii, "loop_guard_history", "_index", json!(index)).await
}

async fn get_warning_keys(iii: &III, agent_id: &str) -> Vec<String> {
    state_get(iii, "loop_guard_warnings", &format!("_keys:{agent_id}"))
        .await
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

async fn set_warning_keys(iii: &III, agent_id: &str, keys: Vec<String>) -> Result<(), IIIError> {
    state_set(
        iii,
        "loop_guard_warnings",
        &format!("_keys:{agent_id}"),
        json!(keys),
    )
    .await
}

async fn clear_warning_buckets(iii: &III, agent_id: &str) -> Result<(), IIIError> {
    let keys = get_warning_keys(iii, agent_id).await;
    for key in keys {
        state_set(iii, "loop_guard_warnings", &key, Value::Null).await?;
    }
    set_warning_keys(iii, agent_id, vec![]).await?;
    Ok(())
}

async fn evict_stale_agents(iii: &III) -> Result<(), IIIError> {
    let now = now_ms();
    let index = get_agent_index(iii).await;
    let mut remaining = Vec::new();
    for agent_id in index {
        let history_val = state_get(iii, "loop_guard_history", &agent_id).await;
        let history: Vec<CallRecord> = history_val
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        if history.is_empty() {
            continue;
        }
        let last = history.last().unwrap();
        if now - last.timestamp > AGENT_TTL_MS {
            state_set(iii, "loop_guard_history", &agent_id, Value::Null).await?;
            state_set(iii, "loop_guard_counts", &agent_id, Value::Null).await?;
            clear_warning_buckets(iii, &agent_id).await?;
        } else {
            remaining.push(agent_id);
        }
    }
    set_agent_index(iii, remaining).await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    {
        let iii_clone = iii.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(600));
            ticker.tick().await; // skip first immediate tick
            loop {
                ticker.tick().await;
                if let Err(e) = evict_stale_agents(&iii_clone).await {
                    tracing::error!("evictStaleAgents failed: {e}");
                }
            }
        });
    }

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("guard::check", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                let tool_name = input["toolName"].as_str().unwrap_or("").to_string();
                let params = input.get("params").cloned().unwrap_or(json!({}));
                let result_hash = input["resultHash"].as_str().map(String::from);

                // Atomic increment so overlapping guard::check calls each see a unique
                // post-increment value rather than racing on a read-modify-write.
                let agent_calls = state_increment(&iii, "loop_guard_counts", &agent_id, 1).await?;

                if agent_calls > PER_AGENT_CIRCUIT_BREAKER {
                    return Ok::<Value, IIIError>(json!({
                        "decision": "circuit_break",
                        "reason": format!("Per-agent circuit breaker: {agent_calls} calls for {agent_id}"),
                    }));
                }

                let call_hash = hash_call(&tool_name, &params);
                let mut history: Vec<CallRecord> =
                    state_get(&iii, "loop_guard_history", &agent_id)
                        .await
                        .and_then(|v| serde_json::from_value(v).ok())
                        .unwrap_or_default();

                let record = CallRecord {
                    hash: call_hash.clone(),
                    result_hash: result_hash.clone().unwrap_or_default(),
                    tool_name: tool_name.clone(),
                    timestamp: now_ms(),
                };
                history.push(record);
                if history.len() > HISTORY_SIZE {
                    history.remove(0);
                }
                state_set(
                    &iii,
                    "loop_guard_history",
                    &agent_id,
                    serde_json::to_value(&history).unwrap(),
                )
                .await?;

                let mut index = get_agent_index(&iii).await;
                if !index.contains(&agent_id) {
                    index.push(agent_id.clone());
                    set_agent_index(&iii, index).await?;
                }

                let is_poll = is_poll_tool(&tool_name);
                let warn_at = if is_poll {
                    WARN_THRESHOLD * POLL_MULTIPLIER
                } else {
                    WARN_THRESHOLD
                };
                let block_at = if is_poll {
                    BLOCK_THRESHOLD * POLL_MULTIPLIER
                } else {
                    BLOCK_THRESHOLD
                };

                let identical_count = history.iter().filter(|h| h.hash == call_hash).count();
                let same_result_count = if let Some(rh) = &result_hash {
                    history
                        .iter()
                        .filter(|h| h.hash == call_hash && h.result_hash == *rh)
                        .count()
                } else {
                    0
                };

                let (pp_detected, pp_pattern) = detect_ping_pong(&history);

                if same_result_count >= block_at || pp_detected {
                    let reason = if pp_detected {
                        format!(
                            "Ping-pong pattern: {}",
                            pp_pattern.unwrap_or_default()
                        )
                    } else {
                        format!("Identical call+result repeated {same_result_count} times")
                    };
                    return Ok::<Value, IIIError>(json!({
                        "decision": "block",
                        "reason": reason,
                        "suggestion": "Break the loop — try a different approach",
                    }));
                }

                if identical_count >= block_at {
                    return Ok::<Value, IIIError>(json!({
                        "decision": "block",
                        "reason": format!("Tool {tool_name} called {identical_count} times with same params"),
                        "suggestion": "The tool keeps returning the same result. Change your approach.",
                    }));
                }

                if identical_count >= warn_at {
                    let bucket_key = format!("{agent_id}:{call_hash}");
                    // Atomic increment to avoid lost warnings under concurrent checks.
                    let warnings =
                        state_increment(&iii, "loop_guard_warnings", &bucket_key, 1).await?;

                    let mut warn_keys = get_warning_keys(&iii, &agent_id).await;
                    if !warn_keys.contains(&bucket_key) {
                        warn_keys.push(bucket_key.clone());
                        set_warning_keys(&iii, &agent_id, warn_keys).await?;
                    }

                    if warnings >= 3 {
                        return Ok::<Value, IIIError>(json!({
                            "decision": "block",
                            "reason": format!(
                                "Repeated warnings escalated to block after {warnings} warnings"
                            ),
                        }));
                    }

                    let backoff_idx = ((warnings - 1) as usize).min(BACKOFF_SCHEDULE.len() - 1);
                    return Ok::<Value, IIIError>(json!({
                        "decision": "warn",
                        "reason": format!(
                            "Tool {tool_name} called {identical_count} times with same params"
                        ),
                        "backoffMs": BACKOFF_SCHEDULE[backoff_idx],
                    }));
                }

                Ok::<Value, IIIError>(json!({ "decision": "allow" }))
            }
        })
        .description("Loop guard: check for repeated tool calls"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("guard::reset", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                state_set(&iii, "loop_guard_history", &agent_id, Value::Null).await?;
                clear_warning_buckets(&iii, &agent_id).await?;
                state_set(&iii, "loop_guard_counts", &agent_id, Value::Null).await?;
                let index = get_agent_index(&iii).await;
                let filtered: Vec<String> =
                    index.into_iter().filter(|id| id != &agent_id).collect();
                set_agent_index(&iii, filtered).await?;
                Ok::<Value, IIIError>(json!({ "reset": true }))
            }
        })
        .description("Reset loop guard state for an agent"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("guard::stats", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
                let history: Vec<CallRecord> =
                    state_get(&iii, "loop_guard_history", &agent_id)
                        .await
                        .and_then(|v| serde_json::from_value(v).ok())
                        .unwrap_or_default();

                let mut tool_counts: BTreeMap<String, i64> = BTreeMap::new();
                for h in &history {
                    *tool_counts.entry(h.tool_name.clone()).or_insert(0) += 1;
                }

                let warn_keys = get_warning_keys(&iii, &agent_id).await;
                let mut warn_buckets = Map::new();
                for key in warn_keys {
                    let val = state_get(&iii, "loop_guard_warnings", &key)
                        .await
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    if val > 0 {
                        warn_buckets.insert(key, json!(val));
                    }
                }

                let agent_calls = state_get(&iii, "loop_guard_counts", &agent_id)
                    .await
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);

                let counts_json = serde_json::to_value(&tool_counts).unwrap();
                Ok::<Value, IIIError>(json!({
                    "historySize": history.len(),
                    "agentCalls": agent_calls,
                    "toolCounts": counts_json,
                    "warningBuckets": Value::Object(warn_buckets),
                }))
            }
        })
        .description("Get loop guard statistics"),
    );

    tracing::info!("loop-guard worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(hash: &str, tool: &str, ts: i64) -> CallRecord {
        CallRecord {
            hash: hash.to_string(),
            result_hash: String::new(),
            tool_name: tool.to_string(),
            timestamp: ts,
        }
    }

    #[test]
    fn hash_call_returns_16_char_hex() {
        let h = hash_call("fn::test", &json!({ "a": 1 }));
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_call_is_deterministic() {
        let h1 = hash_call("fn::a", &json!({ "x": 1 }));
        let h2 = hash_call("fn::a", &json!({ "x": 1 }));
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_call_differs_by_tool() {
        let h1 = hash_call("fn::a", &json!({ "x": 1 }));
        let h2 = hash_call("fn::b", &json!({ "x": 1 }));
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_call_differs_by_params() {
        let h1 = hash_call("fn::a", &json!({ "x": 1 }));
        let h2 = hash_call("fn::a", &json!({ "x": 2 }));
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_call_handles_empty_params() {
        let h = hash_call("fn::a", &json!({}));
        assert_eq!(h.len(), 16);
    }

    #[test]
    fn hash_call_handles_nested_params() {
        let h = hash_call("fn::a", &json!({ "nested": { "deep": true } }));
        assert_eq!(h.len(), 16);
    }

    #[test]
    fn ping_pong_under_six_no_detect() {
        let h: Vec<CallRecord> = vec![
            rec("a", "fn::a", 1),
            rec("b", "fn::b", 2),
            rec("a", "fn::a", 3),
            rec("b", "fn::b", 4),
        ];
        assert!(!detect_ping_pong(&h).0);
    }

    #[test]
    fn ping_pong_a_b_a_b_pattern_detected() {
        let mut h = Vec::new();
        for i in 0..8 {
            h.push(rec(
                if i % 2 == 0 { "aaa" } else { "bbb" },
                if i % 2 == 0 { "fn::a" } else { "fn::b" },
                i,
            ));
        }
        assert!(detect_ping_pong(&h).0);
    }

    #[test]
    fn ping_pong_three_element_pattern_detected() {
        let hashes = ["a1", "b2", "c3"];
        let mut h = Vec::new();
        for i in 0..9 {
            let hh = hashes[i % 3];
            h.push(rec(hh, &format!("fn::{hh}"), i as i64));
        }
        assert!(detect_ping_pong(&h).0);
    }

    #[test]
    fn ping_pong_no_false_positive_on_varied() {
        let mut h = Vec::new();
        for i in 0..10 {
            let hh = format!("unique-{i}");
            h.push(rec(&hh, &format!("fn::{hh}"), i));
        }
        assert!(!detect_ping_pong(&h).0);
    }

    #[test]
    fn ping_pong_pattern_string_includes_x() {
        let mut h = Vec::new();
        for i in 0..8 {
            h.push(rec(
                if i % 2 == 0 { "pp1" } else { "pp2" },
                if i % 2 == 0 { "fn::read" } else { "fn::write" },
                i,
            ));
        }
        let (det, pat) = detect_ping_pong(&h);
        assert!(det);
        assert!(pat.unwrap().contains('×'));
    }

    #[test]
    fn poll_tools_recognised() {
        assert!(is_poll_tool("fn::shell_exec"));
        assert!(is_poll_tool("fn::web_fetch"));
        assert!(!is_poll_tool("fn::other"));
    }

    #[test]
    fn poll_multiplier_is_three() {
        assert_eq!(POLL_MULTIPLIER, 3);
    }

    #[test]
    fn poll_warn_threshold_is_nine() {
        assert_eq!(WARN_THRESHOLD * POLL_MULTIPLIER, 9);
    }

    #[test]
    fn poll_block_threshold_is_fifteen() {
        assert_eq!(BLOCK_THRESHOLD * POLL_MULTIPLIER, 15);
    }

    #[test]
    fn circuit_breaker_limit_is_100() {
        assert_eq!(PER_AGENT_CIRCUIT_BREAKER, 100);
    }

    #[test]
    fn history_size_is_30() {
        assert_eq!(HISTORY_SIZE, 30);
    }

    #[test]
    fn agent_ttl_is_one_hour() {
        assert_eq!(AGENT_TTL_MS, 3_600_000);
    }

    #[test]
    fn backoff_schedule_has_four_entries() {
        assert_eq!(BACKOFF_SCHEDULE, &[5000, 10000, 30000, 60000]);
    }
}

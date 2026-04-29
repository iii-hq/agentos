use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

mod types;

use types::ReplayEntry;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn record(iii: &III, input: Value) -> Result<Value, IIIError> {
    let session_id = input["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);
    let agent_id = input["agentId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);
    let action = input["action"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);

    let (Some(session_id), Some(agent_id), Some(action)) = (session_id, agent_id, action) else {
        return Ok(json!({ "error": "sessionId, agentId, and action required" }));
    };

    let data = input.get("data").cloned().unwrap_or_else(|| json!({}));
    let duration_ms = input["durationMs"].as_i64().unwrap_or(0);
    let iteration = input["iteration"].as_i64().unwrap_or(0);

    let counter_key = format!("{session_id}:counter");
    let counter_resp = iii
        .trigger(TriggerRequest {
            function_id: "state::update".into(),
            payload: json!({
                "scope": "replay",
                "key": counter_key,
                "operations": [
                    { "type": "increment", "path": "value", "value": 1 }
                ],
                "upsert": { "value": 1 }
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    let sequence = counter_resp
        .as_ref()
        .and_then(|v| v["value"].as_i64())
        .unwrap_or_else(now_ms);

    let entry = ReplayEntry {
        session_id: session_id.clone(),
        agent_id,
        action,
        data,
        duration_ms,
        timestamp: now_ms(),
        iteration,
        sequence,
    };

    let entry_value = serde_json::to_value(&entry).map_err(|e| IIIError::Handler(e.to_string()))?;
    let key = format!("{session_id}:{:0>8}", sequence);

    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({
            "scope": "replay",
            "key": key,
            "value": entry_value,
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({ "recorded": true, "sequence": sequence }))
}

fn parse_entries(list: &Value) -> Vec<ReplayEntry> {
    let Some(arr) = list.as_array() else { return Vec::new(); };
    let mut out = Vec::new();
    for item in arr {
        let key = item["key"].as_str().unwrap_or("");
        if key.ends_with(":counter") {
            continue;
        }
        let value = &item["value"];
        if !value.is_object() {
            continue;
        }
        if value["sessionId"].as_str().is_none() || value["action"].as_str().is_none() {
            continue;
        }
        if let Ok(entry) = serde_json::from_value::<ReplayEntry>(value.clone()) {
            out.push(entry);
        }
    }
    out
}

async fn list_replays(iii: &III) -> Value {
    iii.trigger(TriggerRequest {
        function_id: "state::list".into(),
        payload: json!({ "scope": "replay" }),
        action: None,
        timeout_ms: None,
    })
    .await
    .unwrap_or_else(|_| json!([]))
}

async fn get_session(iii: &III, input: Value) -> Result<Value, IIIError> {
    let session_id = input["sessionId"].as_str().unwrap_or("");
    if session_id.is_empty() {
        return Ok(json!({ "error": "sessionId required" }));
    }

    let raw = list_replays(iii).await;
    let mut entries: Vec<ReplayEntry> = parse_entries(&raw)
        .into_iter()
        .filter(|e| e.session_id == session_id)
        .collect();
    entries.sort_by_key(|e| e.sequence);
    serde_json::to_value(entries).map_err(|e| IIIError::Handler(e.to_string()))
}

async fn search(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_filter = input["agentId"].as_str().map(String::from);
    let tool_filter = input["toolUsed"].as_str().map(String::from);
    let raw_limit = input["limit"].as_i64().unwrap_or(50);
    let limit = raw_limit.clamp(1, 200) as usize;

    let from = input["timeRange"]["from"].as_i64();
    let to = input["timeRange"]["to"].as_i64();
    let has_time_range = from.is_some() && to.is_some();

    let raw = list_replays(iii).await;
    let entries = parse_entries(&raw);

    let mut session_map: BTreeMap<String, Vec<ReplayEntry>> = BTreeMap::new();
    for entry in entries {
        if let Some(ref a) = agent_filter
            && entry.agent_id != *a
        {
            continue;
        }
        if has_time_range {
            let f = from.unwrap();
            let t = to.unwrap();
            if entry.timestamp < f || entry.timestamp > t {
                continue;
            }
        }
        if let Some(ref tool) = tool_filter {
            let matches = entry.action == "tool_call"
                && entry.data["toolId"].as_str() == Some(tool.as_str());
            if !matches {
                continue;
            }
        }
        session_map
            .entry(entry.session_id.clone())
            .or_default()
            .push(entry);
    }

    let mut summaries: Vec<Value> = session_map
        .into_iter()
        .map(|(sid, actions)| {
            let agent = actions.first().map(|a| a.agent_id.clone()).unwrap_or_default();
            let action_count = actions.len();
            let start = actions.iter().map(|a| a.timestamp).min().unwrap_or(0);
            let end = actions.iter().map(|a| a.timestamp).max().unwrap_or(0);
            json!({
                "sessionId": sid,
                "agentId": agent,
                "actionCount": action_count,
                "startTime": start,
                "endTime": end,
            })
        })
        .collect();

    summaries.sort_by(|a, b| {
        b["startTime"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["startTime"].as_i64().unwrap_or(0))
    });
    summaries.truncate(limit);

    Ok(json!(summaries))
}

async fn summary(iii: &III, input: Value) -> Result<Value, IIIError> {
    let session_id = input["sessionId"].as_str().unwrap_or("");
    if session_id.is_empty() {
        return Ok(json!({ "error": "sessionId required" }));
    }

    let entries_value = iii
        .trigger(TriggerRequest {
            function_id: "replay::get".into(),
            payload: json!({ "sessionId": session_id }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let entries: Vec<ReplayEntry> = serde_json::from_value(entries_value).unwrap_or_default();
    if entries.is_empty() {
        return Ok(json!({ "error": "Session not found" }));
    }

    let mut total_duration: i64 = 0;
    let mut tokens_used: i64 = 0;
    let mut cost: f64 = 0.0;
    let mut tool_set: HashSet<String> = HashSet::new();
    let mut max_iter: i64 = 0;
    let mut tool_calls: i64 = 0;

    for entry in &entries {
        total_duration += entry.duration_ms;
        if entry.iteration > max_iter {
            max_iter = entry.iteration;
        }
        if entry.action == "tool_call" {
            tool_calls += 1;
            if let Some(tool_id) = entry.data["toolId"].as_str() {
                tool_set.insert(tool_id.to_string());
            }
        }
        if entry.action == "llm_call" {
            if let Some(total) = entry.data["usage"]["total"].as_i64() {
                tokens_used += total;
            }
            if let Some(c) = entry.data["usage"]["cost"].as_f64() {
                cost += c;
            }
        }
    }

    let agent_id = entries[0].agent_id.clone();
    let tools: Vec<String> = tool_set.into_iter().collect();

    Ok(json!({
        "sessionId": session_id,
        "agentId": agent_id,
        "totalDuration": total_duration,
        "iterations": max_iter,
        "toolCalls": tool_calls,
        "tokensUsed": tokens_used,
        "cost": cost,
        "tools": tools,
        "actionCount": entries.len(),
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("replay::record", move |input: Value| {
            let iii = iii_ref.clone();
            async move { record(&iii, input).await }
        })
        .description("Record an action in the session replay log"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("replay::get", move |input: Value| {
            let iii = iii_ref.clone();
            async move { get_session(&iii, input).await }
        })
        .description("Get full session replay"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("replay::search", move |input: Value| {
            let iii = iii_ref.clone();
            async move { search(&iii, input).await }
        })
        .description("Search replay sessions by criteria"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("replay::summary", move |input: Value| {
            let iii = iii_ref.clone();
            async move { summary(&iii, input).await }
        })
        .description("Get session replay summary with stats"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "replay::get".into(),
        config: json!({ "http_method": "GET", "api_path": "api/replay/:sessionId" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "replay::search".into(),
        config: json!({ "http_method": "GET", "api_path": "api/replay/search" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "replay::summary".into(),
        config: json!({ "http_method": "GET", "api_path": "api/replay/:sessionId/summary" }),
        metadata: None,
    })?;

    tracing::info!("session-replay worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_entries_filters_counter() {
        let raw = json!([
            { "key": "s1:00000001", "value": {
                "sessionId": "s1", "agentId": "a1", "action": "tool_call",
                "data": {}, "durationMs": 50, "timestamp": 1000, "iteration": 1, "sequence": 1
            }},
            { "key": "s1:counter", "value": { "value": 1 } },
            { "key": "s1:00000002", "value": {
                "sessionId": "s1", "agentId": "a1", "action": "llm_call",
                "data": {}, "durationMs": 0, "timestamp": 1100, "iteration": 1, "sequence": 2
            }}
        ]);
        let entries = parse_entries(&raw);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.session_id == "s1"));
    }

    #[test]
    fn parse_entries_skips_incomplete() {
        let raw = json!([
            { "key": "k1", "value": { "sessionId": "s1" } },
            { "key": "k2", "value": "string-not-object" },
            { "key": "k3", "value": {
                "sessionId": "s2", "agentId": "a", "action": "x",
                "data": {}, "durationMs": 0, "timestamp": 0, "iteration": 0, "sequence": 0
            }}
        ]);
        let entries = parse_entries(&raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id, "s2");
    }
}

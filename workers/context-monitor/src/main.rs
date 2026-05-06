use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerAction, TriggerRequest,
    register_worker,
};
use serde_json::{Value, json};
use std::collections::HashSet;

mod types;

use types::{
    Message, estimate_messages_tokens, estimate_tokens, score_relevance_decay, score_repetition,
    score_token_utilization, score_tool_density, truncate_chars,
};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_messages(value: &Value) -> Vec<Message> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| serde_json::from_value::<Message>(m.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn payload_body(input: &Value) -> Value {
    if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    }
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

async fn health(input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let messages = parse_messages(&body["messages"]);
    let max_tokens = body["maxTokens"].as_i64().unwrap_or(200_000);
    let used = estimate_messages_tokens(&messages);

    let token_utilization = score_token_utilization(used, max_tokens);
    let relevance = score_relevance_decay(&messages, now_ms());
    let repetition = score_repetition(&messages);
    let tool_density = score_tool_density(&messages);

    let overall = (token_utilization + relevance + repetition + tool_density).round() as i64;
    Ok(json!({
        "overall": overall,
        "tokenUtilization": token_utilization.round() as i64,
        "relevanceDecay": relevance.round() as i64,
        "repetitionPenalty": repetition.round() as i64,
        "toolDensity": tool_density.round() as i64,
    }))
}

fn sanitize_tool_pairs(messages: Vec<Message>) -> Vec<Message> {
    let mut call_ids_per_msg: Vec<Vec<String>> = Vec::with_capacity(messages.len());
    let mut all_call_ids: HashSet<String> = HashSet::new();
    let mut result_ids: HashSet<String> = HashSet::new();

    for m in &messages {
        let mut ids_for_msg: Vec<String> = Vec::new();
        if m.role == "assistant"
            && let Some(arr) = m.tool_calls.as_ref().and_then(|tc| tc.as_array())
        {
            for tc in arr {
                if let Some(cid) = tc["callId"].as_str().or_else(|| tc["id"].as_str()) {
                    ids_for_msg.push(cid.to_string());
                    all_call_ids.insert(cid.to_string());
                }
            }
        }
        call_ids_per_msg.push(ids_for_msg);
        if m.role == "tool"
            && let Some(tcid) = &m.tool_call_id
        {
            result_ids.insert(tcid.clone());
        }
    }

    // Build the sanitized list in original order, inserting synthetic stubs
    // for any missing tool result immediately after the assistant message
    // that originated the call. Appending stubs at the end (the previous
    // behavior) reorders them past later user/assistant turns and breaks the
    // assistant-tool ordering that chat backends require.
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    for (idx, m) in messages.iter().enumerate() {
        if m.role == "tool"
            && let Some(tcid) = &m.tool_call_id
            && !all_call_ids.contains(tcid)
        {
            // Drop tool messages whose originating call we never saw.
            continue;
        }
        out.push(m.clone());
        // After an assistant message, append stubs for any of its calls that
        // never received a result.
        if m.role == "assistant" {
            for cid in &call_ids_per_msg[idx] {
                if !result_ids.contains(cid) {
                    out.push(Message {
                        role: "tool".into(),
                        content: "[Result cleared — see context summary]".into(),
                        tool_results: None,
                        timestamp: None,
                        tool_calls: None,
                        tool_call_id: Some(cid.clone()),
                        importance: None,
                        extra: Default::default(),
                    });
                }
            }
        }
    }
    out
}

async fn compress(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    // Sanitize tool-pair consistency BEFORE the under-budget early return so
    // callers always get back a self-consistent message list, even when the
    // input was already within budget.
    let mut messages = sanitize_tool_pairs(parse_messages(&body["messages"]));
    let target_tokens = body["targetTokens"]
        .as_i64()
        .ok_or_else(|| IIIError::Handler("targetTokens required".into()))?;
    let agent_id = body["agentId"].as_str().unwrap_or("").to_string();
    let original_tokens = estimate_messages_tokens(&messages);

    if original_tokens <= target_tokens {
        fire_void(
            iii,
            "hook::fire",
            json!({
                "type": "AfterCompact",
                "payload": {
                    "agentId": agent_id,
                    "removedCount": 0,
                    "savedTokens": 0,
                    "finalMessageCount": messages.len(),
                }
            }),
        );
        return Ok(json!({
            "compressed": messages,
            "removedCount": 0,
            "savedTokens": 0,
        }));
    }

    fire_void(
        iii,
        "hook::fire",
        json!({
            "type": "BeforeCompact",
            "payload": {
                "agentId": agent_id,
                "messageCount": messages.len(),
                "originalTokens": original_tokens,
                "targetTokens": target_tokens,
            }
        }),
    );

    let mut removed_count: i64 = 0;
    let recent_cutoff = (messages.len() as f64 * 0.6).floor() as usize;
    for i in 0..recent_cutoff.min(messages.len()) {
        let is_tool = messages[i].role == "tool" || messages[i].tool_results.is_some();
        if is_tool && messages[i].content.chars().count() > 200 {
            let summary = format!(
                "[Tool result summarized: {}...]",
                truncate_chars(&messages[i].content, 100)
            );
            messages[i].content = summary;
            messages[i].tool_results = None;
            removed_count += 1;
        }
    }

    // sanitize_tool_pairs was already applied at the top of compress(); no
    // need to repeat it after the in-place tool summarization above.

    let mut merged: Vec<Message> = Vec::with_capacity(messages.len());
    for m in messages.into_iter() {
        if let Some(prev) = merged.last_mut()
            && prev.role == "system" && m.role == "system" {
                prev.content = format!("{}\n{}", prev.content, m.content);
                removed_count += 1;
                continue;
            }
        merged.push(m);
    }
    let mut messages = merged;

    if estimate_messages_tokens(&messages) <= target_tokens {
        let saved = original_tokens - estimate_messages_tokens(&messages);
        fire_void(
            iii,
            "hook::fire",
            json!({
                "type": "AfterCompact",
                "payload": {
                    "agentId": agent_id,
                    "removedCount": removed_count,
                    "savedTokens": saved,
                    "finalMessageCount": messages.len(),
                }
            }),
        );
        return Ok(json!({
            "compressed": messages,
            "removedCount": removed_count,
            "savedTokens": saved,
        }));
    }

    let recent_budget = (target_tokens as f64 * 0.4).floor() as i64;
    let mut recent_tokens: i64 = 0;
    let mut split_idx = messages.len();
    for i in (0..messages.len()).rev() {
        let msg_tokens = estimate_tokens(&messages[i].content);
        if recent_tokens + msg_tokens > recent_budget {
            break;
        }
        recent_tokens += msg_tokens;
        split_idx = i;
    }
    if split_idx == messages.len() && !messages.is_empty() {
        split_idx = messages.len() - 1;
    }

    let old_messages: Vec<Message> = messages[..split_idx].to_vec();
    let recent_messages: Vec<Message> = messages[split_idx..].to_vec();

    if old_messages.is_empty() {
        let saved = original_tokens - estimate_messages_tokens(&messages);
        fire_void(
            iii,
            "hook::fire",
            json!({
                "type": "AfterCompact",
                "payload": {
                    "agentId": agent_id,
                    "removedCount": removed_count,
                    "savedTokens": saved,
                    "finalMessageCount": messages.len(),
                }
            }),
        );
        return Ok(json!({
            "compressed": messages,
            "removedCount": removed_count,
            "savedTokens": saved,
        }));
    }

    let summary_text = old_messages
        .iter()
        .filter(|m| !m.content.is_empty())
        .map(|m| format!("[{}]: {}", m.role, truncate_chars(&m.content, 150)))
        .collect::<Vec<_>>()
        .join("\n");

    const SUMMARY_TEMPLATE: &str = "[Structured Summary]\nGoal: <primary objective>\nProgress: <completed steps>\nDecisions: <key decisions made>\nFiles: <important files/paths mentioned>\nNext Steps: <pending work>\nCritical Context: <must-preserve details>";

    let existing_summary_idx = messages.iter().position(|m| {
        m.role == "system" && m.content.contains("[Structured Summary]")
    });
    let existing_summary_content = existing_summary_idx
        .map(|i| messages[i].content.clone())
        .unwrap_or_default();
    let iterative_block = if !existing_summary_content.is_empty() {
        format!("\nPREVIOUS SUMMARY TO UPDATE:\n{existing_summary_content}\n")
    } else {
        String::new()
    };

    let user_msg = format!(
        "{iterative_block}TEMPLATE:\n{SUMMARY_TEMPLATE}\n\nCONVERSATION:\n{}",
        truncate_chars(&summary_text, 8000)
    );

    let llm_result = iii
        .trigger(TriggerRequest {
            function_id: "llm::complete".into(),
            payload: json!({
                "model": {
                    "provider": "anthropic",
                    "model": "claude-haiku-4-5",
                    "maxTokens": 1024
                },
                "systemPrompt": "Summarize this conversation into the structured template. Preserve key facts and decisions.",
                "messages": [
                    { "role": "user", "content": user_msg }
                ]
            }),
            action: None,
            timeout_ms: None,
        })
        .await;

    let summary_content = match llm_result {
        Ok(v) => {
            let content = v["content"].as_str().unwrap_or("").to_string();
            format!("[Structured Summary]\n{content}")
        }
        Err(_) => format!(
            "[Structured Summary]\nGoal: {}\nProgress: {} messages processed\nDecisions: See context\nFiles: N/A\nNext Steps: Continue conversation\nCritical Context: {}",
            truncate_chars(&summary_text, 500),
            old_messages.len(),
            truncate_chars(&summary_text, 1000)
        ),
    };

    let condensed = Message {
        role: "system".into(),
        content: summary_content,
        tool_results: None,
        timestamp: None,
        tool_calls: None,
        tool_call_id: None,
        importance: None,
        extra: Default::default(),
    };
    removed_count += old_messages.len() as i64;

    let filtered: Vec<Message> = recent_messages
        .into_iter()
        .filter(|m| !(m.role == "system" && m.content.contains("[Structured Summary]")))
        .collect();
    messages = std::iter::once(condensed).chain(filtered).collect();

    let saved_tokens = original_tokens - estimate_messages_tokens(&messages);

    fire_void(
        iii,
        "hook::fire",
        json!({
            "type": "AfterCompact",
            "payload": {
                "agentId": agent_id,
                "removedCount": removed_count,
                "savedTokens": saved_tokens,
                "finalMessageCount": messages.len(),
            }
        }),
    );

    Ok(json!({
        "compressed": messages,
        "removedCount": removed_count,
        "savedTokens": saved_tokens,
    }))
}

async fn stats(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let messages = parse_messages(&body["messages"]);
    let total_tokens = estimate_messages_tokens(&messages);
    let tool_messages = messages
        .iter()
        .filter(|m| m.role == "tool" || m.tool_results.is_some())
        .count();
    let mut tool_ids: HashSet<String> = HashSet::new();
    for m in &messages {
        if m.role == "tool" && !m.content.is_empty() {
            match serde_json::from_str::<Value>(&m.content) {
                Ok(parsed) => {
                    if let Some(tcid) = parsed["tool_call_id"].as_str() {
                        tool_ids.insert(tcid.to_string());
                    }
                }
                Err(_) => {
                    tool_ids.insert(format!("tool_{}", tool_ids.len()));
                }
            }
        }
    }

    let now = now_ms();
    let oldest_age_min = messages
        .first()
        .and_then(|m| m.timestamp)
        .map(|ts| ((now - ts) as f64 / (1000.0 * 60.0)).round() as i64)
        .unwrap_or(0);

    let health_resp = iii
        .trigger(TriggerRequest {
            function_id: "context::health".into(),
            payload: json!({ "messages": messages, "maxTokens": 200_000 }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();
    let health_score = health_resp
        .as_ref()
        .and_then(|v| v["overall"].as_i64())
        .unwrap_or(-1);

    Ok(json!({
        "totalTokens": total_tokens,
        "messageCount": messages.len(),
        "toolResultCount": tool_messages,
        "uniqueTools": tool_ids.len(),
        "oldestMessageAge": oldest_age_min,
        "healthScore": health_score,
    }))
}

async fn trim_micro(input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let messages = parse_messages(&body["messages"]);
    let original_tokens = estimate_messages_tokens(&messages);
    let mut result: Vec<Message> = Vec::new();
    let recent_boundary = messages.len().saturating_sub(5);

    for (i, msg) in messages.iter().enumerate() {
        let is_tool = msg.role == "tool" || msg.tool_results.is_some();
        if i < recent_boundary && is_tool && msg.content.chars().count() > 100 {
            let mut shortened = msg.clone();
            shortened.content = truncate_chars(&msg.content, 100);
            shortened.tool_results = None;
            result.push(shortened);
            continue;
        }

        if let Some(prev) = result.last() {
            if prev.content == msg.content && prev.role == msg.role {
                continue;
            }
            if prev.role == "system" && msg.role == "system" {
                let last_idx = result.len() - 1;
                result[last_idx].content = format!("{}\n{}", result[last_idx].content, msg.content);
                continue;
            }
        }

        result.push(msg.clone());
    }

    Ok(json!({
        "compacted": result.clone(),
        "removedTokens": original_tokens - estimate_messages_tokens(&result),
    }))
}

async fn prune(input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let messages = parse_messages(&body["messages"]);
    if messages.len() <= 10 {
        return Ok(json!({ "snipped": messages, "removedCount": 0 }));
    }
    let keep_start: usize = 3;
    let keep_end_count = ((messages.len() as f64) * 0.4).ceil() as usize;
    let keep_end_start = messages.len() - keep_end_count;

    if keep_end_start <= keep_start {
        return Ok(json!({ "snipped": messages, "removedCount": 0 }));
    }

    let head: Vec<Message> = messages[..keep_start].to_vec();
    let tail: Vec<Message> = messages[keep_end_start..].to_vec();
    let removed_count = (keep_end_start - keep_start) as i64;

    let snip = Message {
        role: "system".into(),
        content: format!("[Snipped {removed_count} messages]"),
        tool_results: None,
        timestamp: None,
        tool_calls: None,
        tool_call_id: None,
        importance: None,
        extra: Default::default(),
    };

    let mut snipped: Vec<Message> = Vec::with_capacity(head.len() + 1 + tail.len());
    snipped.extend(head);
    snipped.push(snip);
    snipped.extend(tail);

    Ok(json!({ "snipped": snipped, "removedCount": removed_count }))
}

async fn auto_optimize(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let messages = parse_messages(&body["messages"]);
    let max_tokens = body["maxTokens"].as_i64().unwrap_or(200_000);
    let original_tokens = estimate_messages_tokens(&messages);

    let health_resp = iii
        .trigger(TriggerRequest {
            function_id: "context::health".into(),
            payload: json!({ "messages": messages, "maxTokens": max_tokens }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut messages = messages;
    let mut strategy = String::from("none");

    if health_resp["repetitionPenalty"].as_i64().unwrap_or(25) < 10 {
        strategy = "deduplicate".into();
        let mut deduped: Vec<Message> = Vec::with_capacity(messages.len());
        for msg in messages.into_iter() {
            if let Some(prev) = deduped.last()
                && prev.content == msg.content && prev.role == msg.role {
                    continue;
                }
            deduped.push(msg);
        }
        messages = deduped;
    }

    if health_resp["toolDensity"].as_i64().unwrap_or(25) < 10 {
        strategy = if strategy == "none" {
            "summarize_tools".into()
        } else {
            format!("{strategy}+summarize_tools")
        };
        for m in messages.iter_mut() {
            let is_tool = m.role == "tool" || m.tool_results.is_some();
            if is_tool && m.content.chars().count() > 200 {
                m.content = format!(
                    "[Tool summary: {}...]",
                    truncate_chars(&m.content, 100)
                );
                m.tool_results = None;
            }
        }
    }

    if health_resp["tokenUtilization"].as_i64().unwrap_or(25) < 20 {
        strategy = if strategy == "none" {
            "aggressive".into()
        } else {
            format!("{strategy}+aggressive")
        };
        let micro = iii
            .trigger(TriggerRequest {
                function_id: "context::trim".into(),
                payload: json!({ "messages": messages }),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        messages = parse_messages(&micro["compacted"]);

        let snip = iii
            .trigger(TriggerRequest {
                function_id: "context::prune".into(),
                payload: json!({ "messages": messages }),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        messages = parse_messages(&snip["snipped"]);
    }

    let final_tokens = estimate_messages_tokens(&messages);
    Ok(json!({
        "compacted": messages,
        "strategy": strategy,
        "savedTokens": original_tokens - final_tokens,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("context::health", move |input: Value| async move {
            health(input).await
        })
        .description("Compute context health score (0-100)"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::compress", move |input: Value| {
            let iii = iii_ref.clone();
            async move { compress(&iii, input).await }
        })
        .description("Proactive 5-phase context compression"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::stats", move |input: Value| {
            let iii = iii_ref.clone();
            async move { stats(&iii, input).await }
        })
        .description("Current context metrics"),
    );

    iii.register_function(
        RegisterFunction::new_async("context::trim", move |input: Value| async move {
            trim_micro(input).await
        })
        .description("Lightweight in-turn compression without LLM"),
    );

    iii.register_function(
        RegisterFunction::new_async("context::prune", move |input: Value| async move {
            prune(input).await
        })
        .description("Drop old turns entirely, keep structured summary placeholder"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::auto_optimize", move |input: Value| {
            let iii = iii_ref.clone();
            async move { auto_optimize(&iii, input).await }
        })
        .description("Pattern-detection-triggered compaction"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::health".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/health" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::compress".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/compress" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::stats".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/stats" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::trim".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/micro-compact" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::prune".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/snip-compact" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::auto_optimize".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/reactive-compact" }),
        metadata: None,
    })?;

    tracing::info!("context-monitor worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> Message {
        Message {
            role: role.into(),
            content: content.into(),
            tool_results: None,
            timestamp: None,
            tool_calls: None,
            tool_call_id: None,
            importance: None,
            extra: Default::default(),
        }
    }

    #[tokio::test]
    async fn health_ideal_context_returns_100() {
        let now = now_ms();
        let messages: Vec<Value> = (0..10)
            .map(|i| {
                json!({
                    "role": if i % 3 == 0 { "tool" } else if i % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("Message content {} with reasonable length here", i),
                    "timestamp": now - (i * 100) as i64
                })
            })
            .collect();
        let result = health(json!({
            "messages": messages,
            "maxTokens": 200_000
        })).await.unwrap();
        let overall = result["overall"].as_i64().unwrap();
        assert!(overall >= 99, "expected ~100, got {overall}");
    }

    #[tokio::test]
    async fn health_high_utilization_lowers_score() {
        let long = "x".repeat(4000);
        let messages: Vec<Value> = (0..10)
            .map(|i| {
                json!({
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("{long} unique{i}")
                })
            })
            .collect();
        let result = health(json!({
            "messages": messages,
            "maxTokens": 5000
        })).await.unwrap();
        assert!(result["tokenUtilization"].as_i64().unwrap() < 25);
    }

    #[tokio::test]
    async fn health_repetition_penalized() {
        let messages: Vec<Value> = (0..10)
            .map(|_| json!({
                "role": "user",
                "content": "The exact same message repeated over and over again"
            }))
            .collect();
        let result = health(json!({
            "messages": messages,
            "maxTokens": 200_000
        })).await.unwrap();
        assert!(result["repetitionPenalty"].as_i64().unwrap() < 25);
    }

    #[tokio::test]
    async fn prune_under_10_no_op() {
        let messages: Vec<Value> = (0..5).map(|i| json!({
            "role": "user",
            "content": format!("msg {i}")
        })).collect();
        let result = prune(json!({ "messages": messages })).await.unwrap();
        assert_eq!(result["removedCount"].as_i64().unwrap(), 0);
    }

    #[tokio::test]
    async fn prune_over_10_snips() {
        let messages: Vec<Value> = (0..30).map(|i| json!({
            "role": "user",
            "content": format!("msg {i}")
        })).collect();
        let result = prune(json!({ "messages": messages })).await.unwrap();
        let removed = result["removedCount"].as_i64().unwrap();
        assert!(removed > 0);
        let snipped = result["snipped"].as_array().unwrap();
        let has_snip = snipped.iter().any(|m| {
            m["role"] == "system" && m["content"].as_str().unwrap_or("").contains("Snipped")
        });
        assert!(has_snip);
    }

    #[tokio::test]
    async fn trim_micro_compacts_long_tool_results() {
        let mut messages = Vec::new();
        for i in 0..10 {
            messages.push(json!({
                "role": "tool",
                "content": "x".repeat(500),
                "toolResults": { "data": format!("d{i}") }
            }));
        }
        for i in 0..3 {
            messages.push(json!({
                "role": "user",
                "content": format!("recent {i}")
            }));
        }
        let result = trim_micro(json!({ "messages": messages })).await.unwrap();
        let removed = result["removedTokens"].as_i64().unwrap();
        assert!(removed > 0);
    }

    #[test]
    fn sanitize_removes_orphaned_results() {
        let messages = vec![
            Message {
                role: "assistant".into(),
                content: "".into(),
                tool_calls: Some(json!([{ "callId": "tc1", "id": "fn::read" }])),
                tool_results: None,
                tool_call_id: None,
                timestamp: None,
                importance: None,
                extra: Default::default(),
            },
            Message {
                role: "tool".into(),
                content: "result 1".into(),
                tool_call_id: Some("tc1".into()),
                tool_calls: None,
                tool_results: None,
                timestamp: None,
                importance: None,
                extra: Default::default(),
            },
            Message {
                role: "tool".into(),
                content: "orphan".into(),
                tool_call_id: Some("missing".into()),
                tool_calls: None,
                tool_results: None,
                timestamp: None,
                importance: None,
                extra: Default::default(),
            },
        ];
        let cleaned = sanitize_tool_pairs(messages);
        assert!(!cleaned.iter().any(|m| m.tool_call_id.as_deref() == Some("missing")));
    }

    #[test]
    fn sanitize_adds_stub_for_missing_results() {
        let messages = vec![
            Message {
                role: "assistant".into(),
                content: "".into(),
                tool_calls: Some(json!([
                    { "callId": "tc1", "id": "fn::read" },
                    { "callId": "tc2", "id": "fn::write" }
                ])),
                tool_results: None,
                tool_call_id: None,
                timestamp: None,
                importance: None,
                extra: Default::default(),
            },
            Message {
                role: "tool".into(),
                content: "result 1".into(),
                tool_call_id: Some("tc1".into()),
                tool_calls: None,
                tool_results: None,
                timestamp: None,
                importance: None,
                extra: Default::default(),
            },
        ];
        let cleaned = sanitize_tool_pairs(messages);
        let stub = cleaned
            .iter()
            .find(|m| m.tool_call_id.as_deref() == Some("tc2"));
        assert!(stub.is_some());
        assert_eq!(stub.unwrap().content, "[Result cleared — see context summary]");
    }

    #[test]
    fn message_role_check() {
        let m = msg("user", "hi");
        assert_eq!(m.role, "user");
    }
}

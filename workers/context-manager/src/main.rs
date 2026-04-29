use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

mod types;

use types::{
    BudgetAllocation, DEFAULT_ALLOCATION, DEFAULT_CONTEXT_WINDOW, Message, estimate_messages_tokens,
    estimate_tokens, truncate_chars,
};

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

fn budget_section(total: i64, ratio: f64, used: i64) -> Value {
    let allocated = (total as f64 * ratio).floor() as i64;
    json!({
        "allocated": allocated,
        "used": used,
        "remaining": (allocated - used).max(0),
    })
}

async fn estimate_tokens_handler(input: Value) -> Result<Value, IIIError> {
    let text = input["text"].as_str().unwrap_or("").to_string();
    let chars = text.chars().count() as i64;
    Ok(json!({
        "tokens": estimate_tokens(&text),
        "characters": chars,
    }))
}

async fn budget(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("agentId required".into()))?
        .to_string();
    let total = input["contextWindow"]
        .as_i64()
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let mut alloc = DEFAULT_ALLOCATION;

    let config = iii
        .trigger(TriggerRequest {
            function_id: "state::get".into(),
            payload: json!({ "scope": "agents", "key": &agent_id }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    if let Some(max_per_hour) = config
        .as_ref()
        .and_then(|c| c["resources"]["maxTokensPerHour"].as_i64())
    {
        let effective = total.min(max_per_hour);
        if effective < total {
            let ratio = effective as f64 / total as f64;
            alloc = BudgetAllocation {
                system_prompt: alloc.system_prompt * ratio,
                skills: alloc.skills * ratio,
                memories: alloc.memories * ratio,
                conversation: alloc.conversation * ratio,
            };
        }
    }

    let system_prompt_text = input["systemPrompt"]
        .as_str()
        .map(String::from)
        .or_else(|| {
            config
                .as_ref()
                .and_then(|c| c["systemPrompt"].as_str())
                .map(String::from)
        })
        .unwrap_or_default();

    let system_tokens = estimate_tokens(&system_prompt_text);
    let skills_tokens: i64 = input["skills"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|s| estimate_tokens(s.as_str().unwrap_or("")))
                .sum()
        })
        .unwrap_or(0);
    let memories_tokens: i64 = input["memories"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|m| estimate_tokens(m.as_str().unwrap_or("")))
                .sum()
        })
        .unwrap_or(0);
    let conversation = parse_messages(&input["conversation"]);
    let conversation_tokens = estimate_messages_tokens(&conversation);

    let used = system_tokens + skills_tokens + memories_tokens + conversation_tokens;

    Ok(json!({
        "total": total,
        "used": used,
        "remaining": (total - used).max(0),
        "allocation": alloc,
        "sections": {
            "systemPrompt": budget_section(total, alloc.system_prompt, system_tokens),
            "skills": budget_section(total, alloc.skills, skills_tokens),
            "memories": budget_section(total, alloc.memories, memories_tokens),
            "conversation": budget_section(total, alloc.conversation, conversation_tokens),
        }
    }))
}

fn trim_conversation(conversation: Vec<Message>, max_tokens: i64, keep_last_n: usize) -> Value {
    if conversation.is_empty() {
        return json!({ "messages": [], "trimmed": 0 });
    }

    let total_tokens = estimate_messages_tokens(&conversation);
    if total_tokens <= max_tokens {
        return json!({
            "messages": conversation,
            "trimmed": 0,
            "tokens": total_tokens,
        });
    }

    let first: Vec<Message> = match conversation.first() {
        Some(m) if m.role == "system" => vec![m.clone()],
        _ => Vec::new(),
    };
    let tail_start = conversation.len().saturating_sub(keep_last_n);
    let tail: Vec<Message> = conversation[tail_start..].to_vec();
    let first_tokens = estimate_messages_tokens(&first);
    let tail_tokens = estimate_messages_tokens(&tail);

    if first_tokens + tail_tokens > max_tokens {
        let mut trimmed_tail: Vec<Message> = Vec::new();
        let mut budget_remaining = max_tokens - first_tokens;
        for msg in tail.iter().rev() {
            if budget_remaining <= 0 {
                break;
            }
            let msg_tokens = estimate_tokens(&msg.content);
            if msg_tokens <= budget_remaining {
                trimmed_tail.insert(0, msg.clone());
                budget_remaining -= msg_tokens;
            } else {
                let max_chars = (budget_remaining * 4) as usize;
                let mut truncated = msg.clone();
                truncated.content = truncate_chars(&msg.content, max_chars);
                trimmed_tail.insert(0, truncated);
                break;
            }
        }
        let mut combined: Vec<Message> = Vec::new();
        combined.extend(first.iter().cloned());
        combined.extend(trimmed_tail.iter().cloned());
        let combined_tokens = estimate_messages_tokens(&combined);
        let trimmed_count = conversation.len() as i64 - first.len() as i64 - trimmed_tail.len() as i64;
        return json!({
            "messages": combined,
            "trimmed": trimmed_count,
            "tokens": combined_tokens,
        });
    }

    let mut result: Vec<Message> = Vec::new();
    result.extend(first.iter().cloned());
    result.extend(tail.iter().cloned());
    let trimmed_count = conversation.len() as i64 - result.len() as i64;
    json!({
        "messages": result,
        "trimmed": trimmed_count,
        "tokens": first_tokens + tail_tokens,
    })
}

async fn trim_handler(input: Value) -> Result<Value, IIIError> {
    let conversation = parse_messages(&input["conversation"]);
    let max_tokens = input["maxTokens"]
        .as_i64()
        .ok_or_else(|| IIIError::Handler("maxTokens required".into()))?;
    let keep_last_n = input["keepLastN"].as_i64().unwrap_or(10).max(1) as usize;
    Ok(trim_conversation(conversation, max_tokens, keep_last_n))
}

async fn overflow_recover(iii: &III, input: Value) -> Result<Value, IIIError> {
    let conversation = parse_messages(&input["conversation"]);
    let max_tokens = input["maxTokens"]
        .as_i64()
        .ok_or_else(|| IIIError::Handler("maxTokens required".into()))?;
    let mut messages = conversation.clone();
    let mut current_tokens = estimate_messages_tokens(&messages);
    let mut stages: Vec<String> = Vec::new();

    if current_tokens <= max_tokens {
        return Ok(json!({
            "messages": messages,
            "stages": ["no_action_needed"],
            "tokens": current_tokens,
        }));
    }

    let recent_threshold = (messages.len() as i64 - 10).max(0) as usize;
    for m in messages.iter_mut().take(recent_threshold) {
        if m.tool_results.is_some() {
            m.tool_results = None;
        }
    }
    current_tokens = estimate_messages_tokens(&messages);
    stages.push("stage1_remove_old_tool_results".into());

    if current_tokens <= max_tokens {
        return Ok(json!({ "messages": messages, "stages": stages, "tokens": current_tokens }));
    }

    let summary_threshold = (messages.len() as i64 - 15).max(1) as usize;
    let to_summarize: Vec<Message> = messages[..summary_threshold].to_vec();
    let kept: Vec<Message> = messages[summary_threshold..].to_vec();

    if !to_summarize.is_empty() {
        let summary_text = to_summarize
            .iter()
            .filter(|m| !m.content.is_empty())
            .map(|m| format!("[{}]: {}", m.role, truncate_chars(&m.content, 200)))
            .collect::<Vec<_>>()
            .join("\n");

        let summary_content = format!(
            "[Conversation summary - {} messages condensed]\n{}",
            to_summarize.len(),
            truncate_chars(&summary_text, 2000)
        );
        let summary = Message {
            role: "system".into(),
            content: summary_content,
            tool_results: None,
            importance: None,
            timestamp: None,
            extra: Default::default(),
        };

        messages = std::iter::once(summary).chain(kept).collect();
        current_tokens = estimate_messages_tokens(&messages);
        stages.push("stage2_summarize_old_messages".into());
    }

    if current_tokens <= max_tokens {
        return Ok(json!({ "messages": messages, "stages": stages, "tokens": current_tokens }));
    }

    messages.retain(|m| {
        !(m.role == "system"
            && m.importance.is_some()
            && m.importance.unwrap() < 3)
    });
    current_tokens = estimate_messages_tokens(&messages);
    stages.push("stage3_drop_low_importance".into());

    if current_tokens <= max_tokens {
        return Ok(json!({ "messages": messages, "stages": stages, "tokens": current_tokens }));
    }

    let trim_result = iii
        .trigger(TriggerRequest {
            function_id: "context::trim".into(),
            payload: json!({
                "conversation": messages,
                "maxTokens": max_tokens,
                "keepLastN": 5,
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    stages.push("stage4_emergency_truncation".into());

    let trimmed_messages = parse_messages(&trim_result["messages"]);
    let final_tokens = estimate_messages_tokens(&trimmed_messages);

    Ok(json!({
        "messages": trimmed_messages,
        "stages": stages,
        "tokens": final_tokens,
    }))
}

async fn build_prompt(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("agentId required".into()))?
        .to_string();
    let total = input["contextWindow"]
        .as_i64()
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let alloc = DEFAULT_ALLOCATION;

    let system_budget = (total as f64 * alloc.system_prompt).floor() as i64;
    let skills_budget = (total as f64 * alloc.skills).floor() as i64;
    let memories_budget = (total as f64 * alloc.memories).floor() as i64;
    let conversation_budget = (total as f64 * alloc.conversation).floor() as i64;

    let mut system = input["systemPrompt"].as_str().unwrap_or("").to_string();
    if system.is_empty() {
        let config = iii
            .trigger(TriggerRequest {
                function_id: "state::get".into(),
                payload: json!({ "scope": "agents", "key": &agent_id }),
                action: None,
                timeout_ms: None,
            })
            .await
            .ok();
        system = config
            .as_ref()
            .and_then(|c| c["systemPrompt"].as_str())
            .unwrap_or("You are a helpful AI assistant.")
            .to_string();
    }

    let system_tokens = estimate_tokens(&system);
    if system_tokens > system_budget {
        let max_chars = (system_budget * 4) as usize;
        system = truncate_chars(&system, max_chars);
    }

    let mut skills_content = String::new();
    let mut skills_tokens: i64 = 0;
    if let Some(arr) = input["skillIds"].as_array() {
        for sid_val in arr {
            let Some(sid) = sid_val.as_str() else { continue };
            let skill = iii
                .trigger(TriggerRequest {
                    function_id: "skill::get".into(),
                    payload: json!({ "id": sid }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .ok();
            let Some(skill_value) = skill else { continue };
            let Some(content) = skill_value["content"].as_str() else {
                continue;
            };
            let additional = estimate_tokens(content);
            if skills_tokens + additional > skills_budget {
                break;
            }
            let name = skill_value["name"].as_str().unwrap_or("");
            skills_content.push_str(&format!("\n---\n[Skill: {name}]\n{content}"));
            skills_tokens += additional;
        }
    }

    let mut memories_content = String::new();
    let mut memories_tokens_used: i64 = 0;
    if let Some(arr) = input["memories"].as_array() {
        for mem_val in arr {
            let Some(mem) = mem_val.as_str() else { continue };
            let additional = estimate_tokens(mem);
            if memories_tokens_used + additional > memories_budget {
                break;
            }
            memories_content.push('\n');
            memories_content.push_str(mem);
            memories_tokens_used += additional;
        }
    }

    let mut conversation = parse_messages(&input["conversation"]);
    if estimate_messages_tokens(&conversation) > conversation_budget {
        let result = iii
            .trigger(TriggerRequest {
                function_id: "context::trim".into(),
                payload: json!({
                    "conversation": conversation,
                    "maxTokens": conversation_budget,
                }),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        conversation = parse_messages(&result["messages"]);
    }

    let mut system_message = system.clone();
    if !skills_content.is_empty() {
        system_message.push_str(&format!("\n\n## Active Skills\n{skills_content}"));
    }
    if !memories_content.is_empty() {
        system_message.push_str(&format!("\n\n## Relevant Memories\n{memories_content}"));
    }

    let mut full_prompt: Vec<Message> = Vec::with_capacity(conversation.len() + 1);
    full_prompt.push(Message {
        role: "system".into(),
        content: system_message,
        tool_results: None,
        importance: None,
        timestamp: None,
        extra: Default::default(),
    });
    full_prompt.extend(conversation.iter().cloned());

    let final_tokens = estimate_messages_tokens(&full_prompt);
    let conversation_tokens = estimate_messages_tokens(&conversation);

    Ok(json!({
        "messages": full_prompt,
        "tokens": final_tokens,
        "budget": total,
        "remaining": total - final_tokens,
        "sections": {
            "system": estimate_tokens(&system),
            "skills": skills_tokens,
            "memories": memories_tokens_used,
            "conversation": conversation_tokens,
        }
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("context::estimate_tokens", move |input: Value| async move {
            estimate_tokens_handler(input).await
        })
        .description("Rough token estimation"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::budget", move |input: Value| {
            let iii = iii_ref.clone();
            async move { budget(&iii, input).await }
        })
        .description("Calculate remaining context budget for an agent"),
    );

    iii.register_function(
        RegisterFunction::new_async("context::trim", move |input: Value| async move {
            trim_handler(input).await
        })
        .description("Trim conversation to fit within budget"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::overflow_recover", move |input: Value| {
            let iii = iii_ref.clone();
            async move { overflow_recover(&iii, input).await }
        })
        .description("Multi-stage overflow recovery"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("context::build_prompt", move |input: Value| {
            let iii = iii_ref.clone();
            async move { build_prompt(&iii, input).await }
        })
        .description("Assemble full prompt within budget"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::budget".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/budget" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::trim".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/trim" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::overflow_recover".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/recover" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::build_prompt".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/build" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "context::estimate_tokens".into(),
        config: json!({ "http_method": "POST", "api_path": "api/context/tokens" }),
        metadata: None,
    })?;

    tracing::info!("context-manager worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(role: &str, content: &str) -> Message {
        Message {
            role: role.into(),
            content: content.into(),
            tool_results: None,
            importance: None,
            timestamp: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn trim_returns_unchanged_when_under_budget() {
        let convo = vec![msg("user", "hi")];
        let result = trim_conversation(convo.clone(), 1000, 10);
        assert_eq!(result["trimmed"].as_i64().unwrap(), 0);
    }

    #[test]
    fn trim_empty_returns_empty() {
        let result = trim_conversation(Vec::new(), 100, 10);
        assert_eq!(result["trimmed"].as_i64().unwrap(), 0);
        assert_eq!(result["messages"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn trim_keeps_last_n() {
        let convo: Vec<Message> = (0..30).map(|i| msg("user", &format!("msg {i}"))).collect();
        let result = trim_conversation(convo, 50, 5);
        let len = result["messages"].as_array().unwrap().len();
        assert!(len <= 6);
    }

    #[test]
    fn trim_preserves_system_first() {
        let mut convo = vec![msg("system", "You are helpful.")];
        for i in 0..20 {
            convo.push(msg("user", &format!("Message {i} with some content here")));
        }
        let result = trim_conversation(convo, 200, 10);
        let arr = result["messages"].as_array().unwrap();
        assert_eq!(arr[0]["role"], "system");
    }

    #[test]
    fn budget_section_calculation() {
        let v = budget_section(1000, 0.2, 50);
        assert_eq!(v["allocated"], 200);
        assert_eq!(v["used"], 50);
        assert_eq!(v["remaining"], 150);
    }

    #[test]
    fn budget_section_remaining_non_negative() {
        let v = budget_section(100, 0.5, 1000);
        assert_eq!(v["remaining"], 0);
    }

    #[test]
    fn parse_messages_handles_extra_fields() {
        let raw = json!([
            { "role": "user", "content": "hi", "extra_field": "x" }
        ]);
        let parsed = parse_messages(&raw);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].role, "user");
    }
}

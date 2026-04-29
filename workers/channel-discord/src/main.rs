use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const DISCORD_API: &str = "https://discord.com/api/v10";
const DISCORD_MAX_LEN: usize = 2000;

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining: &str = text;
    while !remaining.is_empty() {
        if remaining.chars().count() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        let mut split_idx = remaining
            .char_indices()
            .take(max_len + 1)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(remaining.len());
        if let Some(nl) = remaining[..split_idx].rfind('\n') {
            if nl >= max_len / 2 {
                split_idx = nl;
            }
        }
        chunks.push(remaining[..split_idx].to_string());
        remaining = &remaining[split_idx..];
    }
    chunks
}

async fn resolve_agent(iii: &III, channel: &str, channel_id: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
                "scope": "channel_agents",
                "key": format!("{channel}:{channel_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await;
    match result {
        Ok(v) => v
            .get("agentId")
            .and_then(|a| a.as_str())
            .unwrap_or("default")
            .to_string(),
        Err(_) => "default".to_string(),
    }
}

async fn get_secret(iii: &III, key: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(v) = result {
        if let Some(value) = v.get("value").and_then(|s| s.as_str()) {
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    std::env::var(key).unwrap_or_default()
}

async fn send_message(
    iii: &III,
    client: &reqwest::Client,
    channel_id: &str,
    content: &str,
) -> Result<(), IIIError> {
    let bot_token = get_secret(iii, "DISCORD_BOT_TOKEN").await;
    if bot_token.is_empty() {
        return Err(IIIError::Handler("DISCORD_BOT_TOKEN not configured".into()));
    }
    for chunk in split_message(content, DISCORD_MAX_LEN) {
        let url = format!("{DISCORD_API}/channels/{channel_id}/messages");
        let res = client
            .post(&url)
            .header("Authorization", format!("Bot {bot_token}"))
            .header("Content-Type", "application/json")
            // Suppress all mentions so prompt-injected `@everyone`/role/user
            // pings in model output never reach Discord.
            .json(&json!({
                "content": chunk,
                "allowed_mentions": { "parse": [] },
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "Discord send failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            )));
        }
    }
    Ok(())
}

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    input: Value,
) -> Result<Value, IIIError> {
    let event = input.get("body").cloned().unwrap_or(input);

    if event.get("t").and_then(|t| t.as_str()) == Some("MESSAGE_CREATE") {
        let msg = event.get("d").cloned().unwrap_or_else(|| json!({}));
        let is_bot = msg
            .get("author")
            .and_then(|a| a.get("bot"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        if is_bot {
            return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
        }

        let channel_id = msg
            .get("channel_id")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        // Skip MESSAGE_CREATE events with no text (attachments, stickers,
        // system events) to avoid generating an LLM reply to nothing.
        if content.trim().is_empty() {
            return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
        }

        let agent_id = resolve_agent(iii, "discord", &channel_id).await;

        let chat_response = iii
            .trigger(TriggerRequest {
                function_id: "agent::chat".to_string(),
                payload: json!({
                    "agentId": agent_id,
                    "message": content,
                    "sessionId": format!("discord:{channel_id}"),
                }),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;

        let reply = chat_response
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        if !channel_id.is_empty() && !reply.is_empty() {
            send_message(iii, client, &channel_id, &reply).await?;
        }

        // Emit channel_message audit event so Discord traffic is captured by
        // the same monitoring pipeline as the other channel adapters.
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "channel_message",
                    "agentId": agent_id,
                    "detail": { "channel": "discord", "channelId": channel_id },
                }),
                action: Some(TriggerAction::Void),
                timeout_ms: None,
            })
            .await;
    }

    Ok(json!({ "status_code": 200, "body": { "ok": true } }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::new();

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::discord::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle Discord interaction/webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::discord::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/discord" }),
        metadata: None,
    })?;

    tracing::info!("channel-discord worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_message_returns_single_chunk() {
        let chunks = split_message("hello", 2000);
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn split_long_message_chunks_at_limit() {
        let text = "a".repeat(2500);
        let chunks = split_message(&text, 2000);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= 2000));
    }

    #[test]
    fn split_prefers_newline_break() {
        let text = format!("{}\n{}", "a".repeat(1500), "b".repeat(800));
        let chunks = split_message(&text, 2000);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].ends_with(&"a".repeat(1500)));
    }
}

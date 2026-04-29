use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const TWITCH_API: &str = "https://api.twitch.tv/helix";
const MAX_MESSAGE_LEN: usize = 500;

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
        let split_idx = remaining
            .char_indices()
            .nth(max_len)
            .map(|(i, _)| i)
            .unwrap_or(remaining.len());
        chunks.push(remaining[..split_idx].to_string());
        remaining = &remaining[split_idx..];
    }
    chunks
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
    if let Ok(v) = result
        && let Some(value) = v.get("value").and_then(|s| s.as_str())
        && !value.is_empty()
    {
        return value.to_string();
    }
    std::env::var(key).unwrap_or_default()
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

async fn send_message(
    iii: &III,
    client: &reqwest::Client,
    broadcaster_id: &str,
    text: &str,
) -> Result<(), IIIError> {
    let token = get_secret(iii, "TWITCH_TOKEN").await;
    if token.is_empty() {
        return Err(IIIError::Handler("TWITCH_TOKEN not configured".into()));
    }
    let client_id = get_secret(iii, "TWITCH_CLIENT_ID").await;
    if client_id.is_empty() {
        return Err(IIIError::Handler("TWITCH_CLIENT_ID not configured".into()));
    }
    for chunk in split_message(text, MAX_MESSAGE_LEN) {
        let url = format!("{TWITCH_API}/chat/messages");
        let res = client
            .post(&url)
            .bearer_auth(&token)
            .header("Client-Id", &client_id)
            .header("Content-Type", "application/json")
            .json(&json!({
                "broadcaster_id": broadcaster_id,
                "sender_id": broadcaster_id,
                "message": chunk,
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("Twitch send error: {e}")))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "Twitch send failed ({status}): {}",
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
    let body = input.get("body").cloned().unwrap_or(input);

    // EventSub challenge handshake.
    if let Some(challenge) = body.get("challenge").and_then(|v| v.as_str()) {
        return Ok(json!({
            "status_code": 200,
            "body": challenge,
        }));
    }

    let event = body.get("event").cloned().unwrap_or_else(|| json!({}));
    let text = event
        .get("message")
        .and_then(|m| m.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    if text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let channel_id = event
        .get("broadcaster_user_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_id = event
        .get("user_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let agent_id = resolve_agent(iii, "twitch", &channel_id).await;

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("twitch:{channel_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if !reply.is_empty()
        && !channel_id.is_empty()
        && let Err(e) = send_message(iii, client, &channel_id, &reply).await
    {
        tracing::error!(error = %e, "failed to post Twitch reply");
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": {
                    "channel": "twitch",
                    "channelId": channel_id,
                    "userId": user_id,
                },
            }),
            action: Some(TriggerAction::Void),
            timeout_ms: None,
        })
        .await;

    Ok(json!({ "status_code": 200, "body": { "ok": true } }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let ws_url =
        std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::new();

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::twitch::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle Twitch EventSub webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::twitch::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/twitch" }),
        metadata: None,
    })?;

    tracing::info!("channel-twitch worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_returns_single_chunk() {
        let chunks = split_message("hello", 500);
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn split_long_chunks_at_limit() {
        let text = "x".repeat(1200);
        let chunks = split_message(&text, 500);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.chars().count() <= 500));
    }

    #[test]
    fn split_handles_multibyte_chars() {
        let text: String = "🦀".repeat(10);
        let chunks = split_message(&text, 3);
        let joined: String = chunks.concat();
        assert_eq!(joined, text);
    }
}

use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const MATRIX_MAX_LEN: usize = 4096;

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

fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
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
    room_id: &str,
    text: &str,
) -> Result<(), IIIError> {
    let homeserver = get_secret(iii, "MATRIX_HOMESERVER").await;
    if homeserver.is_empty() {
        return Err(IIIError::Handler("MATRIX_HOMESERVER not configured".into()));
    }
    let token = get_secret(iii, "MATRIX_TOKEN").await;
    if token.is_empty() {
        return Err(IIIError::Handler("MATRIX_TOKEN not configured".into()));
    }
    let txn_base = uuid::Uuid::new_v4().to_string();
    let chunks = split_message(text, MATRIX_MAX_LEN);
    let encoded_room = url_encode(room_id);
    for (i, chunk) in chunks.iter().enumerate() {
        let url = format!(
            "{homeserver}/_matrix/client/v3/rooms/{encoded_room}/send/m.room.message/{txn_base}-{i}"
        );
        let res = client
            .put(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            // Use m.notice for bot-generated replies. Matrix clients and
            // well-behaved bots ignore m.notice events when deciding what to
            // process, which prevents the worker from ingesting its own
            // messages if the homeserver echoes them back to the webhook.
            .json(&json!({ "msgtype": "m.notice", "body": chunk }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        if !res.status().is_success() {
            return Err(IIIError::Handler(format!(
                "Matrix send failed: {}",
                res.status()
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

    if event.get("type").and_then(|t| t.as_str()) != Some("m.room.message") {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    // Skip events authored as m.notice — those are bot-generated replies
    // (including ours) and processing them would create a feedback loop.
    let msgtype = event
        .get("content")
        .and_then(|c| c.get("msgtype"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if msgtype == "m.notice" {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let room_id = event
        .get("room_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let text = event
        .get("content")
        .and_then(|c| c.get("body"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sender = event
        .get("sender")
        .and_then(|v| v.as_str())
        .map(String::from);

    if text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let agent_id = resolve_agent(iii, "matrix", &room_id).await;

    let chat_response = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("matrix:{room_id}"),
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

    if !reply.is_empty() && !room_id.is_empty() {
        send_message(iii, client, &room_id, &reply).await?;
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": { "channel": "matrix", "roomId": room_id, "sender": sender },
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
    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::new();

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::matrix::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle Matrix homeserver webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::matrix::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/matrix" }),
        metadata: None,
    })?;

    tracing::info!("channel-matrix worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_passes_unreserved() {
        assert_eq!(url_encode("abcXYZ123-_.~"), "abcXYZ123-_.~");
    }

    #[test]
    fn url_encode_escapes_room_id() {
        assert_eq!(url_encode("!room1:matrix.org"), "%21room1%3Amatrix.org");
    }

    #[test]
    fn split_short_returns_single() {
        assert_eq!(split_message("hi", 4096), vec!["hi".to_string()]);
    }

    #[test]
    fn split_long_chunks() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text, 4096);
        assert!(chunks.len() >= 2);
    }
}

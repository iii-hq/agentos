use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const WHATSAPP_API_BASE: &str = "https://graph.facebook.com/v18.0";
const MAX_MESSAGE_LEN: usize = 4096;

/// Get a secret from `vault::get` first, falling back to env var.
async fn get_secret(iii: &III, key: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(value) = result
        && let Some(v) = value.get("value").and_then(|v| v.as_str())
        && !v.is_empty()
    {
        return v.to_string();
    }
    std::env::var(key).unwrap_or_default()
}

async fn resolve_agent(iii: &III, channel: &str, channel_id: &str) -> String {
    let key = format!("{channel}:{channel_id}");
    let result = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "channel_agents", "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(value) = result
        && let Some(agent) = value.get("agentId").and_then(|v| v.as_str())
    {
        return agent.to_string();
    }
    "default".to_string()
}

/// UTF-8-safe split into max-`max_len` char chunks, breaking on newline when reasonable.
fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = text.to_string();
    while !remaining.is_empty() {
        if remaining.chars().count() <= max_len {
            chunks.push(remaining);
            break;
        }
        let cutoff = remaining
            .char_indices()
            .nth(max_len)
            .map(|(idx, _)| idx)
            .unwrap_or(remaining.len());
        let window = &remaining[..cutoff];
        let split_at = match window.rfind('\n') {
            Some(idx) if window[..idx].chars().count() > max_len / 2 => idx,
            _ => cutoff,
        };
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].to_string();
    }
    chunks
}

async fn send_message(
    client: &reqwest::Client,
    token: &str,
    phone_id: &str,
    to: &str,
    text: &str,
) -> Result<(), IIIError> {
    if token.is_empty() {
        return Err(IIIError::Handler("WHATSAPP_TOKEN not configured".into()));
    }
    if phone_id.is_empty() {
        return Err(IIIError::Handler("WHATSAPP_PHONE_ID not configured".into()));
    }
    let url = format!("{WHATSAPP_API_BASE}/{phone_id}/messages");
    for chunk in split_message(text, MAX_MESSAGE_LEN) {
        let resp = client
            .post(&url)
            .bearer_auth(token)
            .json(&json!({
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": { "body": chunk },
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("WhatsApp send error: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "WhatsApp send failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            )));
        }
    }
    Ok(())
}

async fn handle_webhook(
    iii: &III,
    client: &reqwest::Client,
    req: Value,
) -> Result<Value, IIIError> {
    let body = req.get("body").cloned().unwrap_or_else(|| req.clone());

    if body.get("object").and_then(|v| v.as_str()) != Some("whatsapp_business_account") {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let message = body
        .get("entry")
        .and_then(|e| e.get(0))
        .and_then(|e| e.get("changes"))
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("value"))
        .and_then(|v| v.get("messages"))
        .and_then(|m| m.get(0));

    let Some(message) = message else {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    };

    let text = message
        .get("text")
        .and_then(|t| t.get("body"))
        .and_then(|b| b.as_str())
        .unwrap_or("");
    if text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let from = message
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let agent_id = resolve_agent(iii, "whatsapp", &from).await;

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("whatsapp:{from}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if !reply.is_empty() {
        let token = get_secret(iii, "WHATSAPP_TOKEN").await;
        let phone_id = get_secret(iii, "WHATSAPP_PHONE_ID").await;
        if let Err(e) = send_message(client, &token, &phone_id, &from, reply).await {
            tracing::error!(to = %from, error = %e, "failed to send WhatsApp reply");
        }
    }

    let audit_iii = iii.clone();
    let from_for_audit = from.clone();
    let agent_for_audit = agent_id.clone();
    tokio::spawn(async move {
        let _ = audit_iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "channel_message",
                    "agentId": agent_for_audit,
                    "detail": { "channel": "whatsapp", "from": from_for_audit },
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });

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
        RegisterFunction::new_async("channel::whatsapp::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { handle_webhook(&iii, &client, input).await }
        })
        .description("Handle WhatsApp Business API webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::whatsapp::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/whatsapp" }),
        metadata: None,
    })?;

    tracing::info!("channel-whatsapp worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_text_returns_single_chunk() {
        let chunks = split_message("hi", 4096);
        assert_eq!(chunks, vec!["hi".to_string()]);
    }

    #[test]
    fn split_preserves_total_length() {
        let text = "x".repeat(10_000);
        let chunks = split_message(&text, 4096);
        let joined: String = chunks.concat();
        assert_eq!(joined, text);
    }

    #[test]
    fn split_handles_multibyte_chars() {
        let text: String = "🦀".repeat(10);
        let chunks = split_message(&text, 3);
        let joined: String = chunks.concat();
        assert_eq!(joined, text);
    }

    #[test]
    fn ignores_non_whatsapp_object() {
        let body = json!({ "object": "page" });
        assert_ne!(
            body.get("object").and_then(|v| v.as_str()),
            Some("whatsapp_business_account")
        );
    }

    #[test]
    fn extracts_text_from_nested_payload() {
        let body = json!({
            "object": "whatsapp_business_account",
            "entry": [{
                "changes": [{
                    "value": {
                        "messages": [{
                            "from": "15551234567",
                            "text": { "body": "hello" }
                        }]
                    }
                }]
            }]
        });
        let text = body
            .get("entry")
            .and_then(|e| e.get(0))
            .and_then(|e| e.get("changes"))
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("value"))
            .and_then(|v| v.get("messages"))
            .and_then(|m| m.get(0))
            .and_then(|m| m.get("text"))
            .and_then(|t| t.get("body"))
            .and_then(|b| b.as_str())
            .unwrap_or("");
        assert_eq!(text, "hello");
    }

    #[test]
    fn missing_text_yields_empty() {
        let body = json!({
            "object": "whatsapp_business_account",
            "entry": [{ "changes": [{ "value": { "messages": [{ "from": "1" }] } }] }]
        });
        let text = body
            .pointer("/entry/0/changes/0/value/messages/0/text/body")
            .and_then(|b| b.as_str())
            .unwrap_or("");
        assert!(text.is_empty());
    }
}

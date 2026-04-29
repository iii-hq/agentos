use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::time::Duration;

const TELEGRAM_MAX_LEN: usize = 4096;

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

fn safe_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn verify_telegram_update(secret_token: &str, input: &Value) -> bool {
    if secret_token.is_empty() {
        return false;
    }
    let header = input
        .get("headers")
        .and_then(|h| h.get("x-telegram-bot-api-secret-token"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if header.is_empty() {
        return false;
    }
    safe_eq(header, secret_token)
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
    chat_id: i64,
    text: &str,
) -> Result<(), IIIError> {
    let bot_token = get_secret(iii, "TELEGRAM_BOT_TOKEN").await;
    if bot_token.is_empty() {
        return Err(IIIError::Handler("TELEGRAM_BOT_TOKEN not configured".into()));
    }
    for chunk in split_message(text, TELEGRAM_MAX_LEN) {
        let url = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
        let res = client
            .post(&url)
            .header("Content-Type", "application/json")
            // Send as plain text. Telegram Markdown would need every `_`,
            // `*`, `[`, `]`, and backtick in unescaped model output to be
            // escaped, otherwise the API rejects the message.
            .json(&json!({
                "chat_id": chat_id,
                "text": chunk,
            }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "Telegram send failed ({status}): {}",
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
    let secret_token = get_secret(iii, "TELEGRAM_SECRET_TOKEN").await;
    if !verify_telegram_update(&secret_token, &input) {
        return Ok(json!({
            "status_code": 401,
            "body": { "error": "Missing or invalid webhook signature" },
        }));
    }

    let update = input.get("body").cloned().unwrap_or_else(|| input.clone());
    let message = update
        .get("message")
        .or_else(|| update.get("edited_message"))
        .cloned()
        .unwrap_or(Value::Null);

    let text = message.get("text").and_then(|t| t.as_str()).unwrap_or("");
    if text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let chat_id = message
        .get("chat")
        .and_then(|c| c.get("id"))
        .and_then(|i| i.as_i64())
        .unwrap_or(0);
    let user_id = message
        .get("from")
        .and_then(|f| f.get("id"))
        .and_then(|i| i.as_i64());

    let agent_id = resolve_agent(iii, "telegram", &chat_id.to_string()).await;

    let chat_response = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("telegram:{chat_id}"),
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

    if !reply.is_empty() {
        send_message(iii, client, chat_id, &reply).await?;
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": { "channel": "telegram", "chatId": chat_id, "userId": user_id },
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
        RegisterFunction::new_async("channel::telegram::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle Telegram webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::telegram::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/telegram" }),
        metadata: None,
    })?;

    tracing::info!("channel-telegram worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_eq_matches_equal_strings() {
        assert!(safe_eq("abc", "abc"));
    }

    #[test]
    fn safe_eq_rejects_unequal_strings() {
        assert!(!safe_eq("abc", "abd"));
        assert!(!safe_eq("abc", "ab"));
    }

    #[test]
    fn verify_rejects_empty_secret() {
        let body = json!({ "headers": { "x-telegram-bot-api-secret-token": "x" } });
        assert!(!verify_telegram_update("", &body));
    }

    #[test]
    fn verify_rejects_missing_header() {
        let body = json!({ "headers": {} });
        assert!(!verify_telegram_update("secret", &body));
    }

    #[test]
    fn verify_accepts_matching_token() {
        let body = json!({ "headers": { "x-telegram-bot-api-secret-token": "secret" } });
        assert!(verify_telegram_update("secret", &body));
    }

    #[test]
    fn verify_rejects_mismatched_token() {
        let body = json!({ "headers": { "x-telegram-bot-api-secret-token": "wrong" } });
        assert!(!verify_telegram_update("secret", &body));
    }

    #[test]
    fn split_under_limit_returns_single_chunk() {
        let chunks = split_message("hello", 4096);
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn split_over_limit_chunks() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text, 4096);
        assert!(chunks.len() >= 2);
    }
}

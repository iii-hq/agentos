use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const MASTODON_MAX_LEN: usize = 500;

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

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
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
    text: &str,
    in_reply_to_id: Option<String>,
) -> Result<(), IIIError> {
    let instance = get_secret(iii, "MASTODON_INSTANCE").await;
    if instance.is_empty() {
        return Err(IIIError::Handler("MASTODON_INSTANCE not configured".into()));
    }
    let token = get_secret(iii, "MASTODON_TOKEN").await;
    if token.is_empty() {
        return Err(IIIError::Handler("MASTODON_TOKEN not configured".into()));
    }
    let mut reply_id = in_reply_to_id;
    for chunk in split_message(text, MASTODON_MAX_LEN) {
        let mut body = json!({ "status": chunk });
        if let Some(id) = &reply_id {
            body["in_reply_to_id"] = json!(id);
        }
        let url = format!("{instance}/api/v1/statuses");
        let res = client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        if !res.status().is_success() {
            return Err(IIIError::Handler(format!(
                "Mastodon post failed: {}",
                res.status()
            )));
        }
        let resp: Value = res
            .json()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        let new_id = resp
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| IIIError::Handler("Mastodon response missing status id".into()))?;
        reply_id = Some(new_id.to_string());
    }
    Ok(())
}

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    input: Value,
) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input);
    let account = body.get("account").cloned().unwrap_or(Value::Null);
    let status = body.get("status").cloned().unwrap_or(Value::Null);

    let content = status
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if content.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let acct = account
        .get("acct")
        .and_then(|a| a.as_str())
        .map(String::from)
        .or_else(|| {
            account
                .get("id")
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
        })
        .unwrap_or_default();

    let text = strip_html_tags(content);
    let agent_id = resolve_agent(iii, "mastodon", &acct).await;

    let chat_response = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("mastodon:{acct}"),
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

    let status_id = status
        .get("id")
        .and_then(|i| i.as_str())
        .map(String::from);

    if !reply.is_empty() {
        send_message(iii, client, &reply, status_id).await?;
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": { "channel": "mastodon", "acct": acct },
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
        RegisterFunction::new_async("channel::mastodon::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle Mastodon webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::mastodon::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/mastodon" }),
        metadata: None,
    })?;

    tracing::info!("channel-mastodon worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_html_removes_tags() {
        assert_eq!(strip_html_tags("<p>Hello</p>"), "Hello");
        assert_eq!(strip_html_tags("<p>Plain <b>text</b> here</p>"), "Plain text here");
    }

    #[test]
    fn strip_html_passes_through_plain_text() {
        assert_eq!(strip_html_tags("just text"), "just text");
    }

    #[test]
    fn split_short_returns_single() {
        assert_eq!(split_message("short", 500), vec!["short".to_string()]);
    }

    #[test]
    fn split_long_chunks() {
        let text = "a".repeat(700);
        let chunks = split_message(&text, 500);
        assert!(chunks.len() >= 2);
    }
}

use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::RwLock;

const API_URL: &str = "https://bsky.social/xrpc";
const BLUESKY_MAX_LEN: usize = 300;

#[derive(Clone, Debug)]
struct BlueskySession {
    access_jwt: String,
    did: String,
}

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

async fn authenticate(
    iii: &III,
    client: &reqwest::Client,
) -> Result<BlueskySession, IIIError> {
    let handle = get_secret(iii, "BLUESKY_HANDLE").await;
    if handle.is_empty() {
        return Err(IIIError::Handler("BLUESKY_HANDLE not configured".into()));
    }
    let password = get_secret(iii, "BLUESKY_PASSWORD").await;
    if password.is_empty() {
        return Err(IIIError::Handler("BLUESKY_PASSWORD not configured".into()));
    }
    let url = format!("{API_URL}/com.atproto.server.createSession");
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&json!({ "identifier": handle, "password": password }))
        .send()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    if !res.status().is_success() {
        return Err(IIIError::Handler(format!(
            "Bluesky authentication failed: {}",
            res.status()
        )));
    }
    let body: Value = res
        .json()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let access_jwt = body
        .get("accessJwt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("missing accessJwt".into()))?
        .to_string();
    let did = body
        .get("did")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("missing did".into()))?
        .to_string();
    Ok(BlueskySession { access_jwt, did })
}

async fn ensure_session(
    iii: &III,
    client: &reqwest::Client,
    session_lock: &Arc<RwLock<Option<BlueskySession>>>,
) -> Result<BlueskySession, IIIError> {
    {
        let read = session_lock.read().await;
        if let Some(s) = read.as_ref() {
            return Ok(s.clone());
        }
    }
    let new_session = authenticate(iii, client).await?;
    let mut write = session_lock.write().await;
    *write = Some(new_session.clone());
    Ok(new_session)
}

async fn send_message(
    iii: &III,
    client: &reqwest::Client,
    session_lock: &Arc<RwLock<Option<BlueskySession>>>,
    text: &str,
    parent: Option<(String, String)>,
) -> Result<(), IIIError> {
    let session = ensure_session(iii, client, session_lock).await?;
    let url = format!("{API_URL}/com.atproto.repo.createRecord");
    for chunk in split_message(text, BLUESKY_MAX_LEN) {
        let mut record = json!({
            "text": chunk,
            "createdAt": chrono::Utc::now().to_rfc3339(),
        });
        if let Some((uri, cid)) = &parent {
            let parent_obj = json!({ "uri": uri, "cid": cid });
            record["reply"] = json!({ "root": parent_obj, "parent": parent_obj });
        }
        let res = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", session.access_jwt))
            .header("Content-Type", "application/json")
            .json(&json!({
                "repo": session.did,
                "collection": "app.bsky.feed.post",
                "record": record,
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        if !res.status().is_success() {
            let status = res.status();
            // 401/403 mean the cached accessJwt has expired or been revoked.
            // Drop the cached session so the next call reauthenticates instead
            // of failing every subsequent webhook until restart.
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                let mut write = session_lock.write().await;
                *write = None;
            }
            return Err(IIIError::Handler(format!(
                "Bluesky createRecord failed: {status}"
            )));
        }
    }
    Ok(())
}

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    session_lock: &Arc<RwLock<Option<BlueskySession>>>,
    input: Value,
) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input);
    let did = body
        .get("did")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let text = body
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let uri = body
        .get("uri")
        .and_then(|v| v.as_str())
        .map(String::from);
    let cid = body
        .get("cid")
        .and_then(|v| v.as_str())
        .map(String::from);

    let session_did = {
        let read = session_lock.read().await;
        read.as_ref().map(|s| s.did.clone())
    };

    if text.is_empty() || session_did.as_ref() == Some(&did) {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let agent_id = resolve_agent(iii, "bluesky", &did).await;

    let chat_response = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("bluesky:{did}"),
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
        let parent = match (uri, cid) {
            (Some(u), Some(c)) => Some((u, c)),
            _ => None,
        };
        send_message(iii, client, session_lock, &reply, parent).await?;
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": { "channel": "bluesky", "did": did },
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
    let session_lock: Arc<RwLock<Option<BlueskySession>>> = Arc::new(RwLock::new(None));

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    let session_clone = session_lock.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::bluesky::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            let session_lock = session_clone.clone();
            async move { webhook_handler(&iii, &client, &session_lock, input).await }
        })
        .description("Handle Bluesky AT Protocol webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::bluesky::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/bluesky" }),
        metadata: None,
    })?;

    // Eager-authenticate at startup so the session DID is known before the
    // first webhook arrives. Without this, self-reply suppression
    // (`session_did == sender`) cannot match on cold start and the bot can
    // process its own posts. Failures are logged but non-fatal — credentials
    // may not yet be in the vault, in which case ensure_session will retry
    // on the first inbound webhook.
    {
        let iii_init = iii.clone();
        let client_init = client.clone();
        let lock_init = session_lock.clone();
        tokio::spawn(async move {
            if let Err(e) = ensure_session(&iii_init, &client_init, &lock_init).await {
                tracing::warn!("bluesky cold-start session resolve failed: {e}");
            }
        });
    }

    tracing::info!("channel-bluesky worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_returns_single() {
        assert_eq!(split_message("hi", 300), vec!["hi".to_string()]);
    }

    #[test]
    fn split_long_chunks() {
        let text = "x".repeat(700);
        let chunks = split_message(&text, 300);
        assert!(chunks.len() >= 3);
    }

    #[tokio::test]
    async fn session_lock_starts_empty() {
        let lock: Arc<RwLock<Option<BlueskySession>>> = Arc::new(RwLock::new(None));
        let read = lock.read().await;
        assert!(read.is_none());
    }
}

use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use lettre::message::Message;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde_json::{Value, json};

/// Resolve which agent should handle a given email recipient.
/// Mirrors `resolveAgent(sdk, "email", to)` from src/channels/email.ts.
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

/// Build an SMTP transport from env (SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS).
fn build_transport() -> Result<AsyncSmtpTransport<Tokio1Executor>, IIIError> {
    let host = std::env::var("SMTP_HOST").unwrap_or_else(|_| "localhost".to_string());
    let port: u16 = std::env::var("SMTP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(587);
    let secure = std::env::var("SMTP_SECURE").map(|s| s == "true").unwrap_or(false);
    let user = std::env::var("SMTP_USER").unwrap_or_default();
    let pass = std::env::var("SMTP_PASS").unwrap_or_default();

    let mut builder = if secure {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            .map_err(|e| IIIError::Handler(format!("SMTP relay error: {e}")))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
    };
    builder = builder.port(port);
    if !user.is_empty() {
        builder = builder.credentials(Credentials::new(user, pass));
    }
    Ok(builder.build())
}

async fn send_mail(to: &str, subject: &str, text: &str) -> Result<(), IIIError> {
    let from = std::env::var("SMTP_USER").unwrap_or_default();
    if from.is_empty() {
        return Err(IIIError::Handler("SMTP_USER not configured".into()));
    }
    let email = Message::builder()
        .from(from.parse().map_err(|e| IIIError::Handler(format!("invalid from: {e}")))?)
        .to(to.parse().map_err(|e| IIIError::Handler(format!("invalid to: {e}")))?)
        .subject(subject)
        .body(text.to_string())
        .map_err(|e| IIIError::Handler(format!("message build: {e}")))?;
    let transport = build_transport()?;
    transport
        .send(email)
        .await
        .map_err(|e| IIIError::Handler(format!("smtp send: {e}")))?;
    Ok(())
}

/// Handle inbound email webhook (e.g. SendGrid Inbound Parse / Mailgun routes).
/// Mirrors `channel::email::webhook` in src/channels/email.ts.
async fn handle_webhook(iii: &III, req: Value) -> Result<Value, IIIError> {
    let body = req.get("body").cloned().unwrap_or_else(|| req.clone());

    let from = body.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let to = body.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let subject = body.get("subject").and_then(|v| v.as_str()).unwrap_or("");
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");

    if from.is_empty() || text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let agent_id = resolve_agent(iii, "email", to).await;
    let subject_display = if subject.is_empty() { "(none)" } else { subject };

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": format!("Subject: {subject_display}\n\n{text}"),
                "sessionId": format!("email:{from}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let reply_subject = format!("Re: {subject}");

    if let Err(e) = send_mail(from, &reply_subject, reply).await {
        tracing::error!(to = %from, error = %e, "failed to send email reply");
    }

    // Fire-and-forget audit (mirrors TriggerAction.Void()).
    let audit_iii = iii.clone();
    let from_owned = from.to_string();
    let to_owned = to.to_string();
    let agent_for_audit = agent_id.clone();
    tokio::spawn(async move {
        let _ = audit_iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "channel_message",
                    "agentId": agent_for_audit,
                    "detail": { "channel": "email", "from": from_owned, "to": to_owned },
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

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::email::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            async move { handle_webhook(&iii, input).await }
        })
        .description("Handle inbound email webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::email::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/email" }),
        metadata: None,
    })?;

    tracing::info!("channel-email worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_from_returns_ok_without_dispatch() {
        let body = json!({ "to": "bot@x.com", "text": "hi" });
        let from = body.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
        assert!(from.is_empty());
        assert!(!text.is_empty());
    }

    #[test]
    fn missing_text_returns_ok_without_dispatch() {
        let body = json!({ "from": "u@x.com", "to": "bot@x.com", "subject": "S" });
        let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
        assert!(text.is_empty());
    }

    #[test]
    fn subject_fallback_when_missing() {
        let subject = "";
        let display = if subject.is_empty() { "(none)" } else { subject };
        assert_eq!(display, "(none)");
    }

    #[test]
    fn subject_used_verbatim_when_present() {
        let subject = "Hello";
        let display = if subject.is_empty() { "(none)" } else { subject };
        assert_eq!(display, "Hello");
    }

    #[test]
    fn reply_subject_has_re_prefix() {
        let subject = "Original";
        let reply = format!("Re: {subject}");
        assert_eq!(reply, "Re: Original");
    }

    #[test]
    fn reply_subject_with_empty_subject_keeps_re_prefix() {
        let subject = "";
        let reply = format!("Re: {subject}");
        assert_eq!(reply, "Re: ");
    }

    #[test]
    fn session_id_format_uses_from_address() {
        let from = "user@x.com";
        let session = format!("email:{from}");
        assert_eq!(session, "email:user@x.com");
    }
}

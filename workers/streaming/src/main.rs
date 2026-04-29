use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

mod types;

use types::chunk_markdown_aware;

fn payload_body(input: &Value) -> Value {
    if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    }
}

async fn stream_chat(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let agent_id = body["agentId"].as_str().unwrap_or("default").to_string();
    let message = body["message"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("message required".into()))?
        .to_string();

    let config = iii
        .trigger(TriggerRequest {
            function_id: "state::get".into(),
            payload: json!({ "scope": "agents", "key": &agent_id }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();

    let memories = iii
        .trigger(TriggerRequest {
            function_id: "memory::recall".into(),
            payload: json!({ "agentId": &agent_id, "query": &message, "limit": 10 }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or_else(|_| json!([]));

    let model_config = config
        .as_ref()
        .and_then(|c| c.get("model").cloned())
        .unwrap_or(Value::Null);

    let model = iii
        .trigger(TriggerRequest {
            function_id: "llm::route".into(),
            payload: json!({ "message": &message, "toolCount": 0, "config": model_config }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let system_prompt = config
        .as_ref()
        .and_then(|c| c["systemPrompt"].as_str())
        .unwrap_or("")
        .to_string();

    let mut messages: Vec<Value> = memories.as_array().cloned().unwrap_or_default();
    messages.push(json!({ "role": "user", "content": &message }));

    let response = iii
        .trigger(TriggerRequest {
            function_id: "llm::complete".into(),
            payload: json!({
                "model": model,
                "systemPrompt": system_prompt,
                "messages": messages,
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({
        "status_code": 200,
        "body": {
            "content": response["content"],
            "model": response["model"],
            "usage": response["usage"],
        }
    }))
}

async fn stream_sse(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = payload_body(&input);
    let agent_id = body["agentId"].as_str().unwrap_or("default").to_string();
    let message = body["message"]
        .as_str()
        .ok_or_else(|| IIIError::Handler("message required".into()))?
        .to_string();
    let session_id = body.get("sessionId").cloned().unwrap_or(Value::Null);

    let response = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".into(),
            payload: json!({
                "agentId": &agent_id,
                "message": &message,
                "sessionId": session_id,
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let content = response["content"].as_str().unwrap_or("").to_string();
    let model = response["model"]
        .as_str()
        .unwrap_or("claude-sonnet-4-6")
        .to_string();

    let chunks = chunk_markdown_aware(&content, 20, 100);
    let chunks_len = chunks.len();
    let created = chrono::Utc::now().timestamp();

    let mut sse_body = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let id = format!("chatcmpl-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let finish_reason = if i == chunks_len - 1 {
            json!("stop")
        } else {
            Value::Null
        };
        let delta = if i == 0 {
            json!({ "role": "assistant", "content": chunk })
        } else {
            json!({ "content": chunk })
        };
        let event = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }]
        });
        sse_body.push_str(&format!(
            "data: {}\n\n",
            serde_json::to_string(&event).map_err(|e| IIIError::Handler(e.to_string()))?
        ));
    }
    sse_body.push_str("data: [DONE]\n\n");

    Ok(json!({
        "status_code": 200,
        "headers": {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
        "body": sse_body,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("stream::chat", move |input: Value| {
            let iii = iii_ref.clone();
            async move { stream_chat(&iii, input).await }
        })
        .description("SSE streaming chat endpoint"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("stream::sse", move |input: Value| {
            let iii = iii_ref.clone();
            async move { stream_sse(&iii, input).await }
        })
        .description("SSE event stream for chat completions"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "stream::chat".into(),
        config: json!({ "http_method": "POST", "api_path": "api/chat/stream" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "stream::sse".into(),
        config: json!({ "http_method": "POST", "api_path": "v1/chat/completions/stream" }),
        metadata: None,
    })?;

    tracing::info!("streaming worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::net::IpAddr;
use std::time::Duration;

mod types;

use types::{
    A2aMessage, A2aTask, AgentCard, AgentCardAuth, AgentCardCapabilities, AgentSkill, Part, Role,
    TaskState, TaskStatus, now_iso, now_ms,
};

const MAX_TASKS: usize = 1000;
const VERSION: &str = "0.0.1";

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Result<Option<Value>, IIIError> {
    let v = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": scope, "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(if v.is_null() { None } else { Some(v) })
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map(|_| ())
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_delete(iii: &III, scope: &str, key: &str) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::delete".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map(|_| ())
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn get_task_order(iii: &III) -> Result<Vec<String>, IIIError> {
    Ok(state_get(iii, "a2a_tasks", "_order")
        .await?
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// Atomically append a task id to the `_order` index using `state::update`.
/// Falls back to read-modify-write if the engine rejects the operation.
async fn append_task_to_order(iii: &III, task_id: &str) -> Result<(), IIIError> {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "state::update".to_string(),
            payload: json!({
                "scope": "a2a_tasks",
                "key": "_order",
                "operations": [
                    { "type": "append", "path": "", "value": task_id },
                ],
            }),
            action: None,
            timeout_ms: None,
        })
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(_) => {
            let mut order = get_task_order(iii).await?;
            order.push(task_id.to_string());
            state_set(iii, "a2a_tasks", "_order", json!(order)).await
        }
    }
}

async fn evict_old_tasks(iii: &III) -> Result<(), IIIError> {
    let mut order = get_task_order(iii).await?;
    while order.len() >= MAX_TASKS {
        let oldest = order.remove(0);
        state_set(iii, "a2a_tasks", &oldest, Value::Null).await?;
    }
    state_set(iii, "a2a_tasks", "_order", json!(order)).await
}

fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || o[0] >= 224
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (seg[0] & 0xffc0) == 0xfe80
                || (seg[0] & 0xfe00) == 0xfc00
                || seg[0] == 0xff00
                || (seg[0] == 0x2001 && seg[1] == 0xdb8)
                || v6.to_ipv4_mapped()
                    .map(|v4| is_blocked_ip(&IpAddr::V4(v4)))
                    .unwrap_or(false)
        }
    }
}

fn ssrf_check(url: &str) -> Result<(), IIIError> {
    let parsed = url::Url::parse(url).map_err(|e| IIIError::Handler(format!("invalid url: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(IIIError::Handler(format!(
            "blocked URL scheme: {}",
            parsed.scheme()
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| IIIError::Handler("blocked: missing host".into()))?;
    let lower = host.to_lowercase();

    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower == "metadata.google.internal"
        || lower == "metadata"
    {
        return Err(IIIError::Handler("blocked host".into()));
    }

    if let Ok(ip) = host.parse::<IpAddr>()
        && is_blocked_ip(&ip)
    {
        return Err(IIIError::Handler("blocked private IP".into()));
    }
    Ok(())
}

async fn rpc_call(
    url: &str,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, IIIError> {
    ssrf_check(url)?;
    let rpc_id = uuid::Uuid::new_v4().to_string();
    let payload = json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": method,
        "params": params,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("rpc fetch failed: {e}")))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("rpc decode failed: {e}")))?;

    if let Some(err) = body.get("error") {
        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(IIIError::Handler(format!("A2A error {code}: {msg}")));
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

async fn agent_card(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let base_url = body
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("baseUrl is required".into()))?
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| "agentos".into());
    let description = body
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| "AI agent operating system with multi-agent orchestration".into());

    let agent_skills: Vec<AgentSkill> = if let Some(arr) = body.get("skills").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| serde_json::from_value::<AgentSkill>(v.clone()).ok())
            .collect()
    } else {
        let listed = iii
            .trigger(TriggerRequest {
                function_id: "skill::list".to_string(),
                payload: json!({}),
                action: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        listed
            .into_iter()
            .take(20)
            .filter_map(|s| {
                let id = s.get("id")?.as_str()?.to_string();
                let name = s.get("name")?.as_str()?.to_string();
                let description = s
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tags: Vec<String> = s
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                Some(AgentSkill {
                    id,
                    name,
                    description,
                    tags,
                    examples: vec![],
                })
            })
            .collect()
    };

    let card = AgentCard {
        name,
        description,
        url: base_url,
        version: VERSION.to_string(),
        capabilities: AgentCardCapabilities {
            streaming: false,
            push_notifications: false,
            state_transition_history: true,
        },
        skills: agent_skills,
        authentication: AgentCardAuth {
            schemes: vec!["bearer".into()],
        },
        default_input_modes: vec!["text/plain".into()],
        default_output_modes: vec!["text/plain".into()],
    };

    let value = serde_json::to_value(&card).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "a2a", "agent_card", value.clone()).await?;
    Ok::<Value, IIIError>(value)
}

async fn send_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let agent_url = body
        .get("agentUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("agentUrl is required".into()))?
        .to_string();
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("message is required".into()))?
        .to_string();
    let session_id = body
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let metadata = body
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| json!({}));

    ssrf_check(&agent_url)?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let rpc_payload = json!({
        "jsonrpc": "2.0",
        "id": task_id,
        "method": "tasks/send",
        "params": {
            "id": task_id,
            "sessionId": session_id,
            "message": { "role": "user", "parts": [{ "type": "text", "text": message }] },
            "metadata": metadata,
        }
    });

    let client = http_client();
    let resp = client
        .post(&agent_url)
        .header("Content-Type", "application/json")
        .json(&rpc_payload)
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("a2a fetch failed: {e}")))?;
    let result: Value = resp
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("a2a decode failed: {e}")))?;

    if let Some(err) = result.get("error") {
        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(IIIError::Handler(format!("A2A error {code}: {msg}")));
    }

    let result_obj = result.get("result").cloned().unwrap_or_else(|| json!({}));
    let task = A2aTask {
        id: task_id.clone(),
        session_id: result_obj
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or(session_id),
        status: result_obj
            .get("status")
            .and_then(|v| serde_json::from_value::<TaskStatus>(v.clone()).ok())
            .unwrap_or(TaskStatus {
                state: TaskState::Submitted,
                message: None,
                timestamp: now_iso(),
            }),
        history: result_obj
            .get("history")
            .and_then(|v| serde_json::from_value::<Vec<A2aMessage>>(v.clone()).ok())
            .unwrap_or_default(),
        artifacts: result_obj
            .get("artifacts")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default(),
        metadata,
        created_at: now_ms(),
    };

    evict_old_tasks(iii).await?;
    let task_value = serde_json::to_value(&task).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "a2a_tasks", &task_id, task_value.clone()).await?;
    if let Err(e) = append_task_to_order(iii, &task_id).await {
        let _ = state_delete(iii, "a2a_tasks", &task_id).await;
        return Err(e);
    }

    Ok::<Value, IIIError>(task_value)
}

async fn get_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let task_id = input
        .get("taskId")
        .and_then(|v| v.as_str())
        .or_else(|| input.get("query").and_then(|q| q.get("taskId")).and_then(|v| v.as_str()))
        .ok_or_else(|| IIIError::Handler("taskId is required".into()))?
        .to_string();
    let agent_url = input
        .get("agentUrl")
        .and_then(|v| v.as_str())
        .or_else(|| {
            input
                .get("query")
                .and_then(|q| q.get("agentUrl"))
                .and_then(|v| v.as_str())
        })
        .map(String::from);

    if let Some(url) = agent_url {
        return rpc_call(&url, "tasks/get", json!({ "id": task_id }), 30_000).await;
    }

    state_get(iii, "a2a_tasks", &task_id)
        .await?
        .ok_or_else(|| IIIError::Handler(format!("Task not found: {task_id}")))
}

async fn cancel_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let task_id = body
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("taskId is required".into()))?
        .to_string();
    let agent_url = body
        .get("agentUrl")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(url) = agent_url {
        return rpc_call(&url, "tasks/cancel", json!({ "id": task_id }), 30_000).await;
    }

    let task_val = state_get(iii, "a2a_tasks", &task_id)
        .await?
        .ok_or_else(|| IIIError::Handler(format!("Task not found: {task_id}")))?;
    let mut task: A2aTask =
        serde_json::from_value(task_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if matches!(task.status.state, TaskState::Completed | TaskState::Failed) {
        return Err(IIIError::Handler(format!(
            "Cannot cancel task in state: {:?}",
            task.status.state
        )));
    }

    task.status = TaskStatus {
        state: TaskState::Cancelled,
        message: None,
        timestamp: now_iso(),
    };
    let value = serde_json::to_value(&task).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "a2a_tasks", &task_id, value.clone()).await?;
    Ok::<Value, IIIError>(value)
}

async fn handle_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let jsonrpc = body.get("jsonrpc").and_then(|v| v.as_str()).unwrap_or("");
    let rpc_id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));

    if jsonrpc != "2.0" {
        return Ok::<Value, IIIError>(json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": { "code": -32600, "message": "Invalid JSON-RPC" }
        }));
    }

    match method {
        "tasks/send" => {
            let task_id = params
                .get("id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let message_val = params.get("message").cloned().unwrap_or_else(|| json!({}));
            let message: A2aMessage = serde_json::from_value(message_val.clone())
                .map_err(|e| IIIError::Handler(format!("invalid message: {e}")))?;
            let metadata = params
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| json!({}));

            let mut task = A2aTask {
                id: task_id.clone(),
                session_id: session_id.clone(),
                status: TaskStatus {
                    state: TaskState::Working,
                    message: None,
                    timestamp: now_iso(),
                },
                history: vec![message.clone()],
                artifacts: vec![],
                metadata,
                created_at: now_ms(),
            };

            evict_old_tasks(iii).await?;
            let task_value =
                serde_json::to_value(&task).map_err(|e| IIIError::Handler(e.to_string()))?;
            state_set(iii, "a2a_tasks", &task_id, task_value).await?;
            if let Err(e) = append_task_to_order(iii, &task_id).await {
                let _ = state_delete(iii, "a2a_tasks", &task_id).await;
                return Err(e);
            }

            let user_text = message
                .parts
                .iter()
                .filter_map(|p| match p {
                    Part::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");

            let chat_result = iii
                .trigger(TriggerRequest {
                    function_id: "agent::chat".to_string(),
                    payload: json!({
                        "agentId": "default",
                        "message": user_text,
                        "sessionId": session_id,
                    }),
                    action: None,
                    timeout_ms: None,
                })
                .await;

            match chat_result {
                Ok(response) => {
                    let content = response
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let agent_message = A2aMessage {
                        role: Role::Agent,
                        parts: vec![Part::Text { text: content }],
                    };
                    task.history.push(agent_message.clone());
                    task.status = TaskStatus {
                        state: TaskState::Completed,
                        message: Some(agent_message),
                        timestamp: now_iso(),
                    };
                    let value = serde_json::to_value(&task)
                        .map_err(|e| IIIError::Handler(e.to_string()))?;
                    state_set(iii, "a2a_tasks", &task_id, value.clone()).await?;
                    Ok::<Value, IIIError>(json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": value,
                    }))
                }
                Err(e) => {
                    let agent_message = A2aMessage {
                        role: Role::Agent,
                        parts: vec![Part::Text { text: e.to_string() }],
                    };
                    task.status = TaskStatus {
                        state: TaskState::Failed,
                        message: Some(agent_message),
                        timestamp: now_iso(),
                    };
                    let value = serde_json::to_value(&task)
                        .map_err(|e| IIIError::Handler(e.to_string()))?;
                    state_set(iii, "a2a_tasks", &task_id, value.clone()).await?;
                    Ok::<Value, IIIError>(json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": value,
                    }))
                }
            }
        }
        "tasks/get" => {
            let task_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match state_get(iii, "a2a_tasks", &task_id).await? {
                Some(task) => Ok::<Value, IIIError>(json!({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": task,
                })),
                None => Ok::<Value, IIIError>(json!({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": { "code": -32001, "message": "Task not found" },
                })),
            }
        }
        "tasks/cancel" => {
            let task_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match state_get(iii, "a2a_tasks", &task_id).await? {
                Some(task_val) => {
                    let mut task: A2aTask = serde_json::from_value(task_val)
                        .map_err(|e| IIIError::Handler(e.to_string()))?;
                    if matches!(task.status.state, TaskState::Completed | TaskState::Failed) {
                        return Ok::<Value, IIIError>(json!({
                            "jsonrpc": "2.0",
                            "id": rpc_id,
                            "error": {
                                "code": -32002,
                                "message": format!(
                                    "Cannot cancel task in state: {:?}",
                                    task.status.state
                                ),
                            },
                        }));
                    }
                    task.status = TaskStatus {
                        state: TaskState::Cancelled,
                        message: None,
                        timestamp: now_iso(),
                    };
                    let value = serde_json::to_value(&task)
                        .map_err(|e| IIIError::Handler(e.to_string()))?;
                    state_set(iii, "a2a_tasks", &task_id, value.clone()).await?;
                    Ok::<Value, IIIError>(json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": value,
                    }))
                }
                None => Ok::<Value, IIIError>(json!({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": { "code": -32001, "message": "Task not found" },
                })),
            }
        }
        _ => Ok::<Value, IIIError>(json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": { "code": -32601, "message": "Method not found" },
        })),
    }
}

async fn discover(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input.clone());
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("url is required".into()))?
        .to_string();
    ssrf_check(&url)?;
    let trimmed = url.trim_end_matches('/');
    let card_url = format!("{trimmed}/.well-known/agent.json");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let resp = client
        .get(&card_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("discover fetch failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(IIIError::Handler(format!(
            "Failed to fetch AgentCard: {}",
            resp.status().as_u16()
        )));
    }

    let card: Value = resp
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("decode failed: {e}")))?;

    let hostname = url::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_else(|| "unknown".to_string());

    state_set(
        iii,
        "a2a",
        &format!("discovered:{hostname}"),
        json!({
            "card": card,
            "discoveredAt": now_ms(),
            "url": url,
        }),
    )
    .await?;

    Ok::<Value, IIIError>(json!({
        "discovered": true,
        "card": card,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_ENGINE_URL")
        .or_else(|_| std::env::var("III_WS_URL"))
        .unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::agent_card", move |input: Value| {
            let iii = iii_clone.clone();
            async move { agent_card(&iii, input).await }
        })
        .description("Build and serve the A2A AgentCard"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::send_task", move |input: Value| {
            let iii = iii_clone.clone();
            async move { send_task(&iii, input).await }
        })
        .description("Send task to an external A2A agent"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::get_task", move |input: Value| {
            let iii = iii_clone.clone();
            async move { get_task(&iii, input).await }
        })
        .description("Get task status"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::cancel_task", move |input: Value| {
            let iii = iii_clone.clone();
            async move { cancel_task(&iii, input).await }
        })
        .description("Cancel a task"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::handle_task", move |input: Value| {
            let iii = iii_clone.clone();
            async move { handle_task(&iii, input).await }
        })
        .description("Handle incoming A2A task request and route to local agent"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::discover", move |input: Value| {
            let iii = iii_clone.clone();
            async move { discover(&iii, input).await }
        })
        .description("Discover an external agent by fetching its AgentCard"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::agent_card".to_string(),
        config: json!({ "api_path": ".well-known/agent.json", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::handle_task".to_string(),
        config: json!({ "api_path": "a2a/rpc", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::send_task".to_string(),
        config: json!({ "api_path": "api/a2a/send", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::get_task".to_string(),
        config: json!({ "api_path": "api/a2a/task", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::cancel_task".to_string(),
        config: json!({ "api_path": "api/a2a/cancel", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::discover".to_string(),
        config: json!({ "api_path": "api/a2a/discover", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("a2a worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

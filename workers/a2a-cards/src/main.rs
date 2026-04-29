use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

mod types;

use types::{A2aAgentCard, A2aAuthentication, A2aCapabilities, AgentSkillRef, GenerateCardRequest};

fn api_url() -> String {
    std::env::var("AGENTOS_API_URL").unwrap_or_else(|_| "http://localhost:3111".to_string())
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .filter(|v| !v.is_null())
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

async fn state_list(iii: &III, scope: &str) -> Vec<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

async fn list_agent_tools(iii: &III, agent_id: &str) -> Vec<String> {
    let res = iii
        .trigger(TriggerRequest {
            function_id: "agent::list_tools".to_string(),
            payload: json!({ "agentId": agent_id }),
            action: None,
            timeout_ms: None,
        })
        .await;

    res.ok()
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    t.get("function_id")
                        .or_else(|| t.get("id"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn list_skill_entries(iii: &III) -> Vec<AgentSkillRef> {
    let skills = state_list(iii, "skills").await;
    skills
        .into_iter()
        .filter_map(|entry| {
            let s = entry.get("value").cloned().unwrap_or(entry);
            if s.is_null() {
                return None;
            }
            let id = s.get("id")?.as_str()?.to_string();
            let name = s
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let description = s
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentSkillRef { id, name, description })
        })
        .take(20)
        .collect()
}

async fn generate_card(iii: &III, req: GenerateCardRequest) -> Result<Value, IIIError> {
    let config = state_get(iii, "agents", &req.agent_id)
        .await
        .ok_or_else(|| IIIError::Handler(format!("Agent not found: {}", req.agent_id)))?;

    let tool_ids = list_agent_tools(iii, &req.agent_id).await;
    let skills = list_skill_entries(iii).await;

    let name = config
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&req.agent_id)
        .to_string();
    let description = config
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("Agent {}", req.agent_id));

    let card = A2aAgentCard {
        name,
        description,
        url: format!("{}/api/a2a/agents/{}", api_url(), req.agent_id),
        capabilities: A2aCapabilities {
            tools: tool_ids.into_iter().take(50).collect(),
            streaming: true,
            push_notifications: false,
        },
        skills,
        authentication: A2aAuthentication {
            schemes: vec!["bearer".into()],
        },
        default_input_modes: vec!["text".into()],
        default_output_modes: vec!["text".into()],
    };

    let value = serde_json::to_value(&card).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "a2a_cards", &req.agent_id, value.clone()).await?;

    Ok::<Value, IIIError>(value)
}

async fn list_cards(iii: &III) -> Result<Value, IIIError> {
    let agents = state_list(iii, "agents").await;
    let mut cards: Vec<Value> = Vec::new();

    for entry in agents {
        let agent = entry.get("value").cloned().unwrap_or(entry);
        let agent_id = match agent.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        if let Ok(card) = generate_card(iii, GenerateCardRequest { agent_id }).await {
            cards.push(card);
        }
    }

    Ok::<Value, IIIError>(Value::Array(cards))
}

async fn well_known(iii: &III) -> Result<Value, IIIError> {
    if let Some(cached) = state_get(iii, "a2a_cards", "orchestrator").await {
        return Ok::<Value, IIIError>(cached);
    }

    let card = A2aAgentCard {
        name: "agentos".into(),
        description: "AI agent operating system with multi-agent orchestration".into(),
        url: format!("{}/api/a2a/agents/orchestrator", api_url()),
        capabilities: A2aCapabilities {
            tools: vec![],
            streaming: true,
            push_notifications: false,
        },
        skills: vec![],
        authentication: A2aAuthentication {
            schemes: vec!["bearer".into()],
        },
        default_input_modes: vec!["text".into()],
        default_output_modes: vec!["text".into()],
    };

    Ok::<Value, IIIError>(serde_json::to_value(&card).unwrap())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::generate_card", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: GenerateCardRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                generate_card(&iii, req).await
            }
        })
        .description("Generate an A2A agent card for a specific agent"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::list_cards", move |_: Value| {
            let iii = iii_clone.clone();
            async move { list_cards(&iii).await }
        })
        .description("List all A2A agent cards"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("a2a::well_known", move |_: Value| {
            let iii = iii_clone.clone();
            async move { well_known(&iii).await }
        })
        .description("Serve the .well-known/agent.json discovery document"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::list_cards".to_string(),
        config: json!({ "api_path": "api/a2a/cards", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::generate_card".to_string(),
        config: json!({ "api_path": "api/a2a/cards/:agentId", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "a2a::well_known".to_string(),
        config: json!({ "api_path": ".well-known/agent.json", "http_method": "GET" }),
        metadata: None,
    })?;

    tracing::info!("a2a-cards worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

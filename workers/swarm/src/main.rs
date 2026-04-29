use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

mod types;

use types::{
    BroadcastRequest, CollectRequest, ConsensusRequest, CreateSwarmRequest, DissolveRequest,
    MessageType, SwarmConfig, SwarmMessage, SwarmStatus, sanitize_id,
};

const DEFAULT_MAX_DURATION_MS: u64 = 600_000;
const DEFAULT_CONSENSUS_THRESHOLD: f64 = 0.66;
const MAX_AGENTS_PER_SWARM: usize = 20;
const MAX_MESSAGES_PER_SWARM: usize = 500;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn fire_and_forget(iii: &III, function_id: &str, payload: Value) {
    let iii = iii.clone();
    let function_id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii
            .trigger(TriggerRequest {
                function_id,
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
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

fn message_value(entry: &Value) -> Value {
    entry.get("value").cloned().unwrap_or_else(|| entry.clone())
}

async fn create_swarm(iii: &III, req: CreateSwarmRequest) -> Result<Value, IIIError> {
    let goal = req
        .goal
        .filter(|g| !g.is_empty())
        .ok_or_else(|| IIIError::Handler("goal and agentIds are required".into()))?;
    let agent_ids = req
        .agent_ids
        .filter(|ids| !ids.is_empty())
        .ok_or_else(|| IIIError::Handler("goal and agentIds are required".into()))?;

    if agent_ids.len() > MAX_AGENTS_PER_SWARM {
        return Err(IIIError::Handler(format!(
            "Maximum {MAX_AGENTS_PER_SWARM} agents per swarm"
        )));
    }

    let swarm_id = uuid::Uuid::new_v4().to_string();
    let swarm = SwarmConfig {
        id: swarm_id.clone(),
        goal: goal.clone(),
        agent_ids: agent_ids.clone(),
        max_duration_ms: req.max_duration_ms.unwrap_or(DEFAULT_MAX_DURATION_MS),
        consensus_threshold: req
            .consensus_threshold
            .unwrap_or(DEFAULT_CONSENSUS_THRESHOLD),
        created_at: now_ms(),
        status: SwarmStatus::Active,
        dissolved_at: None,
    };

    let value = serde_json::to_value(&swarm).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "swarms", &swarm_id, value).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("swarm:{swarm_id}"),
            "data": {
                "type": "swarm_created",
                "swarmId": swarm_id,
                "goal": goal,
                "agents": agent_ids,
            }
        }),
    );

    fire_and_forget(
        iii,
        "security::audit",
        json!({
            "type": "swarm_created",
            "detail": { "swarmId": swarm_id, "goal": goal, "agentCount": agent_ids.len() },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "swarmId": swarm_id,
        "agents": agent_ids,
        "createdAt": swarm.created_at,
    }))
}

async fn broadcast(iii: &III, req: BroadcastRequest) -> Result<Value, IIIError> {
    let safe_swarm_id = sanitize_id(&req.swarm_id).map_err(IIIError::Handler)?;
    let safe_agent_id = sanitize_id(&req.agent_id).map_err(IIIError::Handler)?;

    let swarm_val = state_get(iii, "swarms", &safe_swarm_id)
        .await
        .ok_or_else(|| IIIError::Handler(format!("Swarm {safe_swarm_id} not found or not active")))?;
    let swarm: SwarmConfig =
        serde_json::from_value(swarm_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if swarm.status != SwarmStatus::Active {
        return Err(IIIError::Handler(format!(
            "Swarm {safe_swarm_id} not found or not active"
        )));
    }

    if !swarm.agent_ids.iter().any(|id| id == &safe_agent_id) {
        return Err(IIIError::Handler(format!(
            "Agent {safe_agent_id} is not a member of swarm {safe_swarm_id}"
        )));
    }

    let scope = format!("swarm_messages:{safe_swarm_id}");
    let existing = state_list(iii, &scope).await;
    if existing.len() >= MAX_MESSAGES_PER_SWARM {
        return Err(IIIError::Handler(format!(
            "Swarm {safe_swarm_id} has reached the message limit"
        )));
    }

    let msg_id = uuid::Uuid::new_v4().to_string();
    let swarm_message = SwarmMessage {
        id: msg_id.clone(),
        swarm_id: safe_swarm_id.clone(),
        agent_id: safe_agent_id,
        message: req.message,
        kind: req.kind,
        vote: if req.kind == MessageType::Vote {
            req.vote
        } else {
            None
        },
        timestamp: now_ms(),
    };

    let value =
        serde_json::to_value(&swarm_message).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, &scope, &msg_id, value.clone()).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("swarm:{safe_swarm_id}"),
            "data": value,
        }),
    );

    Ok::<Value, IIIError>(json!({
        "messageId": msg_id,
        "swarmId": safe_swarm_id,
    }))
}

async fn collect(iii: &III, req: CollectRequest) -> Result<Value, IIIError> {
    let safe_swarm_id = sanitize_id(&req.swarm_id).map_err(IIIError::Handler)?;
    let scope = format!("swarm_messages:{safe_swarm_id}");
    let raw = state_list(iii, &scope).await;

    let mut items: Vec<SwarmMessage> = raw
        .iter()
        .filter_map(|v| serde_json::from_value::<SwarmMessage>(message_value(v)).ok())
        .collect();
    items.sort_by_key(|m| m.timestamp);

    let mut by_agent: std::collections::BTreeMap<String, Vec<&SwarmMessage>> =
        std::collections::BTreeMap::new();
    for msg in &items {
        by_agent
            .entry(msg.agent_id.clone())
            .or_default()
            .push(msg);
    }

    let observations: Vec<&SwarmMessage> =
        items.iter().filter(|m| m.kind == MessageType::Observation).collect();
    let proposals: Vec<&SwarmMessage> =
        items.iter().filter(|m| m.kind == MessageType::Proposal).collect();
    let votes: Vec<&SwarmMessage> =
        items.iter().filter(|m| m.kind == MessageType::Vote).collect();

    Ok::<Value, IIIError>(json!({
        "swarmId": safe_swarm_id,
        "totalMessages": items.len(),
        "agents": by_agent,
        "observations": observations,
        "proposals": proposals,
        "votes": votes,
    }))
}

async fn consensus(iii: &III, req: ConsensusRequest) -> Result<Value, IIIError> {
    let safe_swarm_id = sanitize_id(&req.swarm_id).map_err(IIIError::Handler)?;

    let swarm_val = state_get(iii, "swarms", &safe_swarm_id)
        .await
        .ok_or_else(|| IIIError::Handler(format!("Swarm {safe_swarm_id} not found")))?;
    let swarm: SwarmConfig =
        serde_json::from_value(swarm_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    let scope = format!("swarm_messages:{safe_swarm_id}");
    let raw = state_list(iii, &scope).await;

    let needle = &req.proposal[..req.proposal.len().min(50)];

    let votes: Vec<SwarmMessage> = raw
        .iter()
        .filter_map(|v| serde_json::from_value::<SwarmMessage>(message_value(v)).ok())
        .filter(|m| m.kind == MessageType::Vote && m.message.contains(needle))
        .collect();

    let mut latest: std::collections::HashMap<String, SwarmMessage> =
        std::collections::HashMap::new();
    for v in votes {
        let entry = latest.get(&v.agent_id);
        if entry.map_or(true, |e| v.timestamp > e.timestamp) {
            latest.insert(v.agent_id.clone(), v);
        }
    }

    let mut votes_for = 0u32;
    let mut votes_against = 0u32;
    for v in latest.values() {
        match v.vote {
            Some(types::VoteValue::For) => votes_for += 1,
            Some(types::VoteValue::Against) => votes_against += 1,
            None => {}
        }
    }

    let total_voters = swarm.agent_ids.len();
    let ratio = if total_voters == 0 {
        0.0
    } else {
        votes_for as f64 / total_voters as f64
    };
    let has_consensus = ratio >= swarm.consensus_threshold;

    Ok::<Value, IIIError>(json!({
        "hasConsensus": has_consensus,
        "votesFor": votes_for,
        "votesAgainst": votes_against,
        "threshold": swarm.consensus_threshold,
        "agents": swarm.agent_ids,
        "totalVoters": total_voters,
    }))
}

async fn dissolve(iii: &III, req: DissolveRequest) -> Result<Value, IIIError> {
    let safe_swarm_id = sanitize_id(&req.swarm_id).map_err(IIIError::Handler)?;

    let swarm_val = state_get(iii, "swarms", &safe_swarm_id)
        .await
        .ok_or_else(|| IIIError::Handler(format!("Swarm {safe_swarm_id} not found")))?;
    let mut swarm: SwarmConfig =
        serde_json::from_value(swarm_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    let findings = collect(iii, CollectRequest { swarm_id: safe_swarm_id.clone() }).await?;
    let total_messages = findings
        .get("totalMessages")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if let Some(agents_obj) = findings.get("agents").and_then(|v| v.as_object()) {
        for agent_id in &swarm.agent_ids {
            if let Some(agent_findings) = agents_obj.get(agent_id).and_then(|v| v.as_array()) {
                if !agent_findings.is_empty() {
                    let preview: Vec<&Value> = agent_findings.iter().take(10).collect();
                    let summary = serde_json::to_string(&preview).unwrap_or_else(|_| "[]".into());
                    fire_and_forget(
                        iii,
                        "memory::store",
                        json!({
                            "agentId": agent_id,
                            "sessionId": format!("swarm:{safe_swarm_id}"),
                            "role": "system",
                            "content": format!("Swarm {safe_swarm_id} findings: {summary}"),
                        }),
                    );
                }
            }
        }
    }

    swarm.status = SwarmStatus::Dissolved;
    swarm.dissolved_at = Some(now_ms());
    let value = serde_json::to_value(&swarm).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "swarms", &safe_swarm_id, value).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("swarm:{safe_swarm_id}"),
            "data": { "type": "swarm_dissolved", "swarmId": safe_swarm_id },
        }),
    );

    fire_and_forget(
        iii,
        "security::audit",
        json!({
            "type": "swarm_dissolved",
            "detail": { "swarmId": safe_swarm_id, "messageCount": total_messages },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "dissolved": true,
        "swarmId": safe_swarm_id,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("swarm::create", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: CreateSwarmRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                create_swarm(&iii, req).await
            }
        })
        .description("Create a new decentralized agent swarm"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("swarm::broadcast", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: BroadcastRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                broadcast(&iii, req).await
            }
        })
        .description("Broadcast a message to all agents in a swarm"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("swarm::collect", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CollectRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                collect(&iii, req).await
            }
        })
        .description("Gather all findings from a swarm"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("swarm::consensus", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ConsensusRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                consensus(&iii, req).await
            }
        })
        .description("Check if a swarm has reached consensus on a proposal"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("swarm::dissolve", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: DissolveRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                dissolve(&iii, req).await
            }
        })
        .description("Dissolve a swarm and archive its findings"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "swarm::create".to_string(),
        config: json!({ "api_path": "api/swarm/create", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "swarm::broadcast".to_string(),
        config: json!({ "api_path": "api/swarm/:id/broadcast", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "swarm::collect".to_string(),
        config: json!({ "api_path": "api/swarm/:id/status", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "swarm::consensus".to_string(),
        config: json!({ "api_path": "api/swarm/:id/consensus", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "swarm::dissolve".to_string(),
        config: json!({ "api_path": "api/swarm/:id/dissolve", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("swarm worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

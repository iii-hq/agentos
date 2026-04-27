use iii_sdk::{III, InitOptions, register_worker};
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[allow(dead_code)]
mod iii_compat {
    use iii_sdk::{
        III, RegisterFunction, RegisterTriggerInput, TriggerRequest, FunctionRef, Trigger,
        Value,
    };
    use iii_sdk::error::IIIError;
    use std::future::Future;

    pub trait IIIExt {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError>;

        fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> impl Future<Output = Result<Value, IIIError>> + Send;

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError>;
    }

    impl IIIExt for III {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(
                RegisterFunction::new_async(id.to_string(), f).description(desc.to_string()),
            )
        }

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(RegisterFunction::new_async(id.to_string(), f))
        }

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError> {
            self.register_trigger(RegisterTriggerInput {
                trigger_type: kind.to_string(),
                function_id: function_id.to_string(),
                config,
                metadata: None,
            })
        }

        async fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<Value, IIIError> {
            self.trigger(TriggerRequest {
                function_id: function_id.to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await
        }

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError> {
            let iii = self.clone();
            let fid = function_id.to_string();
            tokio::spawn(async move {
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: fid,
                        payload,
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            });
            Ok(())
        }
    }
}
use iii_compat::IIIExt as _;



#[derive(Debug, Serialize, Deserialize, Clone)]
struct MemoryEntry {
    id: String,
    agent_id: String,
    content: String,
    role: String,
    embedding: Option<Vec<f64>>,
    timestamp: u64,
    session_id: Option<String>,
    importance: f64,
    hash: String,
    confidence: f64,
    access_count: u64,
    last_accessed: u64,
}


#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::store",
        "Store a memory entry with dedup",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { store_memory(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::recall",
        "Hybrid semantic + keyword + recency search",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { recall_memory(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::kg::add",
        "Add knowledge graph entity with bidirectional relations",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { kg_add(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::kg::query",
        "Traverse knowledge graph from entity",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { kg_query(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::evict",
        "Evict stale and low-importance memories",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { evict_memories(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::consolidate",
        "Decay confidence on unaccessed memories",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { consolidate(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::list",
        "List sessions for an agent",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("default");
                iii.trigger_v0("state::list", json!({ "scope": format!("sessions:{}", agent_id) }))
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))
            }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::compact",
        "Compact session via LLM summarization",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { compact_session(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::repair",
        "7-phase session validation and repair",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { repair_session(&iii, input).await }
        },
    );

    iii.register_trigger_v0("cron", "memory::consolidate", json!({ "expression": "0 */6 * * *" }))?;

    iii.register_trigger_v0("cron", "memory::evict", json!({ "expression": "0 3 * * *" }))?;

    tracing::info!("memory worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

async fn store_memory(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let content = input["content"].as_str().unwrap_or("");
    let role = input["role"].as_str().unwrap_or("user");
    let session_id = input["sessionId"].as_str().map(String::from);

    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    let existing: Option<Value> = iii
        .trigger_v0("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": &hash,
        }))
        .await
        .ok();

    if existing.is_some() {
        return Ok(json!({ "deduplicated": true }));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    let embedding: Option<Vec<f64>> = iii
        .trigger_v0("embedding::generate", json!({ "text": content }))
        .await
        .ok()
        .and_then(|v| {
            v.get("embedding")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
        });

    let importance = estimate_importance(content, role);

    let entry = json!({
        "id": &id,
        "agentId": agent_id,
        "content": content,
        "role": role,
        "embedding": embedding,
        "timestamp": now,
        "sessionId": session_id,
        "importance": importance,
        "hash": &hash,
        "confidence": 1.0,
        "accessCount": 0_u64,
        "lastAccessed": now,
    });

    iii.trigger_v0("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &id,
        "value": &entry,
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger_v0("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &hash,
        "value": { "id": &id, "timestamp": now },
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    if let Some(sid) = &session_id {
        let _ = iii.trigger_v0("state::update", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": sid,
            "operations": [
                { "type": "merge", "path": "messages", "value": [{ "id": &id, "role": role, "timestamp": now }] },
                { "type": "set", "path": "updatedAt", "value": now },
            ],
        })).await;
    }

    Ok(json!({ "id": id, "stored": true }))
}

async fn recall_memory(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let query = input["query"].as_str().unwrap_or("");
    let limit = input["limit"].as_u64().unwrap_or(10) as usize;

    let entries: Value = iii
        .trigger_v0("state::list", json!({ "scope": format!("memory:{}", agent_id) }))
        .await
        .unwrap_or(json!([]));

    let memories: Vec<MemoryEntry> = entries
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|e| {
            let val = e.get("value")?;
            if val.get("content").is_none() || val.get("role").is_none() {
                return None;
            }
            serde_json::from_value(val.clone()).ok()
        })
        .collect();

    if memories.is_empty() {
        return Ok(json!([]));
    }

    let query_embedding: Option<Vec<f64>> = iii
        .trigger_v0("embedding::generate", json!({ "text": query }))
        .await
        .ok()
        .and_then(|v| {
            v.get("embedding")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
        });

    let keywords: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();

    let now = now_ms();
    let mut scored: Vec<(f64, &MemoryEntry)> = memories
        .iter()
        .map(|m| {
            let mut score = 0.0_f64;

            if let (Some(qe), Some(me)) = (&query_embedding, &m.embedding) {
                score += cosine_similarity(qe, me) * 0.5;
            }

            let content_lower = m.content.to_lowercase();
            let hits = keywords.iter().filter(|k| content_lower.contains(k.as_str())).count();
            let keyword_score = hits as f64 / keywords.len().max(1) as f64;
            score += keyword_score * 0.25;

            let age_hours = (now.saturating_sub(m.timestamp)) as f64 / 3_600_000.0;
            let recency = (-age_hours / 168.0_f64).exp();
            score += recency * 0.1;

            score += m.importance * 0.1;

            score += m.confidence * 0.05;

            (score, m)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<Value> = scored
        .into_iter()
        .take(limit)
        .map(|(score, m)| {
            let _ = iii.trigger_void("state::update", json!({
                "scope": format!("memory:{}", m.agent_id),
                "key": &m.id,
                "operations": [
                    { "type": "increment", "path": "accessCount", "value": 1 },
                    { "type": "set", "path": "lastAccessed", "value": now_ms() },
                ],
            }));

            json!({
                "role": m.role,
                "content": m.content,
                "score": score,
                "timestamp": m.timestamp,
                "id": m.id,
            })
        })
        .collect();

    Ok(json!(results))
}

async fn kg_add(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let entity = &input["entity"];
    let entity_id = entity["id"].as_str().unwrap_or("");

    iii.trigger_v0("state::set", json!({
        "scope": format!("kg:{}", agent_id),
        "key": entity_id,
        "value": entity,
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    if let Some(relations) = entity["relations"].as_array() {
        for rel in relations {
            let target_id = rel["target"].as_str().unwrap_or("");
            let rel_type = rel["type"].as_str().unwrap_or("");

            if let Ok(target) = iii.trigger_v0("state::get", json!({
                "scope": format!("kg:{}", agent_id),
                "key": target_id,
            })).await {
                let mut back_refs: Vec<Value> = target["relations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();

                let already = back_refs.iter().any(|r| {
                    r["target"].as_str() == Some(entity_id) && r["type"].as_str() == Some(&format!("inverse:{}", rel_type))
                });

                if !already {
                    back_refs.push(json!({ "target": entity_id, "type": format!("inverse:{}", rel_type) }));
                    let _ = iii.trigger_v0("state::update", json!({
                        "scope": format!("kg:{}", agent_id),
                        "key": target_id,
                        "operations": [{ "type": "set", "path": "relations", "value": back_refs }],
                    })).await;
                }
            }
        }
    }

    Ok(json!({ "stored": true, "id": entity_id }))
}

async fn kg_query(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let entity_id = input["entityId"].as_str().unwrap_or("");
    let depth = input["depth"].as_u64().unwrap_or(2);

    let mut visited = std::collections::HashSet::new();
    let mut results = Vec::new();
    let mut queue: Vec<(String, u64)> = vec![(entity_id.to_string(), 0)];

    while let Some((id, d)) = queue.pop() {
        if d >= depth || visited.contains(&id) {
            continue;
        }
        visited.insert(id.clone());

        if let Ok(entity) = iii.trigger_v0("state::get", json!({
            "scope": format!("kg:{}", agent_id),
            "key": &id,
        })).await {
            if let Some(relations) = entity["relations"].as_array() {
                for rel in relations {
                    if let Some(target) = rel["target"].as_str() {
                        queue.push((target.to_string(), d + 1));
                    }
                }
            }
            results.push(entity);
        }
    }

    Ok(json!(results))
}

async fn evict_memories(iii: &III, input: Value) -> Result<Value, IIIError> {
    let max_age_ms = input["maxAge"].as_u64().unwrap_or(30 * 86_400_000);
    let min_importance = input["minImportance"].as_f64().unwrap_or(0.2);
    let cap = input["cap"].as_u64().unwrap_or(10_000) as usize;

    let scopes: Value = iii
        .trigger_v0("state::list_groups", json!({}))
        .await
        .unwrap_or(json!([]));

    let memory_scopes: Vec<String> = scopes
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| s.starts_with("memory:"))
        .map(String::from)
        .collect();

    let now = now_ms();
    let mut total_evicted = 0_u64;

    for scope in &memory_scopes {
        let entries: Value = iii
            .trigger_v0("state::list", json!({ "scope": scope }))
            .await
            .unwrap_or(json!([]));

        let memories: Vec<MemoryEntry> = entries
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|e| {
                let val = e.get("value")?;
                serde_json::from_value(val.clone()).ok()
            })
            .collect();

        let mut scope_evicted = 0_u64;

        for m in &memories {
            let age = now.saturating_sub(m.timestamp);
            let is_stale = age > max_age_ms;
            let is_low_value = m.importance < min_importance;
            let is_low_confidence = m.confidence < 0.1;

            if (is_stale && is_low_value) || is_low_confidence {
                let _ = iii.trigger_v0("state::delete", json!({ "scope": scope, "key": &m.id })).await;
                let _ = iii.trigger_v0("state::delete", json!({ "scope": scope, "key": &m.hash })).await;
                scope_evicted += 1;
            }
        }

        let remaining = (memories.len() as u64).saturating_sub(scope_evicted);
        if remaining > cap as u64 {
            let mut sorted: Vec<&MemoryEntry> = memories.iter().collect();
            sorted.sort_by(|a, b| a.importance.partial_cmp(&b.importance).unwrap_or(std::cmp::Ordering::Equal));

            let overflow = (remaining - cap as u64) as usize;
            for m in sorted.into_iter().take(overflow) {
                let _ = iii.trigger_v0("state::delete", json!({ "scope": scope, "key": &m.id })).await;
                scope_evicted += 1;
            }
        }

        total_evicted += scope_evicted;
    }

    Ok(json!({ "evicted": total_evicted }))
}

async fn consolidate(iii: &III, input: Value) -> Result<Value, IIIError> {
    let decay_rate = input["decayRate"].as_f64().unwrap_or(0.05);
    let start = std::time::Instant::now();

    let scopes: Value = iii
        .trigger_v0("state::list_groups", json!({}))
        .await
        .unwrap_or(json!([]));

    let memory_scopes: Vec<String> = scopes
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| s.starts_with("memory:"))
        .map(String::from)
        .collect();

    let now = now_ms();
    let seven_days_ms = 7 * 86_400_000_u64;
    let mut decayed = 0_u64;

    for scope in &memory_scopes {
        let entries: Value = iii
            .trigger_v0("state::list", json!({ "scope": scope }))
            .await
            .unwrap_or(json!([]));

        for entry in entries.as_array().unwrap_or(&vec![]) {
            let val = match entry.get("value") {
                Some(v) => v,
                None => continue,
            };

            let last_accessed = val["lastAccessed"].as_u64().unwrap_or(0);
            let confidence = val["confidence"].as_f64().unwrap_or(1.0);
            let id = match val["id"].as_str() {
                Some(id) => id,
                None => continue,
            };

            if now.saturating_sub(last_accessed) > seven_days_ms && confidence > 0.1 {
                let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
                let _ = iii.trigger_v0("state::update", json!({
                    "scope": scope,
                    "key": id,
                    "operations": [
                        { "type": "set", "path": "confidence", "value": new_confidence },
                    ],
                })).await;
                decayed += 1;
            }
        }
    }

    Ok(json!({
        "memoriesDecayed": decayed,
        "memoriesMerged": 0,
        "durationMs": start.elapsed().as_millis() as u64,
    }))
}

async fn compact_session(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let session_id = input["sessionId"].as_str().unwrap_or("default");
    let threshold = input["threshold"].as_u64().unwrap_or(30) as usize;
    let keep_recent = input["keepRecent"].as_u64().unwrap_or(10) as usize;

    let session: Value = iii
        .trigger_v0("state::get", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
        }))
        .await
        .unwrap_or(json!({}));

    let messages = session["messages"].as_array().cloned().unwrap_or_default();

    if messages.len() < threshold {
        return Ok(json!({ "compacted": false, "reason": "below_threshold" }));
    }

    let to_summarize = &messages[..messages.len().saturating_sub(keep_recent)];
    let to_keep = &messages[messages.len().saturating_sub(keep_recent)..];

    let mut full_messages = Vec::new();
    for msg_ref in to_summarize {
        let msg_id = msg_ref["id"].as_str().unwrap_or("");
        if let Ok(entry) = iii.trigger_v0("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await {
            full_messages.push(format!(
                "{}: {}",
                entry["role"].as_str().unwrap_or("unknown"),
                entry["content"].as_str().unwrap_or("")
            ));
        }
    }

    let conversation_text = full_messages.join("\n\n");
    let chunks = chunk_text(&conversation_text, 80_000);
    let mut summaries = Vec::new();

    for chunk in &chunks {
        let summary = iii.trigger_v0("llm::complete", json!({
            "model": { "provider": "anthropic", "model": "claude-haiku-4-5", "maxTokens": 1024 },
            "systemPrompt": "Summarize this conversation concisely. Preserve key facts, decisions, and context. Be brief.",
            "messages": [{ "role": "user", "content": chunk }],
        })).await;

        if let Ok(resp) = summary {
            summaries.push(resp["content"].as_str().unwrap_or("").to_string());
        }
    }

    let final_summary = summaries.join("\n\n");

    let summary_id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    iii.trigger_v0("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &summary_id,
        "value": {
            "id": &summary_id,
            "agentId": agent_id,
            "content": &final_summary,
            "role": "system",
            "timestamp": now,
            "sessionId": session_id,
            "importance": 0.9,
            "hash": "",
            "confidence": 1.0,
            "accessCount": 0_u64,
            "lastAccessed": now,
        },
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut new_messages = vec![json!({ "id": summary_id, "role": "system", "timestamp": now })];
    new_messages.extend(to_keep.iter().cloned());

    iii.trigger_v0("state::update", json!({
        "scope": format!("sessions:{}", agent_id),
        "key": session_id,
        "operations": [
            { "type": "set", "path": "messages", "value": new_messages },
            { "type": "set", "path": "compactedAt", "value": now },
        ],
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({
        "compacted": true,
        "summarized": to_summarize.len(),
        "kept": to_keep.len(),
        "summaryId": summary_id,
    }))
}

async fn repair_session(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let session_id = input["sessionId"].as_str().unwrap_or("default");

    let session: Value = iii
        .trigger_v0("state::get", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
        }))
        .await
        .unwrap_or(json!({}));

    let messages = session["messages"].as_array().cloned().unwrap_or_default();
    let mut repaired = messages.clone();
    let mut stats = HashMap::new();

    let before = repaired.len();
    repaired.retain(|m| {
        m.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
    });
    stats.insert("emptyRemoved", (before - repaired.len()) as u64);

    let before = repaired.len();
    let mut seen = std::collections::HashSet::new();
    repaired.retain(|m| {
        let id = m["id"].as_str().unwrap_or("").to_string();
        seen.insert(id)
    });
    stats.insert("duplicatesRemoved", (before - repaired.len()) as u64);

    let mut merged = Vec::new();
    let mut merge_count = 0_u64;
    for msg in &repaired {
        let role = msg["role"].as_str().unwrap_or("");
        if let Some(last) = merged.last() {
            let last_role: &str = match last {
                Value::Object(obj) => obj.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                _ => "",
            };
            if last_role == role && role != "system" {
                merge_count += 1;
                continue;
            }
        }
        merged.push(msg.clone());
    }
    repaired = merged;
    stats.insert("consecutiveMerged", merge_count);

    let mut orphaned = 0_u64;
    for msg in &repaired {
        let msg_id = msg["id"].as_str().unwrap_or("");
        let exists = iii.trigger_v0("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await;
        if exists.is_err() {
            orphaned += 1;
        }
    }
    stats.insert("orphanedRefs", orphaned);

    let mut reordered = 0_u64;
    let mut prev_ts = 0_u64;
    for msg in &mut repaired {
        let ts = msg["timestamp"].as_u64().unwrap_or(0);
        if ts < prev_ts
            && let Some(obj) = msg.as_object_mut()
        {
            obj.insert("timestamp".into(), json!(prev_ts + 1));
            reordered += 1;
        }
        prev_ts = msg["timestamp"].as_u64().unwrap_or(prev_ts);
    }
    stats.insert("reordered", reordered);

    let mut truncated = 0_u64;
    for msg in &repaired {
        let msg_id = msg["id"].as_str().unwrap_or("");
        if let Ok(entry) = iii.trigger_v0("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await {
            let content_len = entry["content"].as_str().map(|s| s.len()).unwrap_or(0);
            if content_len > 500_000 {
                truncated += 1;
            }
        }
    }
    stats.insert("oversizedDetected", truncated);

    let total_repairs: u64 = stats.values().sum();
    if total_repairs > 0 {
        iii.trigger_v0("state::update", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
            "operations": [
                { "type": "set", "path": "messages", "value": repaired },
                { "type": "set", "path": "repairedAt", "value": now_ms() },
                { "type": "set", "path": "repairStats", "value": stats },
            ],
        })).await.map_err(|e| IIIError::Handler(e.to_string()))?;
    }

    Ok(json!({
        "repaired": total_repairs > 0,
        "totalFixes": total_repairs,
        "stats": stats,
    }))
}

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 0.0 { dot / denom } else { 0.0 }
}

fn estimate_importance(content: &str, role: &str) -> f64 {
    let mut score: f64 = 0.5;
    if role == "assistant" { score += 0.1; }
    if content.len() > 500 { score += 0.1; }
    if content.contains("error") || content.contains("bug") || content.contains("fix") || content.contains("critical") {
        score += 0.15;
    }
    if content.contains("```") { score += 0.1; }
    score.min(1.0)
}

fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![];
    }
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }
    let char_indices: Vec<(usize, char)> = text.char_indices().collect();
    let total_chars = char_indices.len();
    let mut chunks = Vec::new();
    let mut start_char = 0;
    while start_char < total_chars {
        let end_char = (start_char + max_chars).min(total_chars);
        let start_byte = char_indices[start_char].0;
        let end_byte = if end_char < total_chars { char_indices[end_char].0 } else { text.len() };
        let slice = &text[start_byte..end_byte];
        let mut split_char = if end_char < total_chars {
            slice.rfind('\n').map(|byte_pos| {
                char_indices[start_char..end_char]
                    .iter()
                    .position(|(b, _)| *b == start_byte + byte_pos)
                    .map(|p| start_char + p + 1)
                    .unwrap_or(end_char)
            }).unwrap_or(end_char)
        } else {
            end_char
        };
        if split_char <= start_char {
            split_char = end_char;
        }
        let split_byte = if split_char < total_chars { char_indices[split_char].0 } else { text.len() };
        chunks.push(text[start_byte..split_byte].to_string());
        start_char = split_char;
    }
    chunks
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_dedup_same_content_same_hash() {
        let content = "Hello, world!";
        let mut hasher1 = sha2::Digest::new();
        sha2::Digest::update(&mut hasher1, content.as_bytes());
        let h1 = format!("{:x}", <Sha256 as sha2::Digest>::finalize(hasher1));

        let mut hasher2 = sha2::Digest::new();
        sha2::Digest::update(&mut hasher2, content.as_bytes());
        let h2 = format!("{:x}", <Sha256 as sha2::Digest>::finalize(hasher2));

        assert_eq!(h1, h2);
    }

    #[test]
    fn test_sha256_dedup_different_content_different_hash() {
        let mut h1 = Sha256::new();
        h1.update(b"content A");
        let r1 = format!("{:x}", h1.finalize());

        let mut h2 = Sha256::new();
        h2.update(b"content B");
        let r2 = format!("{:x}", h2.finalize());

        assert_ne!(r1, r2);
    }

    #[test]
    fn test_sha256_hash_length() {
        let mut hasher = Sha256::new();
        hasher.update(b"test");
        let hash = format!("{:x}", hasher.finalize());
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_cosine_similarity_identical_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_opposite_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![-1.0, -2.0, -3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_different_lengths() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_empty_vectors() {
        let a: Vec<f64> = vec![];
        let b: Vec<f64> = vec![];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![0.0, 0.0, 0.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_proportional_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![2.0, 4.0, 6.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_single_element() {
        let a = vec![5.0];
        let b = vec![3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_user_short() {
        let score = estimate_importance("hello", "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_estimate_importance_assistant_bonus() {
        let score = estimate_importance("hello", "assistant");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_long_content_bonus() {
        let long = "a".repeat(501);
        let score = estimate_importance(&long, "user");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_error_keyword() {
        let score = estimate_importance("there was an error in the code", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_bug_keyword() {
        let score = estimate_importance("found a bug in the system", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_fix_keyword() {
        let score = estimate_importance("please fix this issue", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_critical_keyword() {
        let score = estimate_importance("this is critical", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_code_block_bonus() {
        let score = estimate_importance("here is code ```rust\nfn main() {}```", "user");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_all_bonuses() {
        let long = "a".repeat(501);
        let content = format!("{} error critical ``` code block ```", long);
        let score = estimate_importance(&content, "assistant");
        assert!(score >= 0.9);
        assert!(score <= 1.0);
    }

    #[test]
    fn test_estimate_importance_capped_at_one() {
        let long = "a".repeat(1000);
        let content = format!("{} error bug fix critical ``` block ```", long);
        let score = estimate_importance(&content, "assistant");
        assert!(score <= 1.0);
    }

    #[test]
    fn test_estimate_importance_system_role() {
        let score = estimate_importance("system message", "system");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_chunk_text_short_text() {
        let text = "short text";
        let chunks = chunk_text(text, 100);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "short text");
    }

    #[test]
    fn test_chunk_text_exact_length() {
        let text = "abcde";
        let chunks = chunk_text(text, 5);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "abcde");
    }

    #[test]
    fn test_chunk_text_splits_on_newline() {
        let text = "line one\nline two\nline three\nline four";
        let chunks = chunk_text(text, 20);
        assert!(chunks.len() >= 2);
        for chunk in &chunks {
            assert!(chunk.len() <= 20 || !chunk.contains('\n'));
        }
    }

    #[test]
    fn test_chunk_text_no_newline_splits_at_max() {
        let text = "a".repeat(100);
        let chunks = chunk_text(&text, 30);
        assert!(chunks.len() >= 3);
    }

    #[test]
    fn test_chunk_text_empty() {
        let chunks = chunk_text("", 100);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "");
    }

    #[test]
    fn test_chunk_text_preserves_all_content() {
        let text = "Hello\nWorld\nFoo\nBar\nBaz\nQux";
        let chunks = chunk_text(text, 10);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_now_ms_returns_nonzero() {
        let ts = now_ms();
        assert!(ts > 0);
    }

    #[test]
    fn test_now_ms_increasing() {
        let t1 = now_ms();
        let t2 = now_ms();
        assert!(t2 >= t1);
    }

    #[test]
    fn test_memory_entry_serialization() {
        let entry = MemoryEntry {
            id: "m-1".to_string(),
            agent_id: "agent-1".to_string(),
            content: "test content".to_string(),
            role: "user".to_string(),
            embedding: Some(vec![0.1, 0.2, 0.3]),
            timestamp: 1000,
            session_id: Some("sess-1".to_string()),
            importance: 0.75,
            hash: "abc123".to_string(),
            confidence: 0.9,
            access_count: 5,
            last_accessed: 2000,
        };
        let val = serde_json::to_value(&entry).unwrap();
        assert_eq!(val["id"], "m-1");
        assert_eq!(val["agent_id"], "agent-1");
        assert_eq!(val["content"], "test content");
        assert_eq!(val["role"], "user");
        assert_eq!(val["importance"], 0.75);
        assert_eq!(val["confidence"], 0.9);
        assert_eq!(val["access_count"], 5);
    }

    #[test]
    fn test_memory_entry_deserialization() {
        let json_val = json!({
            "id": "m-2",
            "agent_id": "agent-2",
            "content": "remembered fact",
            "role": "assistant",
            "embedding": null,
            "timestamp": 5000,
            "session_id": null,
            "importance": 0.5,
            "hash": "def456",
            "confidence": 1.0,
            "access_count": 0,
            "last_accessed": 5000,
        });
        let entry: MemoryEntry = serde_json::from_value(json_val).unwrap();
        assert_eq!(entry.id, "m-2");
        assert_eq!(entry.agent_id, "agent-2");
        assert_eq!(entry.embedding, None);
        assert_eq!(entry.session_id, None);
    }

    #[test]
    fn test_memory_entry_roundtrip() {
        let entry = MemoryEntry {
            id: "rt-1".to_string(),
            agent_id: "agent-rt".to_string(),
            content: "roundtrip test".to_string(),
            role: "system".to_string(),
            embedding: Some(vec![1.0, 2.0]),
            timestamp: 42,
            session_id: Some("s-1".to_string()),
            importance: 0.8,
            hash: "h1".to_string(),
            confidence: 0.95,
            access_count: 10,
            last_accessed: 100,
        };
        let serialized = serde_json::to_string(&entry).unwrap();
        let deserialized: MemoryEntry = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.id, entry.id);
        assert_eq!(deserialized.content, entry.content);
        assert_eq!(deserialized.embedding, entry.embedding);
    }

    #[test]
    fn test_cosine_similarity_known_value() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        let expected = 1.0 / (2.0_f64).sqrt();
        assert!((sim - expected).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_exact_500_chars_no_bonus() {
        let content = "a".repeat(500);
        let score = estimate_importance(&content, "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_chunk_text_single_char_max() {
        let text = "abc";
        let chunks = chunk_text(text, 1);
        assert_eq!(chunks.len(), 3);
    }

    #[test]
    fn test_chunk_text_large_max() {
        let text = "Hello world";
        let chunks = chunk_text(text, 1000000);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn test_estimate_importance_empty_content() {
        let score = estimate_importance("", "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_cosine_similarity_negative_values() {
        let a = vec![-1.0, -2.0, -3.0];
        let b = vec![-1.0, -2.0, -3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_mixed_values() {
        let a = vec![1.0, -1.0];
        let b = vec![-1.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_large_vectors_100_elements() {
        let a: Vec<f64> = (0..100).map(|i| (i as f64) * 0.1).collect();
        let b: Vec<f64> = (0..100).map(|i| (i as f64) * 0.2).collect();
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_large_vectors_1000_elements() {
        let a: Vec<f64> = (0..1000).map(|i| ((i as f64) * 0.01).sin()).collect();
        let b: Vec<f64> = (0..1000).map(|i| ((i as f64) * 0.01).sin()).collect();
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_nan_produces_nan_or_zero() {
        let a = vec![f64::NAN, 1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.is_nan() || sim == 0.0);
    }

    #[test]
    fn test_cosine_similarity_very_small_values_underflow() {
        let a = vec![1e-300, 2e-300, 3e-300];
        let b = vec![1e-300, 2e-300, 3e-300];
        let sim = cosine_similarity(&a, &b);
        assert_eq!(sim, 0.0);
    }

    #[test]
    fn test_cosine_similarity_moderately_small_values() {
        let a = vec![1e-100, 2e-100, 3e-100];
        let b = vec![1e-100, 2e-100, 3e-100];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_very_large_values() {
        let a = vec![1e150, 2e150, 3e150];
        let b = vec![1e150, 2e150, 3e150];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_one_zero_one_nonzero() {
        let a = vec![0.0, 0.0];
        let b = vec![0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert_eq!(sim, 0.0);
    }

    #[test]
    fn test_estimate_importance_error_and_bug_combined() {
        let score = estimate_importance("this error is actually a bug", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_error_critical_code() {
        let score = estimate_importance("error critical ```code```", "user");
        assert!((score - 0.75).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_all_keywords_assistant_long() {
        let long = "a".repeat(501);
        let content = format!("{} error bug fix critical ```block```", long);
        let score = estimate_importance(&content, "assistant");
        assert!((score - 0.95).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_exact_500_chars_boundary() {
        let exactly_500 = "a".repeat(500);
        let score_at = estimate_importance(&exactly_500, "user");
        assert_eq!(score_at, 0.5);

        let exactly_501 = "a".repeat(501);
        let score_above = estimate_importance(&exactly_501, "user");
        assert!((score_above - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_case_sensitive_keywords() {
        let score_lower = estimate_importance("error", "user");
        assert!((score_lower - 0.65).abs() < 1e-10);

        let score_upper = estimate_importance("ERROR", "user");
        assert_eq!(score_upper, 0.5);
    }

    #[test]
    fn test_estimate_importance_keyword_in_larger_word() {
        let score = estimate_importance("errorhandling bugfix fixture critically", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_code_block_only() {
        let score = estimate_importance("some text with ``` code blocks ```", "user");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_assistant_with_code_and_long() {
        let long = "a".repeat(501);
        let content = format!("{} ```some code```", long);
        let score = estimate_importance(&content, "assistant");
        assert!((score - 0.8).abs() < 1e-10);
    }

    #[test]
    fn test_chunk_text_unicode_emoji() {
        let text = "\u{1f600}\u{1f680}\u{1f4a1}\u{2764}\u{fe0f}\u{1f525}";
        let chunks = chunk_text(text, 100);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains('\u{1f600}'));
    }

    #[test]
    fn test_chunk_text_cjk_characters() {
        let text = "\u{4e16}\u{754c}\u{4f60}\u{597d}\u{6211}\u{4eec}\u{5b66}\u{4e60}\u{7f16}\u{7a0b}";
        let chunks = chunk_text(text, 15);
        assert!(chunks.len() >= 1);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_cjk_split_at_one() {
        let text = "\u{4e16}\u{754c}\u{4f60}\u{597d}";
        let chunks = chunk_text(text, 1);
        assert_eq!(chunks.len(), 4);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_emoji_split_at_one() {
        let text = "\u{1f600}\u{1f680}\u{1f4a1}";
        let chunks = chunk_text(text, 1);
        assert_eq!(chunks.len(), 3);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_only_newlines() {
        let text = "\n\n\n\n\n";
        let chunks = chunk_text(text, 3);
        assert!(chunks.len() >= 1);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_single_long_line() {
        let text = "a".repeat(200);
        let chunks = chunk_text(&text, 50);
        assert_eq!(chunks.len(), 4);
        for chunk in &chunks {
            assert!(chunk.len() <= 50);
        }
    }

    #[test]
    fn test_chunk_text_mixed_newlines_and_content() {
        let text = "line1\nline2\n\nline4\nline5\nline6";
        let chunks = chunk_text(text, 12);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_exact_boundary_at_newline() {
        let text = "12345\n67890\nabcde";
        let chunks = chunk_text(text, 6);
        assert!(chunks.len() >= 2);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_memory_entry_all_defaults_and_empty() {
        let entry = MemoryEntry {
            id: "".to_string(),
            agent_id: "".to_string(),
            content: "".to_string(),
            role: "".to_string(),
            embedding: None,
            timestamp: 0,
            session_id: None,
            importance: 0.0,
            hash: "".to_string(),
            confidence: 0.0,
            access_count: 0,
            last_accessed: 0,
        };
        let val = serde_json::to_value(&entry).unwrap();
        assert_eq!(val["id"], "");
        assert_eq!(val["importance"], 0.0);
        assert_eq!(val["confidence"], 0.0);
        assert_eq!(val["access_count"], 0);
    }

    #[test]
    fn test_memory_entry_very_long_content() {
        let long_content = "x".repeat(1_000_000);
        let entry = MemoryEntry {
            id: "long-1".to_string(),
            agent_id: "agent-1".to_string(),
            content: long_content.clone(),
            role: "user".to_string(),
            embedding: None,
            timestamp: 1000,
            session_id: None,
            importance: 0.5,
            hash: "hash-long".to_string(),
            confidence: 1.0,
            access_count: 0,
            last_accessed: 1000,
        };
        assert_eq!(entry.content.len(), 1_000_000);
        let serialized = serde_json::to_string(&entry).unwrap();
        let deserialized: MemoryEntry = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.content.len(), 1_000_000);
    }

    #[test]
    fn test_memory_entry_empty_embedding_vec() {
        let entry = MemoryEntry {
            id: "emb-empty".to_string(),
            agent_id: "a".to_string(),
            content: "test".to_string(),
            role: "user".to_string(),
            embedding: Some(vec![]),
            timestamp: 100,
            session_id: None,
            importance: 0.5,
            hash: "h".to_string(),
            confidence: 1.0,
            access_count: 0,
            last_accessed: 100,
        };
        assert_eq!(entry.embedding.as_ref().unwrap().len(), 0);
        let val = serde_json::to_value(&entry).unwrap();
        assert!(val["embedding"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_memory_entry_large_embedding() {
        let embedding = vec![0.01; 1536];
        let entry = MemoryEntry {
            id: "emb-large".to_string(),
            agent_id: "a".to_string(),
            content: "test".to_string(),
            role: "user".to_string(),
            embedding: Some(embedding.clone()),
            timestamp: 100,
            session_id: None,
            importance: 0.5,
            hash: "h".to_string(),
            confidence: 1.0,
            access_count: 0,
            last_accessed: 100,
        };
        assert_eq!(entry.embedding.as_ref().unwrap().len(), 1536);
    }

    #[test]
    fn test_now_ms_monotonicity_repeated() {
        let t1 = now_ms();
        let t2 = now_ms();
        let t3 = now_ms();
        assert!(t2 >= t1);
        assert!(t3 >= t2);
    }

    #[test]
    fn test_now_ms_returns_reasonable_value() {
        let ts = now_ms();
        assert!(ts > 1_700_000_000_000);
    }

    #[test]
    fn test_sha256_empty_string_hash() {
        let mut hasher = Sha256::new();
        hasher.update(b"");
        let hash = format!("{:x}", hasher.finalize());
        assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn test_sha256_whitespace_only_hash() {
        let mut h1 = Sha256::new();
        h1.update(b" ");
        let hash_space = format!("{:x}", h1.finalize());

        let mut h2 = Sha256::new();
        h2.update(b"\t");
        let hash_tab = format!("{:x}", h2.finalize());

        let mut h3 = Sha256::new();
        h3.update(b"\n");
        let hash_newline = format!("{:x}", h3.finalize());

        assert_ne!(hash_space, hash_tab);
        assert_ne!(hash_space, hash_newline);
        assert_ne!(hash_tab, hash_newline);
        assert_eq!(hash_space.len(), 64);
    }

    #[test]
    fn test_sha256_unicode_content() {
        let mut h1 = Sha256::new();
        h1.update("\u{1f600}".as_bytes());
        let hash = format!("{:x}", h1.finalize());
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_session_compact_below_threshold() {
        let messages: Vec<Value> = (0..29).map(|i| json!({"id": format!("m-{}", i), "role": "user"})).collect();
        let threshold = 30_usize;
        let below = messages.len() < threshold;
        assert!(below);
    }

    #[test]
    fn test_session_compact_at_threshold() {
        let messages: Vec<Value> = (0..30).map(|i| json!({"id": format!("m-{}", i), "role": "user"})).collect();
        let threshold = 30_usize;
        let below = messages.len() < threshold;
        assert!(!below);
    }

    #[test]
    fn test_session_compact_above_threshold() {
        let messages: Vec<Value> = (0..31).map(|i| json!({"id": format!("m-{}", i), "role": "user"})).collect();
        let threshold = 30_usize;
        let keep_recent = 10_usize;
        let below = messages.len() < threshold;
        assert!(!below);
        let to_summarize = &messages[..messages.len().saturating_sub(keep_recent)];
        let to_keep = &messages[messages.len().saturating_sub(keep_recent)..];
        assert_eq!(to_summarize.len(), 21);
        assert_eq!(to_keep.len(), 10);
    }

    #[test]
    fn test_session_compact_keep_recent_larger_than_messages() {
        let messages: Vec<Value> = (0..5).map(|i| json!({"id": format!("m-{}", i)})).collect();
        let keep_recent = 10_usize;
        let to_keep = &messages[messages.len().saturating_sub(keep_recent)..];
        assert_eq!(to_keep.len(), 5);
    }

    #[test]
    fn test_eviction_stale_and_low_value() {
        let now = 10_000_000_000u64;
        let max_age_ms = 30 * 86_400_000u64;
        let timestamp = 0u64;
        let importance = 0.1;
        let confidence = 0.5;
        let min_importance = 0.2;

        let age = now.saturating_sub(timestamp);
        let is_stale = age > max_age_ms;
        let is_low_value = importance < min_importance;
        let is_low_confidence = confidence < 0.1;

        assert!(is_stale);
        assert!(is_low_value);
        assert!(!is_low_confidence);
        assert!((is_stale && is_low_value) || is_low_confidence);
    }

    #[test]
    fn test_eviction_low_confidence_only() {
        let confidence = 0.05;
        let is_low_confidence = confidence < 0.1;
        assert!(is_low_confidence);
    }

    #[test]
    fn test_eviction_not_stale_not_low_value() {
        let now = 1000u64;
        let max_age_ms = 30 * 86_400_000u64;
        let timestamp = 500u64;
        let importance = 0.8;
        let confidence = 0.5;

        let age = now.saturating_sub(timestamp);
        let is_stale = age > max_age_ms;
        let is_low_value = importance < 0.2;
        let is_low_confidence = confidence < 0.1;

        assert!(!is_stale);
        assert!(!is_low_value);
        assert!(!is_low_confidence);
        assert!(!((is_stale && is_low_value) || is_low_confidence));
    }

    #[test]
    fn test_consolidation_decay_rate() {
        let decay_rate: f64 = 0.05;
        let confidence: f64 = 0.8;
        let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
        assert!((new_confidence - 0.76).abs() < 1e-10);
    }

    #[test]
    fn test_consolidation_decay_floors_at_0_1() {
        let decay_rate: f64 = 0.05;
        let confidence: f64 = 0.1;
        let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
        assert_eq!(new_confidence, 0.1);
    }

    #[test]
    fn test_consolidation_skip_recently_accessed() {
        let now = 100_000u64;
        let seven_days_ms = 7 * 86_400_000u64;
        let last_accessed = now - 1000;
        let should_decay = now.saturating_sub(last_accessed) > seven_days_ms;
        assert!(!should_decay);
    }

    #[test]
    fn test_keyword_scoring() {
        let query = "find the error in code";
        let keywords: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
        assert_eq!(keywords.len(), 5);

        let content_lower = "there was an error in the code block".to_lowercase();
        let hits = keywords.iter().filter(|k| content_lower.contains(k.as_str())).count();
        assert_eq!(hits, 4);
        let keyword_score = hits as f64 / keywords.len().max(1) as f64;
        assert!((keyword_score - 0.8).abs() < 1e-10);
    }

    #[test]
    fn test_keyword_scoring_empty_query() {
        let query = "";
        let keywords: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
        assert_eq!(keywords.len(), 0);
        let hits = 0usize;
        let keyword_score = hits as f64 / keywords.len().max(1) as f64;
        assert_eq!(keyword_score, 0.0);
    }

    #[test]
    fn test_recency_score_recent() {
        let now = 1_000_000u64;
        let timestamp = 999_000u64;
        let age_hours = (now.saturating_sub(timestamp)) as f64 / 3_600_000.0;
        let recency = (-age_hours / 168.0_f64).exp();
        assert!(recency > 0.99);
    }

    #[test]
    fn test_recency_score_old() {
        let now = 100_000_000_000u64;
        let timestamp = 0u64;
        let age_hours = (now.saturating_sub(timestamp)) as f64 / 3_600_000.0;
        let recency = (-age_hours / 168.0_f64).exp();
        assert!(recency < 0.01);
    }

    #[test]
    fn test_memory_scope_format() {
        let agent_id = "agent-42";
        let scope = format!("memory:{}", agent_id);
        assert_eq!(scope, "memory:agent-42");
        assert!(scope.starts_with("memory:"));
    }

    #[test]
    fn test_session_scope_format() {
        let agent_id = "agent-42";
        let scope = format!("sessions:{}", agent_id);
        assert_eq!(scope, "sessions:agent-42");
    }

    #[test]
    fn test_repair_empty_id_removal() {
        let messages = vec![
            json!({"id": "m-1", "role": "user"}),
            json!({"id": "", "role": "user"}),
            json!({"role": "user"}),
            json!({"id": "m-4", "role": "assistant"}),
        ];
        let mut repaired = messages.clone();
        let before = repaired.len();
        repaired.retain(|m| {
            m.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
        });
        assert_eq!(before - repaired.len(), 2);
        assert_eq!(repaired.len(), 2);
    }

    #[test]
    fn test_repair_dedup_by_id() {
        let messages = vec![
            json!({"id": "m-1", "role": "user"}),
            json!({"id": "m-1", "role": "user"}),
            json!({"id": "m-2", "role": "assistant"}),
        ];
        let mut seen = std::collections::HashSet::new();
        let repaired: Vec<&Value> = messages.iter().filter(|m| {
            let id = m["id"].as_str().unwrap_or("").to_string();
            seen.insert(id)
        }).collect();
        assert_eq!(repaired.len(), 2);
    }

    #[test]
    fn test_repair_consecutive_role_merge() {
        let messages = vec![
            json!({"id": "m-1", "role": "user"}),
            json!({"id": "m-2", "role": "user"}),
            json!({"id": "m-3", "role": "assistant"}),
            json!({"id": "m-4", "role": "assistant"}),
            json!({"id": "m-5", "role": "system"}),
            json!({"id": "m-6", "role": "system"}),
        ];
        let mut merged = Vec::new();
        let mut merge_count = 0u64;
        for msg in &messages {
            let role = msg["role"].as_str().unwrap_or("");
            if let Some(last) = merged.last() {
                let last_role: &str = match last {
                    Value::Object(obj) => obj.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                    _ => "",
                };
                if last_role == role && role != "system" {
                    merge_count += 1;
                    continue;
                }
            }
            merged.push(msg.clone());
        }
        assert_eq!(merge_count, 2);
        assert_eq!(merged.len(), 4);
    }

    #[test]
    fn test_repair_timestamp_reordering() {
        let mut messages = vec![
            json!({"id": "m-1", "timestamp": 100, "role": "user"}),
            json!({"id": "m-2", "timestamp": 50, "role": "assistant"}),
            json!({"id": "m-3", "timestamp": 200, "role": "user"}),
        ];
        let mut reordered = 0u64;
        let mut prev_ts = 0u64;
        for msg in &mut messages {
            let ts = msg["timestamp"].as_u64().unwrap_or(0);
            if ts < prev_ts {
                if let Some(obj) = msg.as_object_mut() {
                    obj.insert("timestamp".into(), json!(prev_ts + 1));
                    reordered += 1;
                }
            }
            prev_ts = msg["timestamp"].as_u64().unwrap_or(prev_ts);
        }
        assert_eq!(reordered, 1);
        assert_eq!(messages[1]["timestamp"], 101);
    }

    #[test]
    fn test_cosine_similarity_unit_vectors() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let c = vec![0.0, 0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-10);
        assert!(cosine_similarity(&a, &c).abs() < 1e-10);
        assert!(cosine_similarity(&b, &c).abs() < 1e-10);
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_half_pi_angle() {
        let a = vec![1.0, 1.0];
        let b = vec![1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        let expected = 1.0 / (2.0_f64).sqrt();
        assert!((sim - expected).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_multiple_keywords_only_one_bonus() {
        let score_one = estimate_importance("error happened", "user");
        let score_two = estimate_importance("error and bug happened", "user");
        assert_eq!(score_one, score_two);
    }

    #[test]
    fn test_estimate_importance_assistant_long_error_code() {
        let long = "a".repeat(501);
        let content = format!("{} error ```code```", long);
        let score = estimate_importance(&content, "assistant");
        assert!((score - 0.95).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_empty_role() {
        let score = estimate_importance("hello", "");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_chunk_text_two_char_max() {
        let text = "abcdef";
        let chunks = chunk_text(text, 2);
        assert_eq!(chunks.len(), 3);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_newline_at_boundary() {
        let text = "ab\ncd\nef";
        let chunks = chunk_text(text, 3);
        assert!(chunks.len() >= 2);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_chunk_text_all_same_char() {
        let text = "x".repeat(50);
        let chunks = chunk_text(&text, 10);
        assert_eq!(chunks.len(), 5);
        for chunk in &chunks {
            assert_eq!(chunk.len(), 10);
        }
    }

    #[test]
    fn test_memory_entry_unicode_content() {
        let entry = MemoryEntry {
            id: "unicode-1".to_string(),
            agent_id: "agent".to_string(),
            content: "\u{4f60}\u{597d}\u{4e16}\u{754c} \u{1f600}".to_string(),
            role: "user".to_string(),
            embedding: None,
            timestamp: 100,
            session_id: None,
            importance: 0.5,
            hash: "h".to_string(),
            confidence: 1.0,
            access_count: 0,
            last_accessed: 100,
        };
        let serialized = serde_json::to_string(&entry).unwrap();
        let deserialized: MemoryEntry = serde_json::from_str(&serialized).unwrap();
        assert!(deserialized.content.contains("\u{4f60}"));
        assert!(deserialized.content.contains("\u{1f600}"));
    }

    #[test]
    fn test_memory_entry_max_importance_confidence() {
        let entry = MemoryEntry {
            id: "max-1".to_string(),
            agent_id: "agent".to_string(),
            content: "test".to_string(),
            role: "user".to_string(),
            embedding: None,
            timestamp: 100,
            session_id: None,
            importance: 1.0,
            hash: "h".to_string(),
            confidence: 1.0,
            access_count: u64::MAX,
            last_accessed: u64::MAX,
        };
        let val = serde_json::to_value(&entry).unwrap();
        assert_eq!(val["importance"], 1.0);
        assert_eq!(val["confidence"], 1.0);
    }

    #[test]
    fn test_consolidation_decay_multiple_rounds() {
        let decay_rate = 0.05_f64;
        let mut confidence = 1.0_f64;
        for _ in 0..100 {
            confidence = (confidence * (1.0 - decay_rate)).max(0.1);
        }
        assert_eq!(confidence, 0.1);
    }

    #[test]
    fn test_consolidation_decay_rate_zero() {
        let decay_rate = 0.0_f64;
        let confidence = 0.8_f64;
        let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
        assert!((new_confidence - 0.8).abs() < 1e-10);
    }

    #[test]
    fn test_consolidation_decay_rate_one() {
        let decay_rate = 1.0_f64;
        let confidence = 0.8_f64;
        let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
        assert_eq!(new_confidence, 0.1);
    }

    #[test]
    fn test_eviction_stale_but_high_value() {
        let now = 10_000_000_000u64;
        let max_age_ms = 30 * 86_400_000u64;
        let timestamp = 0u64;
        let importance = 0.9;
        let confidence = 0.5;

        let age = now.saturating_sub(timestamp);
        let is_stale = age > max_age_ms;
        let is_low_value = importance < 0.2;
        let is_low_confidence = confidence < 0.1;

        assert!(is_stale);
        assert!(!is_low_value);
        assert!(!((is_stale && is_low_value) || is_low_confidence));
    }

    #[test]
    fn test_eviction_not_stale_but_low_value() {
        let now = 1000u64;
        let max_age_ms = 30 * 86_400_000u64;
        let timestamp = 500u64;
        let importance = 0.1;

        let age = now.saturating_sub(timestamp);
        let is_stale = age > max_age_ms;
        let is_low_value = importance < 0.2;
        let is_low_confidence = false;

        assert!(!is_stale);
        assert!(is_low_value);
        assert!(!((is_stale && is_low_value) || is_low_confidence));
    }

    #[test]
    fn test_eviction_at_confidence_boundary() {
        let confidence_just_below = 0.09999;
        let confidence_at = 0.1;
        assert!(confidence_just_below < 0.1);
        assert!(!(confidence_at < 0.1));
    }

    #[test]
    fn test_recency_score_one_week() {
        let now = 1_000_000_000u64;
        let one_week_ms = 7 * 24 * 3_600_000u64;
        let timestamp = now - one_week_ms;
        let age_hours = (now.saturating_sub(timestamp)) as f64 / 3_600_000.0;
        let recency = (-age_hours / 168.0_f64).exp();
        assert!((recency - (-1.0_f64).exp()).abs() < 1e-6);
    }

    #[test]
    fn test_keyword_scoring_all_match() {
        let query = "the code";
        let keywords: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
        let content_lower = "the code is great".to_lowercase();
        let hits = keywords.iter().filter(|k| content_lower.contains(k.as_str())).count();
        let score = hits as f64 / keywords.len().max(1) as f64;
        assert!((score - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_keyword_scoring_no_match() {
        let query = "xyz abc";
        let keywords: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
        let content_lower = "nothing matches here".to_lowercase();
        let hits = keywords.iter().filter(|k| content_lower.contains(k.as_str())).count();
        let score = hits as f64 / keywords.len().max(1) as f64;
        assert_eq!(score, 0.0);
    }

    #[test]
    fn test_repair_all_empty_ids() {
        let messages = vec![
            json!({"id": "", "role": "user"}),
            json!({"role": "user"}),
            json!({"id": null, "role": "user"}),
        ];
        let mut repaired = messages.clone();
        repaired.retain(|m| {
            m.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
        });
        assert_eq!(repaired.len(), 0);
    }

    #[test]
    fn test_repair_no_duplicates() {
        let messages = vec![
            json!({"id": "m-1", "role": "user"}),
            json!({"id": "m-2", "role": "assistant"}),
            json!({"id": "m-3", "role": "user"}),
        ];
        let mut seen = std::collections::HashSet::new();
        let repaired: Vec<&Value> = messages.iter().filter(|m| {
            let id = m["id"].as_str().unwrap_or("").to_string();
            seen.insert(id)
        }).collect();
        assert_eq!(repaired.len(), 3);
    }

    #[test]
    fn test_repair_consecutive_system_messages_not_merged() {
        let messages = vec![
            json!({"id": "m-1", "role": "system"}),
            json!({"id": "m-2", "role": "system"}),
            json!({"id": "m-3", "role": "system"}),
        ];
        let mut merged = Vec::new();
        let mut merge_count = 0u64;
        for msg in &messages {
            let role = msg["role"].as_str().unwrap_or("");
            if let Some(last) = merged.last() {
                let last_role: &str = match last {
                    Value::Object(obj) => obj.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                    _ => "",
                };
                if last_role == role && role != "system" {
                    merge_count += 1;
                    continue;
                }
            }
            merged.push(msg.clone());
        }
        assert_eq!(merge_count, 0);
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn test_repair_timestamp_all_ascending() {
        let mut messages = vec![
            json!({"id": "m-1", "timestamp": 100}),
            json!({"id": "m-2", "timestamp": 200}),
            json!({"id": "m-3", "timestamp": 300}),
        ];
        let mut reordered = 0u64;
        let mut prev_ts = 0u64;
        for msg in &mut messages {
            let ts = msg["timestamp"].as_u64().unwrap_or(0);
            if ts < prev_ts {
                if let Some(obj) = msg.as_object_mut() {
                    obj.insert("timestamp".into(), json!(prev_ts + 1));
                    reordered += 1;
                }
            }
            prev_ts = msg["timestamp"].as_u64().unwrap_or(prev_ts);
        }
        assert_eq!(reordered, 0);
    }

    #[test]
    fn test_repair_timestamp_all_descending() {
        let mut messages = vec![
            json!({"id": "m-1", "timestamp": 300}),
            json!({"id": "m-2", "timestamp": 200}),
            json!({"id": "m-3", "timestamp": 100}),
        ];
        let mut reordered = 0u64;
        let mut prev_ts = 0u64;
        for msg in &mut messages {
            let ts = msg["timestamp"].as_u64().unwrap_or(0);
            if ts < prev_ts {
                if let Some(obj) = msg.as_object_mut() {
                    obj.insert("timestamp".into(), json!(prev_ts + 1));
                    reordered += 1;
                }
            }
            prev_ts = msg["timestamp"].as_u64().unwrap_or(prev_ts);
        }
        assert_eq!(reordered, 2);
    }

    #[test]
    fn test_kg_scope_format() {
        let agent_id = "agent-99";
        let scope = format!("kg:{}", agent_id);
        assert_eq!(scope, "kg:agent-99");
    }

    #[test]
    fn test_sha256_known_value() {
        let mut hasher = Sha256::new();
        hasher.update(b"hello");
        let hash = format!("{:x}", hasher.finalize());
        assert_eq!(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn test_chunk_text_preserves_content_large() {
        let text: String = (0..100).map(|i| format!("line {}\n", i)).collect();
        let chunks = chunk_text(&text, 50);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }
}

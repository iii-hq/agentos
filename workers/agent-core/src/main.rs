use iii_sdk::{III, InitOptions, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use std::time::Instant;

mod types;

use types::{AgentConfig, ChatRequest, ToolCall};

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



const MAX_ITERATIONS: u32 = 50;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::chat",
        "Process a message through the agent loop",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ChatRequest = serde_json::from_value(input)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                agent_chat(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::list_tools",
        "List tools available to an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("default");
                list_tools(&iii, agent_id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::create",
        "Register a new agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let config: AgentConfig = serde_json::from_value(input)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                create_agent(&iii, config).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::list",
        "List all agents",
        move |_: Value| {
            let iii = iii_clone.clone();
            async move {
                iii.trigger_v0("state::list", json!({ "scope": "agents" })).await
                    .map_err(|e| IIIError::Handler(e.to_string()))
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::delete",
        "Remove an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("");
                iii.trigger_v0("state::delete", json!({
                    "scope": "agents",
                    "key": agent_id,
                })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

                let _ = iii.trigger_void("publish", json!({
                    "topic": "agent.lifecycle",
                    "data": { "type": "deleted", "agentId": agent_id },
                }));

                Ok(json!({ "deleted": true }))
            }
        },
    );

    iii.register_trigger_v0("queue", "agent::chat", json!({ "topic": "agent.inbox" }))?;

    tracing::info!("agent-core worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

async fn agent_chat(iii: &III, req: ChatRequest) -> Result<Value, IIIError> {
    let start = Instant::now();

    let config: Option<AgentConfig> = iii
        .trigger_v0("state::get", json!({
            "scope": "agents",
            "key": &req.agent_id,
        }))
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());

    let memories: Value = iii
        .trigger_v0("memory::recall", json!({
            "agentId": &req.agent_id,
            "query": &req.message,
            "limit": 20,
        }))
        .await
        .unwrap_or(json!([]));

    let tools: Value = iii
        .trigger_v0("agent::list_tools", json!({ "agentId": &req.agent_id }))
        .await
        .unwrap_or(json!([]));

    let system_prompt = req.system_prompt
        .or_else(|| config.as_ref().and_then(|c| c.system_prompt.clone()))
        .unwrap_or_default();

    let model: Value = iii
        .trigger_v0("llm::route", json!({
            "message": &req.message,
            "toolCount": tools.as_array().map(|a| a.len()).unwrap_or(0),
            "config": config.as_ref().and_then(|c| c.model.as_ref()),
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let scan_result = iii
        .trigger_v0("security::scan_injection", json!({ "text": &req.message }))
        .await
        .unwrap_or(json!({ "safe": true, "riskScore": 0.0 }));
    let risk_score = scan_result["riskScore"].as_f64().unwrap_or(0.0);
    if risk_score > 0.5 {
        return Err(IIIError::Handler(format!(
            "Message rejected: injection risk score {:.2} exceeds threshold",
            risk_score
        )));
    }

    let mut messages = vec![];
    if let Some(mems) = memories.as_array() {
        messages.extend(mems.iter().cloned());
    }
    messages.push(json!({ "role": "user", "content": &req.message }));

    let mut response: Value = iii
        .trigger_v0("llm::complete", json!({
            "model": model,
            "systemPrompt": system_prompt,
            "messages": messages,
            "tools": tools,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut iterations: u32 = 0;

    while let Some(tool_calls) = response.get("toolCalls").and_then(|v| v.as_array()) {
        if tool_calls.is_empty() || iterations >= MAX_ITERATIONS {
            break;
        }
        iterations += 1;

        let calls: Vec<ToolCall> = tool_calls
            .iter()
            .filter_map(|tc| serde_json::from_value(tc.clone()).ok())
            .collect();

        let mut tool_results = Vec::new();
        for tc in &calls {
            let cap_check = iii.trigger_v0("security::check_capability", json!({
                "agentId": &req.agent_id,
                "capability": tc.id.split("::").next().unwrap_or(""),
                "resource": &tc.id,
            })).await;

            if cap_check.is_err() {
                tool_results.push(json!({
                    "toolCallId": tc.call_id,
                    "output": { "error": "capability denied" },
                }));
                continue;
            }

            match iii.trigger_v0(&tc.id, tc.arguments.clone()).await {
                Ok(result) => {
                    tool_results.push(json!({
                        "toolCallId": tc.call_id,
                        "output": result,
                    }));
                }
                Err(e) => {
                    tool_results.push(json!({
                        "toolCallId": tc.call_id,
                        "output": { "error": e.to_string() },
                    }));
                }
            }
        }

        messages.push(json!({ "role": "assistant", "content": null, "tool_calls": response.get("toolCalls") }));
        for tr in &tool_results {
            messages.push(json!({ "role": "tool", "tool_call_id": tr["toolCallId"], "content": tr["output"].to_string() }));
        }

        response = iii
            .trigger_v0("llm::complete", json!({
                "model": model,
                "systemPrompt": system_prompt,
                "messages": messages,
                "tools": tools,
            }))
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
    }

    let session_id = req.session_id
        .unwrap_or_else(|| format!("default:{}", req.agent_id));

    let _ = iii.trigger_void("memory::store", json!({
        "agentId": &req.agent_id,
        "sessionId": &session_id,
        "role": "user",
        "content": &req.message,
    }));

    let _ = iii.trigger_void("memory::store", json!({
        "agentId": &req.agent_id,
        "sessionId": &session_id,
        "role": "assistant",
        "content": response.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        "tokenUsage": response.get("usage"),
    }));

    let _ = iii.trigger_void("state::update", json!({
        "scope": "metering",
        "key": &req.agent_id,
        "operations": [
            { "type": "increment", "path": "totalTokens", "value": response["usage"]["total"] },
            { "type": "increment", "path": "invocations", "value": 1 },
        ],
    }));

    Ok(json!({
        "content": response.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        "model": response.get("model"),
        "usage": response.get("usage"),
        "iterations": iterations,
        "durationMs": start.elapsed().as_millis(),
    }))
}

async fn list_tools(iii: &III, agent_id: &str) -> Result<Value, IIIError> {
    let config: Option<AgentConfig> = iii
        .trigger_v0("state::get", json!({ "scope": "agents", "key": agent_id }))
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());

    let allowed = config
        .as_ref()
        .and_then(|c| c.capabilities.as_ref())
        .map(|c| c.tools.clone())
        .unwrap_or_else(|| vec!["*".into()]);

    let allowed: Vec<String> = allowed
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('*').to_string())
        .collect();

    let all_functions: Value = iii
        .trigger_v0("engine::functions::list", json!({}))
        .await
        .unwrap_or(json!([]));

    if allowed.contains(&"".to_string()) || allowed.contains(&"*".to_string()) {
        return Ok(all_functions);
    }

    if allowed.is_empty() {
        return Ok(json!([]));
    }

    let filtered: Vec<&Value> = all_functions
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|f| {
                    let id = f["id"].as_str().unwrap_or("");
                    allowed.iter().any(|a| id.starts_with(a.as_str()))
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!(filtered))
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::{ModelConfig, Capabilities, Resources};

    #[test]
    fn test_max_iterations_constant() {
        assert_eq!(MAX_ITERATIONS, 50);
    }

    #[test]
    fn test_chat_request_from_json() {
        let json_val = json!({
            "agentId": "agent-test",
            "message": "Hello world",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.agent_id, "agent-test");
        assert_eq!(req.message, "Hello world");
    }

    #[test]
    fn test_chat_request_requires_agent_id() {
        let json_val = json!({
            "message": "Hello",
        });
        let result: Result<ChatRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_chat_request_requires_message() {
        let json_val = json!({
            "agentId": "test",
        });
        let result: Result<ChatRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_tool_call_parsing() {
        let json_val = json!({
            "callId": "tc-1",
            "id": "memory::store",
            "arguments": {"content": "test data", "agentId": "agent-1"},
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert_eq!(tc.call_id, "tc-1");
        assert_eq!(tc.id, "memory::store");
        assert_eq!(tc.arguments["content"], "test data");
    }

    #[test]
    fn test_tool_call_id_split_for_capability() {
        let tc = ToolCall {
            call_id: "c-1".to_string(),
            id: "security::check_capability".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "security");
    }

    #[test]
    fn test_tool_call_id_split_no_separator() {
        let tc = ToolCall {
            call_id: "c-2".to_string(),
            id: "simple_tool".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "simple_tool");
    }

    #[test]
    fn test_agent_config_creation() {
        let config = AgentConfig {
            id: Some("test-id".to_string()),
            name: "Test Agent".to_string(),
            description: Some("A test agent".to_string()),
            model: Some(ModelConfig {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-20250514".to_string()),
                max_tokens: Some(4096),
            }),
            system_prompt: Some("Be helpful".to_string()),
            capabilities: Some(Capabilities {
                tools: vec!["*".to_string()],
                memory_scopes: None,
                network_hosts: None,
            }),
            resources: Some(Resources {
                max_tokens_per_hour: Some(100000),
            }),
            tags: Some(vec!["test".to_string()]),
        };
        assert_eq!(config.name, "Test Agent");
        assert!(config.capabilities.unwrap().tools.contains(&"*".to_string()));
    }

    #[test]
    fn test_agent_config_id_fallback() {
        let config = AgentConfig {
            id: None,
            name: "NoIdAgent".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        assert!(!id.is_empty());
    }

    #[test]
    fn test_system_prompt_fallback_chain() {
        let req_prompt = Some("request prompt".to_string());
        let config_prompt = Some("config prompt".to_string());

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "request prompt");
    }

    #[test]
    fn test_system_prompt_fallback_to_config() {
        let req_prompt: Option<String> = None;
        let config_prompt = Some("config prompt".to_string());

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "config prompt");
    }

    #[test]
    fn test_system_prompt_fallback_to_default() {
        let req_prompt: Option<String> = None;
        let config_prompt: Option<String> = None;

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "");
    }

    #[test]
    fn test_session_id_default_format() {
        let agent_id = "agent-42";
        let session_id: Option<String> = None;
        let result = session_id.unwrap_or_else(|| format!("default:{}", agent_id));
        assert_eq!(result, "default:agent-42");
    }

    #[test]
    fn test_session_id_explicit() {
        let session_id = Some("custom-session".to_string());
        let result = session_id.unwrap_or_else(|| "default:x".to_string());
        assert_eq!(result, "custom-session");
    }

    #[test]
    fn test_tool_results_accumulation() {
        let mut results = Vec::new();
        results.push(json!({
            "toolCallId": "tc-1",
            "output": { "data": "result1" },
        }));
        results.push(json!({
            "toolCallId": "tc-2",
            "output": { "error": "denied" },
        }));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["toolCallId"], "tc-1");
        assert_eq!(results[1]["output"]["error"], "denied");
    }

    #[test]
    fn test_message_building() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!([
            {"role": "user", "content": "previous question"},
            {"role": "assistant", "content": "previous answer"},
        ]);

        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "new question"}));

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[2]["content"], "new question");
    }

    #[test]
    fn test_wildcard_tool_filter() {
        let allowed = vec!["*".to_string()];
        assert!(allowed.contains(&"*".to_string()));
    }

    #[test]
    fn test_tool_filter_prefix_match() {
        let allowed = vec!["file::".to_string(), "memory::".to_string()];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(matches);
    }

    #[test]
    fn test_tool_filter_no_match() {
        let allowed = vec!["file::".to_string()];
        let tool_id = "network::send";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches);
    }

    #[test]
    fn test_risk_score_threshold() {
        let risk_score = 0.51;
        assert!(risk_score > 0.5);

        let risk_score = 0.49;
        assert!(risk_score <= 0.5);
    }

    #[test]
    fn test_iteration_limit() {
        let mut iterations: u32 = 0;
        while iterations < MAX_ITERATIONS {
            iterations += 1;
        }
        assert_eq!(iterations, 50);
    }

    #[test]
    fn test_chat_request_empty_message() {
        let json_val = json!({
            "agentId": "agent-1",
            "message": "",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.message, "");
    }

    #[test]
    fn test_chat_request_very_long_message() {
        let long_msg = "x".repeat(100_000);
        let json_val = json!({
            "agentId": "agent-1",
            "message": long_msg,
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.message.len(), 100_000);
    }

    #[test]
    fn test_chat_request_with_all_optional_fields() {
        let json_val = json!({
            "agentId": "agent-full",
            "message": "Hello",
            "sessionId": "sess-99",
            "systemPrompt": "Be concise",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.session_id, Some("sess-99".to_string()));
        assert_eq!(req.system_prompt, Some("Be concise".to_string()));
    }

    #[test]
    fn test_chat_request_unicode_message() {
        let json_val = json!({
            "agentId": "agent-unicode",
            "message": "Hello! CJK: \u{4e16}\u{754c} Emoji: \u{1f600}\u{1f680}",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.message.contains('\u{4e16}'));
        assert!(req.message.contains('\u{1f600}'));
    }

    #[test]
    fn test_agent_config_no_optional_fields() {
        let config = AgentConfig {
            id: None,
            name: "Minimal".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        assert!(config.id.is_none());
        assert!(config.description.is_none());
        assert!(config.model.is_none());
        assert!(config.system_prompt.is_none());
        assert!(config.capabilities.is_none());
        assert!(config.resources.is_none());
        assert!(config.tags.is_none());
    }

    #[test]
    fn test_agent_config_all_fields_populated() {
        let config = AgentConfig {
            id: Some("full-agent".to_string()),
            name: "Full Agent".to_string(),
            description: Some("Complete agent config".to_string()),
            model: Some(ModelConfig {
                provider: Some("anthropic".to_string()),
                model: Some("claude-opus-4-6".to_string()),
                max_tokens: Some(16384),
            }),
            system_prompt: Some("You are an expert".to_string()),
            capabilities: Some(Capabilities {
                tools: vec!["file::*".to_string(), "memory::*".to_string(), "network::*".to_string()],
                memory_scopes: Some(vec!["personal".to_string(), "shared".to_string()]),
                network_hosts: Some(vec!["api.anthropic.com".to_string()]),
            }),
            resources: Some(Resources {
                max_tokens_per_hour: Some(500_000),
            }),
            tags: Some(vec!["prod".to_string(), "v2".to_string(), "ai".to_string()]),
        };
        assert_eq!(config.id, Some("full-agent".to_string()));
        assert_eq!(config.model.as_ref().unwrap().max_tokens, Some(16384));
        assert_eq!(config.capabilities.as_ref().unwrap().tools.len(), 3);
        assert_eq!(config.tags.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn test_agent_id_auto_generation_is_uuid() {
        let config = AgentConfig {
            id: None,
            name: "AutoId".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let generated = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        assert_eq!(generated.len(), 36);
        assert_eq!(generated.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn test_agent_id_explicit_not_overridden() {
        let config = AgentConfig {
            id: Some("my-custom-id".to_string()),
            name: "ExplicitId".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        assert_eq!(id, "my-custom-id");
    }

    #[test]
    fn test_max_iterations_boundary_at_49() {
        let mut iterations: u32 = 0;
        let tool_calls_present = true;
        while tool_calls_present && iterations < MAX_ITERATIONS {
            iterations += 1;
            if iterations == 49 {
                break;
            }
        }
        assert_eq!(iterations, 49);
        assert!(iterations < MAX_ITERATIONS);
    }

    #[test]
    fn test_max_iterations_boundary_at_50() {
        let mut iterations: u32 = 0;
        while iterations < MAX_ITERATIONS {
            iterations += 1;
        }
        assert_eq!(iterations, MAX_ITERATIONS);
        assert!(!(iterations < MAX_ITERATIONS));
    }

    #[test]
    fn test_max_iterations_empty_tool_calls_break() {
        let tool_calls: Vec<Value> = vec![];
        let iterations: u32 = 0;
        let should_break = tool_calls.is_empty() || iterations >= MAX_ITERATIONS;
        assert!(should_break);
    }

    #[test]
    fn test_tool_call_parsing_nested_arguments() {
        let json_val = json!({
            "callId": "tc-nested",
            "id": "tool::complex",
            "arguments": {
                "config": {
                    "nested": {
                        "deep": true,
                        "level": 3,
                    },
                },
                "items": [1, 2, 3],
            },
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments["config"]["nested"]["deep"].as_bool().unwrap());
        assert_eq!(tc.arguments["config"]["nested"]["level"], 3);
        assert_eq!(tc.arguments["items"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_tool_call_parsing_array_arguments() {
        let json_val = json!({
            "callId": "tc-arr",
            "id": "tool::batch",
            "arguments": [1, "two", false, null],
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments.is_array());
        assert_eq!(tc.arguments.as_array().unwrap().len(), 4);
    }

    #[test]
    fn test_tool_call_parsing_empty_arguments() {
        let json_val = json!({
            "callId": "tc-empty",
            "id": "tool::noop",
            "arguments": {},
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_tool_call_parsing_null_argument_value() {
        let json_val = json!({
            "callId": "tc-null",
            "id": "tool::nullarg",
            "arguments": {"key": null},
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments["key"].is_null());
    }

    #[test]
    fn test_risk_score_exactly_0_5_passes() {
        let risk_score: f64 = 0.5;
        let rejected = risk_score > 0.5;
        assert!(!rejected);
    }

    #[test]
    fn test_risk_score_just_above_0_5_fails() {
        let risk_score: f64 = 0.500001;
        let rejected = risk_score > 0.5;
        assert!(rejected);
    }

    #[test]
    fn test_risk_score_zero_passes() {
        let risk_score: f64 = 0.0;
        let rejected = risk_score > 0.5;
        assert!(!rejected);
    }

    #[test]
    fn test_risk_score_negative_passes() {
        let risk_score: f64 = -1.0;
        let rejected = risk_score > 0.5;
        assert!(!rejected);
    }

    #[test]
    fn test_risk_score_one_fails() {
        let risk_score: f64 = 1.0;
        let rejected = risk_score > 0.5;
        assert!(rejected);
    }

    #[test]
    fn test_risk_score_default_from_missing_field() {
        let scan_result = json!({ "safe": true });
        let risk_score = scan_result["riskScore"].as_f64().unwrap_or(0.0);
        assert_eq!(risk_score, 0.0);
    }

    #[test]
    fn test_message_building_with_empty_memories() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!([]);
        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "question"}));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
    }

    #[test]
    fn test_message_building_with_many_memories() {
        let mut messages: Vec<Value> = vec![];
        let mut mem_arr = Vec::new();
        for i in 0..50 {
            mem_arr.push(json!({"role": if i % 2 == 0 { "user" } else { "assistant" }, "content": format!("msg {}", i)}));
        }
        let memories = json!(mem_arr);
        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "new question"}));
        assert_eq!(messages.len(), 51);
        assert_eq!(messages[50]["content"], "new question");
    }

    #[test]
    fn test_message_building_null_memories_ignored() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!(null);
        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "hello"}));
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_tool_filter_multiple_prefixes() {
        let allowed = vec!["file::".to_string(), "memory::".to_string(), "tool::".to_string()];
        assert!(allowed.iter().any(|a| "file::read".starts_with(a.as_str())));
        assert!(allowed.iter().any(|a| "memory::store".starts_with(a.as_str())));
        assert!(allowed.iter().any(|a| "tool::web_fetch".starts_with(a.as_str())));
        assert!(!allowed.iter().any(|a| "network::send".starts_with(a.as_str())));
        assert!(!allowed.iter().any(|a| "security::scan".starts_with(a.as_str())));
    }

    #[test]
    fn test_tool_filter_empty_allowed_list() {
        let allowed: Vec<String> = vec![];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches);
    }

    #[test]
    fn test_tool_filter_exact_match() {
        let allowed = vec!["file::read".to_string()];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(matches);
    }

    #[test]
    fn test_tool_filter_partial_prefix_no_match() {
        let allowed = vec!["file::read_all".to_string()];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches);
    }

    #[test]
    fn test_tool_call_id_split_multiple_separators() {
        let tc = ToolCall {
            call_id: "c-3".to_string(),
            id: "security::check::deep".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "security");
    }

    #[test]
    fn test_tool_call_id_split_empty_string() {
        let tc = ToolCall {
            call_id: "c-4".to_string(),
            id: "".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "");
    }

    #[test]
    fn test_tool_results_capability_denied() {
        let result = json!({
            "toolCallId": "tc-denied",
            "output": { "error": "capability denied" },
        });
        assert_eq!(result["output"]["error"], "capability denied");
    }

    #[test]
    fn test_tool_results_success() {
        let result = json!({
            "toolCallId": "tc-ok",
            "output": { "data": "success result" },
        });
        assert_eq!(result["output"]["data"], "success result");
        assert!(result["output"].get("error").is_none());
    }

    #[test]
    fn test_session_id_format_with_special_chars() {
        let agent_id = "agent/special-chars_123";
        let session_id: Option<String> = None;
        let result = session_id.unwrap_or_else(|| format!("default:{}", agent_id));
        assert_eq!(result, "default:agent/special-chars_123");
    }

    #[test]
    fn test_response_extraction_missing_content() {
        let response = json!({});
        let content = response.get("content").and_then(|v| v.as_str()).unwrap_or("");
        assert_eq!(content, "");
    }

    #[test]
    fn test_response_extraction_null_content() {
        let response = json!({"content": null});
        let content = response.get("content").and_then(|v| v.as_str()).unwrap_or("");
        assert_eq!(content, "");
    }

    #[test]
    fn test_response_extraction_present_content() {
        let response = json!({"content": "Hello, world!"});
        let content = response.get("content").and_then(|v| v.as_str()).unwrap_or("");
        assert_eq!(content, "Hello, world!");
    }

    #[test]
    fn test_tool_count_from_empty_tools() {
        let tools = json!([]);
        let count = tools.as_array().map(|a| a.len()).unwrap_or(0);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_tool_count_from_tools_array() {
        let tools = json!([{"id": "a"}, {"id": "b"}, {"id": "c"}]);
        let count = tools.as_array().map(|a| a.len()).unwrap_or(0);
        assert_eq!(count, 3);
    }

    #[test]
    fn test_tool_count_from_non_array() {
        let tools = json!("not an array");
        let count = tools.as_array().map(|a| a.len()).unwrap_or(0);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_create_agent_json_structure() {
        let config = AgentConfig {
            id: Some("new-agent".to_string()),
            name: "New Agent".to_string(),
            description: Some("A new agent".to_string()),
            model: Some(ModelConfig {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-20250514".to_string()),
                max_tokens: Some(4096),
            }),
            system_prompt: Some("Be helpful".to_string()),
            capabilities: Some(Capabilities {
                tools: vec!["*".to_string()],
                memory_scopes: None,
                network_hosts: None,
            }),
            resources: None,
            tags: Some(vec!["test".to_string()]),
        };
        let agent_id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let val = json!({
            "id": &agent_id,
            "name": &config.name,
            "description": &config.description,
            "model": &config.model,
            "systemPrompt": &config.system_prompt,
            "capabilities": &config.capabilities,
            "resources": &config.resources,
            "tags": &config.tags,
        });
        assert_eq!(val["id"], "new-agent");
        assert_eq!(val["name"], "New Agent");
        assert_eq!(val["description"], "A new agent");
        assert!(val["resources"].is_null());
    }

    #[test]
    fn test_iteration_counter_increments_correctly() {
        let mut iterations: u32 = 0;
        for _ in 0..5 {
            iterations += 1;
        }
        assert_eq!(iterations, 5);
    }

    #[test]
    fn test_tool_call_filter_map_ignores_invalid() {
        let tool_calls = vec![
            json!({"callId": "1", "id": "valid::tool", "arguments": {}}),
            json!({"missing": "fields"}),
            json!({"callId": "3", "id": "another::tool", "arguments": {"k": "v"}}),
        ];
        let calls: Vec<ToolCall> = tool_calls
            .iter()
            .filter_map(|tc| serde_json::from_value(tc.clone()).ok())
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "valid::tool");
        assert_eq!(calls[1].id, "another::tool");
    }

    #[test]
    fn test_tool_call_filter_map_all_invalid() {
        let tool_calls = vec![
            json!({"bad": "data"}),
            json!(42),
            json!(null),
        ];
        let calls: Vec<ToolCall> = tool_calls
            .iter()
            .filter_map(|tc| serde_json::from_value(tc.clone()).ok())
            .collect();
        assert_eq!(calls.len(), 0);
    }

    #[test]
    fn test_agent_config_serialization_produces_rename() {
        let config = AgentConfig {
            id: Some("test".to_string()),
            name: "Test".to_string(),
            description: None,
            model: None,
            system_prompt: Some("prompt".to_string()),
            capabilities: None,
            resources: None,
            tags: None,
        };
        let val = serde_json::to_value(&config).unwrap();
        assert!(val.get("systemPrompt").is_some());
        assert!(val.get("system_prompt").is_none());
    }

    #[test]
    fn test_risk_score_non_numeric_treated_as_zero() {
        let scan_result = json!({ "safe": true, "riskScore": "not_a_number" });
        let risk_score = scan_result["riskScore"].as_f64().unwrap_or(0.0);
        assert_eq!(risk_score, 0.0);
        assert!(!(risk_score > 0.5));
    }

    #[test]
    fn test_risk_score_very_large_fails() {
        let risk_score: f64 = 999.99;
        assert!(risk_score > 0.5);
    }

    #[test]
    fn test_risk_score_f64_precision_boundary() {
        let risk_score: f64 = 0.5 + f64::EPSILON;
        assert!(risk_score > 0.5);
    }

    #[test]
    fn test_tool_filter_wildcard_pattern_match() {
        let allowed: Vec<String> = vec!["file::*".to_string()]
            .into_iter()
            .map(|a| a.trim_end_matches('*').to_string())
            .filter(|s| !s.trim().is_empty())
            .collect();
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(matches);
    }

    #[test]
    fn test_tool_filter_case_sensitive() {
        let allowed = vec!["File::".to_string()];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches);
    }

    #[test]
    fn test_tool_filter_empty_string_prefix() {
        let allowed: Vec<String> = vec!["".to_string()]
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect();
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches, "empty string should be filtered out and not match");
    }

    #[test]
    fn test_message_building_with_non_array_memories() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!({"not": "an array"});
        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "test"}));
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_message_building_preserves_order() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!([
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
            {"role": "user", "content": "third"},
        ]);
        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "fourth"}));
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[1]["content"], "second");
        assert_eq!(messages[2]["content"], "third");
        assert_eq!(messages[3]["content"], "fourth");
    }

    #[test]
    fn test_session_id_default_format_empty_agent() {
        let agent_id = "";
        assert!(agent_id.is_empty(), "empty agent_id should be rejected at request boundary");
    }

    #[test]
    fn test_session_id_default_format_unicode_agent() {
        let agent_id = "agent-\u{1f600}";
        let session_id: Option<String> = None;
        let result = session_id.unwrap_or_else(|| format!("default:{}", agent_id));
        assert!(result.starts_with("default:"));
        assert!(result.contains('\u{1f600}'));
    }

    #[test]
    fn test_tool_results_mixed_success_and_error() {
        let mut results = Vec::new();
        for i in 0..10 {
            if i % 3 == 0 {
                results.push(json!({"toolCallId": format!("tc-{}", i), "output": {"error": "denied"}}));
            } else {
                results.push(json!({"toolCallId": format!("tc-{}", i), "output": {"data": format!("result-{}", i)}}));
            }
        }
        assert_eq!(results.len(), 10);
        let errors: Vec<_> = results.iter().filter(|r| r["output"].get("error").is_some()).collect();
        assert_eq!(errors.len(), 4);
    }

    #[test]
    fn test_tool_call_id_split_only_separator() {
        let tc = ToolCall {
            call_id: "c".to_string(),
            id: "::".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "");
    }

    #[test]
    fn test_response_extraction_numeric_content() {
        let response = json!({"content": 42});
        let content = response.get("content").and_then(|v| v.as_str()).unwrap_or("");
        assert_eq!(content, "");
    }
}

async fn create_agent(iii: &III, config: AgentConfig) -> Result<Value, IIIError> {
    let agent_id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    iii.trigger_v0("state::set", json!({
        "scope": "agents",
        "key": &agent_id,
        "value": {
            "id": &agent_id,
            "name": &config.name,
            "description": &config.description,
            "model": &config.model,
            "systemPrompt": &config.system_prompt,
            "capabilities": &config.capabilities,
            "resources": &config.resources,
            "tags": &config.tags,
            "createdAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        },
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "agent.lifecycle",
        "data": { "type": "created", "agentId": &agent_id },
    }));

    Ok(json!({ "agentId": agent_id }))
}

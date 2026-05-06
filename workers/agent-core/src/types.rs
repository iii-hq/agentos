use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatRequest {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub message: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FunctionCall {
    #[serde(rename = "callId")]
    pub call_id: String,
    pub id: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub model: Option<ModelConfig>,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: Option<String>,
    pub capabilities: Option<Capabilities>,
    pub resources: Option<Resources>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "maxTokens")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Capabilities { 
    pub functions: Vec<String>,
    #[serde(rename = "memoryScopes")]
    pub memory_scopes: Option<Vec<String>>,
    #[serde(rename = "networkHosts")]
    pub network_hosts: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Resources {
    #[serde(rename = "maxTokensPerHour")]
    pub max_tokens_per_hour: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_chat_request_deserialization() {
        let json_val = json!({
            "agentId": "agent-1",
            "message": "Hello",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.agent_id, "agent-1");
        assert_eq!(req.message, "Hello");
        assert!(req.session_id.is_none());
        assert!(req.system_prompt.is_none());
    }

    #[test]
    fn test_chat_request_with_optional_fields() {
        let json_val = json!({
            "agentId": "agent-2",
            "message": "Hi there",
            "sessionId": "sess-42",
            "systemPrompt": "You are a helpful assistant",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.session_id, Some("sess-42".to_string()));
        assert_eq!(req.system_prompt, Some("You are a helpful assistant".to_string()));
    }

    #[test]
    fn test_chat_request_serialization() {
        let req = ChatRequest {
            agent_id: "a-1".to_string(),
            message: "test".to_string(),
            session_id: Some("s-1".to_string()),
            system_prompt: None,
        };
        let val = serde_json::to_value(&req).unwrap();
        assert_eq!(val["agentId"], "a-1");
        assert_eq!(val["message"], "test");
        assert_eq!(val["sessionId"], "s-1");
        assert!(val["systemPrompt"].is_null());
    }

    #[test]
    fn test_tool_call_deserialization() {
        let json_val = json!({
            "callId": "call-1",
            "id": "memory::recall",
            "arguments": {"query": "test"},
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert_eq!(tc.call_id, "call-1");
        assert_eq!(tc.id, "memory::recall");
        assert_eq!(tc.arguments["query"], "test");
    }

    #[test]
    fn test_tool_call_serialization() {
        let tc = FunctionCall {
            call_id: "c-1".to_string(),
            id: "file::read".to_string(),
            arguments: json!({"path": "/tmp/file.txt"}),
        };
        let val = serde_json::to_value(&tc).unwrap();
        assert_eq!(val["callId"], "c-1");
        assert_eq!(val["id"], "file::read");
    }

    #[test]
    fn test_agent_config_minimal() {
        let json_val = json!({
            "name": "TestAgent",
        });
        let config: AgentConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.name, "TestAgent");
        assert!(config.id.is_none());
        assert!(config.description.is_none());
        assert!(config.model.is_none());
        assert!(config.system_prompt.is_none());
        assert!(config.capabilities.is_none());
        assert!(config.resources.is_none());
        assert!(config.tags.is_none());
    }

    #[test]
    fn test_agent_config_full() {
        let json_val = json!({
            "id": "agent-full",
            "name": "FullAgent",
            "description": "A fully configured agent",
            "model": {
                "provider": "anthropic",
                "model": "claude-sonnet-4-20250514",
                "maxTokens": 4096,
            },
            "systemPrompt": "Be helpful",
            "capabilities": {
                "functions": ["file::*", "memory::*"],
                "memoryScopes": ["default"],
                "networkHosts": ["api.example.com"],
            },
            "resources": {
                "maxTokensPerHour": 100000,
            },
            "tags": ["production", "chat"],
        });
        let config: AgentConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.id, Some("agent-full".to_string()));
        assert_eq!(config.description, Some("A fully configured agent".to_string()));
        let model = config.model.unwrap();
        assert_eq!(model.provider, Some("anthropic".to_string()));
        assert_eq!(model.max_tokens, Some(4096));
        let caps = config.capabilities.unwrap();
        assert_eq!(caps.functions, vec!["file::*", "memory::*"]);
        assert_eq!(caps.memory_scopes, Some(vec!["default".to_string()]));
        let resources = config.resources.unwrap();
        assert_eq!(resources.max_tokens_per_hour, Some(100000));
        assert_eq!(config.tags, Some(vec!["production".to_string(), "chat".to_string()]));
    }

    #[test]
    fn test_model_config_deserialization() {
        let json_val = json!({
            "provider": "openai",
            "model": "gpt-4o",
            "maxTokens": 8192,
        });
        let mc: ModelConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(mc.provider, Some("openai".to_string()));
        assert_eq!(mc.model, Some("gpt-4o".to_string()));
        assert_eq!(mc.max_tokens, Some(8192));
    }

    #[test]
    fn test_model_config_optional_fields() {
        let json_val = json!({});
        let mc: ModelConfig = serde_json::from_value(json_val).unwrap();
        assert!(mc.provider.is_none());
        assert!(mc.model.is_none());
        assert!(mc.max_tokens.is_none());
    }

    #[test]
    fn test_capabilities_deserialization() {
        let json_val = json!({
            "functions": ["*"],
        });
        let caps: Capabilities = serde_json::from_value(json_val).unwrap();
        assert_eq!(caps.functions, vec!["*"]);
        assert!(caps.memory_scopes.is_none());
        assert!(caps.network_hosts.is_none());
    }

    #[test]
    fn test_capabilities_with_all_fields() {
        let json_val = json!({
            "functions": ["file::read", "memory::recall"],
            "memoryScopes": ["personal", "shared"],
            "networkHosts": ["api.anthropic.com"],
        });
        let caps: Capabilities = serde_json::from_value(json_val).unwrap();
        assert_eq!(caps.functions.len(), 2);
        assert_eq!(caps.memory_scopes.as_ref().unwrap().len(), 2);
        assert_eq!(caps.network_hosts.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_resources_deserialization() {
        let json_val = json!({ "maxTokensPerHour": 50000 });
        let res: Resources = serde_json::from_value(json_val).unwrap();
        assert_eq!(res.max_tokens_per_hour, Some(50000));
    }

    #[test]
    fn test_resources_optional() {
        let json_val = json!({});
        let res: Resources = serde_json::from_value(json_val).unwrap();
        assert!(res.max_tokens_per_hour.is_none());
    }

    #[test]
    fn test_chat_request_roundtrip() {
        let req = ChatRequest {
            agent_id: "a1".to_string(),
            message: "hello".to_string(),
            session_id: Some("s1".to_string()),
            system_prompt: Some("prompt".to_string()),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let roundtripped: ChatRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(roundtripped.agent_id, req.agent_id);
        assert_eq!(roundtripped.message, req.message);
        assert_eq!(roundtripped.session_id, req.session_id);
        assert_eq!(roundtripped.system_prompt, req.system_prompt);
    }

    #[test]
    fn test_agent_config_clone() {
        let config = AgentConfig {
            id: Some("clone-test".to_string()),
            name: "CloneAgent".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let cloned = config.clone();
        assert_eq!(cloned.id, config.id);
        assert_eq!(cloned.name, config.name);
    }

    #[test]
    fn test_tool_call_empty_arguments() {
        let json_val = json!({
            "callId": "c-2",
            "id": "system::status",
            "arguments": {},
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments.is_object());
        assert!(tc.arguments.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_agent_config_empty_functions() {
        let json_val = json!({
            "name": "NoTools",
            "capabilities": { "functions": [] },
        });
        let config: AgentConfig = serde_json::from_value(json_val).unwrap();
        assert!(config.capabilities.unwrap().functions.is_empty());
    }

    #[test]
    fn test_agent_config_with_tags() {
        let json_val = json!({
            "name": "Tagged",
            "tags": ["prod", "v2", "ai"],
        });
        let config: AgentConfig = serde_json::from_value(json_val).unwrap();
        let tags = config.tags.unwrap();
        assert_eq!(tags.len(), 3);
        assert!(tags.contains(&"prod".to_string()));
    }

    #[test]
    fn test_agent_config_no_tags() {
        let json_val = json!({"name": "NoTags"});
        let config: AgentConfig = serde_json::from_value(json_val).unwrap();
        assert!(config.tags.is_none());
    }

    #[test]
    fn test_agent_config_full_roundtrip() {
        let config = AgentConfig {
            id: Some("rt-1".to_string()),
            name: "Roundtrip".to_string(),
            description: Some("Test roundtrip".to_string()),
            model: Some(ModelConfig {
                provider: Some("openai".to_string()),
                model: Some("gpt-4".to_string()),
                max_tokens: Some(2048),
            }),
            system_prompt: Some("Be precise".to_string()),
            capabilities: Some(Capabilities {
                functions: vec!["file::*".to_string()],
                memory_scopes: Some(vec!["self".to_string()]),
                network_hosts: Some(vec!["api.openai.com".to_string()]),
            }),
            resources: Some(Resources {
                max_tokens_per_hour: Some(50000),
            }),
            tags: Some(vec!["test".to_string()]),
        };
        let json_str = serde_json::to_string(&config).unwrap();
        let rt: AgentConfig = serde_json::from_str(&json_str).unwrap();
        assert_eq!(rt.name, "Roundtrip");
        assert_eq!(rt.model.as_ref().unwrap().provider.as_deref(), Some("openai"));
    }

    #[test]
    fn test_chat_request_minimal() {
        let json_val = json!({"agentId": "min", "message": "hi"});
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.session_id.is_none());
        assert!(req.system_prompt.is_none());
    }

    #[test]
    fn test_tool_call_nested_arguments() {
        let json_val = json!({
            "callId": "c-nested",
            "id": "fn::complex",
            "arguments": {
                "config": {"nested": true, "depth": 3},
                "items": [1, 2, 3],
            },
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments["config"]["nested"].as_bool().unwrap());
    }

    #[test]
    fn test_tool_call_roundtrip() {
        let tc = FunctionCall {
            call_id: "rt-call".to_string(),
            id: "memory::store".to_string(),
            arguments: json!({"agentId": "a1", "content": "data"}),
        };
        let json_str = serde_json::to_string(&tc).unwrap();
        let rt: FunctionCall = serde_json::from_str(&json_str).unwrap();
        assert_eq!(rt.call_id, "rt-call");
        assert_eq!(rt.id, "memory::store");
    }

    #[test]
    fn test_model_config_full() {
        let json_val = json!({
            "provider": "anthropic",
            "model": "claude-opus-4-6",
            "maxTokens": 16384,
        });
        let mc: ModelConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(mc.provider.as_deref(), Some("anthropic"));
        assert_eq!(mc.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(mc.max_tokens, Some(16384));
    }

    #[test]
    fn test_capabilities_wildcard_functions() {
        let caps = Capabilities {
            functions: vec!["*".to_string()],
            memory_scopes: None,
            network_hosts: None,
        };
        assert!(caps.functions.contains(&"*".to_string()));
    }

    #[test]
    fn test_capabilities_multiple_network_hosts() {
        let json_val = json!({
            "functions": ["*"],
            "networkHosts": ["api.anthropic.com", "api.openai.com", "*.example.com"],
        });
        let caps: Capabilities = serde_json::from_value(json_val).unwrap();
        assert_eq!(caps.network_hosts.unwrap().len(), 3);
    }

    #[test]
    fn test_resources_zero_tokens() {
        let json_val = json!({"maxTokensPerHour": 0});
        let res: Resources = serde_json::from_value(json_val).unwrap();
        assert_eq!(res.max_tokens_per_hour, Some(0));
    }

    #[test]
    fn test_agent_config_debug_trait() {
        let config = AgentConfig {
            id: None,
            name: "Debug".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let debug_str = format!("{:?}", config);
        assert!(debug_str.contains("Debug"));
    }

    #[test]
    fn test_chat_request_unicode_cjk() {
        let json_val = json!({
            "agentId": "agent-cjk",
            "message": "\u{4f60}\u{597d}\u{4e16}\u{754c}",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.message, "\u{4f60}\u{597d}\u{4e16}\u{754c}");
    }

    #[test]
    fn test_chat_request_unicode_emoji() {
        let json_val = json!({
            "agentId": "agent-emoji",
            "message": "\u{1f680}\u{1f4a5}\u{2728}",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.message.contains('\u{1f680}'));
    }

    #[test]
    fn test_chat_request_empty_agent_id() {
        let json_val = json!({
            "agentId": "",
            "message": "hello",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.agent_id, "");
    }

    #[test]
    fn test_chat_request_very_long_agent_id() {
        let long_id = "x".repeat(10_000);
        let json_val = json!({
            "agentId": long_id,
            "message": "test",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.agent_id.len(), 10_000);
    }

    #[test]
    fn test_chat_request_empty_strings() {
        let req = ChatRequest {
            agent_id: "".to_string(),
            message: "".to_string(),
            session_id: Some("".to_string()),
            system_prompt: Some("".to_string()),
        };
        let val = serde_json::to_value(&req).unwrap();
        assert_eq!(val["agentId"], "");
        assert_eq!(val["message"], "");
        assert_eq!(val["sessionId"], "");
        assert_eq!(val["systemPrompt"], "");
    }

    #[test]
    fn test_tool_call_null_arguments() {
        let json_val = json!({
            "callId": "c-null",
            "id": "fn::test",
            "arguments": null,
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments.is_null());
    }

    #[test]
    fn test_tool_call_array_arguments() {
        let json_val = json!({
            "callId": "c-arr",
            "id": "fn::batch",
            "arguments": [1, "two", false, null, [3, 4]],
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert!(tc.arguments.is_array());
        assert_eq!(tc.arguments.as_array().unwrap().len(), 5);
    }

    #[test]
    fn test_tool_call_deeply_nested_arguments() {
        let json_val = json!({
            "callId": "c-deep",
            "id": "fn::deep",
            "arguments": {
                "a": {"b": {"c": {"d": {"e": "bottom"}}}}
            },
        });
        let tc: FunctionCall = serde_json::from_value(json_val).unwrap();
        assert_eq!(tc.arguments["a"]["b"]["c"]["d"]["e"], "bottom");
    }

    #[test]
    fn test_agent_config_serialization_renames_system_prompt() {
        let config = AgentConfig {
            id: None,
            name: "RenameTest".to_string(),
            description: None,
            model: None,
            system_prompt: Some("test prompt".to_string()),
            capabilities: None,
            resources: None,
            tags: None,
        };
        let val = serde_json::to_value(&config).unwrap();
        assert!(val.get("systemPrompt").is_some());
        assert!(val.get("system_prompt").is_none());
        assert_eq!(val["systemPrompt"], "test prompt");
    }

    #[test]
    fn test_agent_config_serialization_renames_all_fields() {
        let config = AgentConfig {
            id: Some("x".to_string()),
            name: "Full".to_string(),
            description: Some("desc".to_string()),
            model: Some(ModelConfig {
                provider: Some("p".to_string()),
                model: Some("m".to_string()),
                max_tokens: Some(100),
            }),
            system_prompt: Some("sp".to_string()),
            capabilities: Some(Capabilities {
                functions: vec!["t".to_string()],
                memory_scopes: Some(vec!["s".to_string()]),
                network_hosts: Some(vec!["h".to_string()]),
            }),
            resources: Some(Resources {
                max_tokens_per_hour: Some(999),
            }),
            tags: Some(vec!["tag".to_string()]),
        };
        let json_str = serde_json::to_string(&config).unwrap();
        assert!(json_str.contains("\"systemPrompt\""));
        assert!(!json_str.contains("\"system_prompt\""));
        assert!(json_str.contains("\"maxTokens\""));
        assert!(!json_str.contains("\"max_tokens\""));
        assert!(json_str.contains("\"memoryScopes\""));
        assert!(!json_str.contains("\"memory_scopes\""));
        assert!(json_str.contains("\"networkHosts\""));
        assert!(!json_str.contains("\"network_hosts\""));
        assert!(json_str.contains("\"maxTokensPerHour\""));
        assert!(!json_str.contains("\"max_tokens_per_hour\""));
    }

    #[test]
    fn test_model_config_roundtrip_anthropic() {
        let mc = ModelConfig {
            provider: Some("anthropic".to_string()),
            model: Some("claude-opus-4-6".to_string()),
            max_tokens: Some(16384),
        };
        let s = serde_json::to_string(&mc).unwrap();
        let rt: ModelConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(rt.provider, Some("anthropic".to_string()));
        assert_eq!(rt.model, Some("claude-opus-4-6".to_string()));
        assert_eq!(rt.max_tokens, Some(16384));
    }

    #[test]
    fn test_model_config_roundtrip_openai() {
        let mc = ModelConfig {
            provider: Some("openai".to_string()),
            model: Some("gpt-4o".to_string()),
            max_tokens: Some(128000),
        };
        let s = serde_json::to_string(&mc).unwrap();
        let rt: ModelConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(rt.provider.as_deref(), Some("openai"));
        assert_eq!(rt.model.as_deref(), Some("gpt-4o"));
    }

    #[test]
    fn test_model_config_roundtrip_google() {
        let mc = ModelConfig {
            provider: Some("google".to_string()),
            model: Some("gemini-2.0-flash".to_string()),
            max_tokens: None,
        };
        let s = serde_json::to_string(&mc).unwrap();
        let rt: ModelConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(rt.provider.as_deref(), Some("google"));
        assert!(rt.max_tokens.is_none());
    }

    #[test]
    fn test_capabilities_wildcard_and_specific() {
        let caps = Capabilities {
            functions: vec!["*".to_string(), "file::read".to_string()],
            memory_scopes: None,
            network_hosts: None,
        };
        assert!(caps.functions.contains(&"*".to_string()));
        assert!(caps.functions.contains(&"file::read".to_string()));
        assert_eq!(caps.functions.len(), 2);
    }

    #[test]
    fn test_capabilities_empty_functions_serialization() {
        let caps = Capabilities {
            functions: vec![],
            memory_scopes: Some(vec![]),
            network_hosts: Some(vec![]),
        };
        let val = serde_json::to_value(&caps).unwrap();
        assert!(val["functions"].as_array().unwrap().is_empty());
        assert!(val["memoryScopes"].as_array().unwrap().is_empty());
        assert!(val["networkHosts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_resources_max_u64_value() {
        let json_val = json!({"maxTokensPerHour": u64::MAX});
        let res: Resources = serde_json::from_value(json_val).unwrap();
        assert_eq!(res.max_tokens_per_hour, Some(u64::MAX));
    }

    #[test]
    fn test_resources_roundtrip_zero() {
        let res = Resources {
            max_tokens_per_hour: Some(0),
        };
        let s = serde_json::to_string(&res).unwrap();
        let rt: Resources = serde_json::from_str(&s).unwrap();
        assert_eq!(rt.max_tokens_per_hour, Some(0));
    }

    #[test]
    fn test_resources_roundtrip_none() {
        let res = Resources {
            max_tokens_per_hour: None,
        };
        let s = serde_json::to_string(&res).unwrap();
        let rt: Resources = serde_json::from_str(&s).unwrap();
        assert!(rt.max_tokens_per_hour.is_none());
    }
}

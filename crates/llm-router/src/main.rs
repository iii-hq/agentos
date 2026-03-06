use dashmap::DashMap;
use iii_sdk::error::IIIError;
use iii_sdk::iii::III;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

struct RouterState {
    usage: DashMap<String, Usage>,
    providers: DashMap<String, ProviderConfig>,
}

struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    requests: u64,
}

struct ProviderConfig {
    base_url: String,
    env_key: String,
    driver: Driver,
    models: Vec<String>,
}

#[derive(Clone, Copy)]
enum Driver {
    Anthropic,
    OpenAiCompat,
    Gemini,
    #[allow(dead_code)]
    Bedrock,
}

fn default_providers() -> Vec<(&'static str, &'static str, &'static str, Driver, &'static [&'static str])> {
    vec![
        ("anthropic", "https://api.anthropic.com", "ANTHROPIC_API_KEY", Driver::Anthropic,
         &["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]),
        ("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", Driver::OpenAiCompat,
         &["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"]),
        ("google", "https://generativelanguage.googleapis.com/v1beta", "GOOGLE_API_KEY", Driver::Gemini,
         &["gemini-2.0-flash", "gemini-2.0-pro"]),
        ("groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", Driver::OpenAiCompat,
         &["llama-3.3-70b-versatile", "mixtral-8x7b-32768"]),
        ("together", "https://api.together.xyz/v1", "TOGETHER_API_KEY", Driver::OpenAiCompat,
         &["meta-llama/Llama-3.3-70B-Instruct", "mistralai/Mixtral-8x22B-Instruct-v0.1"]),
        ("deepseek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", Driver::OpenAiCompat,
         &["deepseek-chat", "deepseek-reasoner"]),
        ("mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY", Driver::OpenAiCompat,
         &["mistral-large-latest", "mistral-small-latest"]),
        ("fireworks", "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY", Driver::OpenAiCompat,
         &["accounts/fireworks/models/llama-v3p3-70b-instruct"]),
        ("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", Driver::OpenAiCompat,
         &["anthropic/claude-opus-4-20250514", "google/gemini-2.0-flash-001"]),
        ("ollama", "http://localhost:11434/v1", "", Driver::OpenAiCompat,
         &["llama3.3", "qwen2.5", "deepseek-r1"]),
    ]
}

fn score_complexity(messages: &[Value], tools: &[Value]) -> u32 {
    let mut score: u32 = 0;
    if let Some(last) = messages.last() {
        let content = last["content"].as_str().unwrap_or("");
        score += (content.len() as u32) / 100;
        if content.contains("```") || content.contains("function") || content.contains("class") {
            score += 20;
        }
        if content.contains("analyze") || content.contains("compare") || content.contains("design") {
            score += 15;
        }
    }
    score += (tools.len() as u32) * 5;
    if messages.len() > 10 { score += 10; }
    score
}

fn select_model(complexity: u32, preferred: Option<&str>) -> (&'static str, &'static str) {
    if let Some(p) = preferred {
        match p {
            "opus" | "claude-opus" => return ("anthropic", "claude-opus-4-20250514"),
            "sonnet" | "claude-sonnet" => return ("anthropic", "claude-sonnet-4-20250514"),
            "haiku" | "claude-haiku" => return ("anthropic", "claude-haiku-4-5-20251001"),
            "gpt-4o" => return ("openai", "gpt-4o"),
            "gemini" => return ("google", "gemini-2.0-flash"),
            _ => {}
        }
    }
    match complexity {
        0..=10 => ("anthropic", "claude-haiku-4-5-20251001"),
        11..=40 => ("anthropic", "claude-sonnet-4-20250514"),
        _ => ("anthropic", "claude-opus-4-20250514"),
    }
}

async fn call_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    max_tokens: u64,
) -> Result<Value, IIIError> {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let resp = client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?
        .json::<Value>()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(resp)
}

async fn call_openai_compat(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    max_tokens: u64,
) -> Result<Value, IIIError> {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let mut req = client.post(format!("{}/chat/completions", base_url))
        .header("content-type", "application/json");

    if !api_key.is_empty() {
        req = req.header("authorization", format!("Bearer {}", api_key));
    }

    let resp = req.json(&body)
        .send()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?
        .json::<Value>()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(resp)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");

    let state = Arc::new(RouterState {
        usage: DashMap::new(),
        providers: DashMap::new(),
    });

    for (name, base_url, env_key, driver, models) in default_providers() {
        state.providers.insert(name.to_string(), ProviderConfig {
            base_url: base_url.to_string(),
            env_key: env_key.to_string(),
            driver,
            models: models.iter().map(|s| s.to_string()).collect(),
        });
    }

    let s = state.clone();
    iii.register_function_with_description(
        "llm::route",
        "Route to optimal model based on complexity",
        move |input: Value| {
            let _state = s.clone();
            async move {
                let messages = input["messages"].as_array().cloned().unwrap_or_default();
                let tools = input["tools"].as_array().cloned().unwrap_or_default();
                let preferred = input["model"].as_str();
                let complexity = score_complexity(&messages, &tools);
                let (provider, model) = select_model(complexity, preferred);

                Ok(json!({
                    "provider": provider,
                    "model": model,
                    "complexity": complexity,
                }))
            }
        },
    );

    let shared_client = reqwest::Client::new();

    let s = state.clone();
    let client_for_complete = shared_client.clone();
    iii.register_function_with_description(
        "llm::complete",
        "Send completion request to routed provider",
        move |input: Value| {
            let state = s.clone();
            let client = client_for_complete.clone();
            async move {
                let provider_name = input["provider"].as_str().unwrap_or("anthropic");
                let model = input["model"].as_str().unwrap_or("claude-sonnet-4-20250514");
                let messages = input["messages"].as_array().cloned().unwrap_or_default();
                let tools = input["tools"].as_array().cloned().unwrap_or_default();
                let max_tokens = input["max_tokens"].as_u64().unwrap_or(4096);

                let provider = state.providers.get(provider_name)
                    .ok_or_else(|| IIIError::Handler(format!("unknown provider: {}", provider_name)))?;

                let api_key = if provider.env_key.is_empty() {
                    String::new()
                } else {
                    std::env::var(&provider.env_key).unwrap_or_default()
                };

                let start = Instant::now();

                let result = match provider.driver {
                    Driver::Anthropic => {
                        call_anthropic(&client, &api_key, model, &messages, &tools, max_tokens).await?
                    }
                    Driver::OpenAiCompat | Driver::Gemini | Driver::Bedrock => {
                        call_openai_compat(&client, &provider.base_url, &api_key, model, &messages, &tools, max_tokens).await?
                    }
                };

                let _elapsed_ms = start.elapsed().as_millis() as u64;

                let input_tokens = result["usage"]["input_tokens"].as_u64()
                    .or(result["usage"]["prompt_tokens"].as_u64())
                    .unwrap_or(0);
                let output_tokens = result["usage"]["output_tokens"].as_u64()
                    .or(result["usage"]["completion_tokens"].as_u64())
                    .unwrap_or(0);

                let key = format!("{}:{}", provider_name, model);
                let mut usage = state.usage.entry(key).or_insert(Usage {
                    input_tokens: 0,
                    output_tokens: 0,
                    requests: 0,
                });
                usage.input_tokens += input_tokens;
                usage.output_tokens += output_tokens;
                usage.requests += 1;

                let content = result["content"].as_array()
                    .and_then(|blocks| blocks.first())
                    .and_then(|b| b["text"].as_str())
                    .or_else(|| result["choices"].as_array()
                        .and_then(|c| c.first())
                        .and_then(|c| c["message"]["content"].as_str()))
                    .unwrap_or("");

                let tool_calls = result["content"].as_array()
                    .map(|blocks| blocks.iter().filter(|b| b["type"].as_str() == Some("tool_use")).cloned().collect::<Vec<_>>())
                    .or_else(|| result["choices"].as_array()
                        .and_then(|c| c.first())
                        .and_then(|c| c["message"]["tool_calls"].as_array().cloned()))
                    .unwrap_or_default();

                Ok(json!({
                    "content": content,
                    "model": model,
                    "toolCalls": tool_calls,
                    "usage": {
                        "input": input_tokens,
                        "output": output_tokens,
                        "total": input_tokens + output_tokens,
                    }
                }))
            }
        },
    );

    let s = state.clone();
    iii.register_function_with_description(
        "llm::usage",
        "Get usage stats across all providers",
        move |_input: Value| {
            let state = s.clone();
            async move {
                let mut stats = Vec::new();
                for entry in state.usage.iter() {
                    let parts: Vec<&str> = entry.key().splitn(2, ':').collect();
                    stats.push(json!({
                        "provider": parts.first().unwrap_or(&""),
                        "model": parts.get(1).unwrap_or(&""),
                        "input_tokens": entry.value().input_tokens,
                        "output_tokens": entry.value().output_tokens,
                        "requests": entry.value().requests,
                    }));
                }
                Ok(json!({ "stats": stats }))
            }
        },
    );

    let s = state.clone();
    iii.register_function_with_description(
        "llm::providers",
        "List available providers and models",
        move |_input: Value| {
            let state = s.clone();
            async move {
                let list: Vec<Value> = state.providers.iter().map(|entry| {
                    let name = entry.key();
                    let provider = entry.value();
                    json!({
                        "name": name,
                        "base_url": &provider.base_url,
                        "env_key": &provider.env_key,
                        "models": &provider.models,
                        "configured": if provider.env_key.is_empty() { true } else { std::env::var(&provider.env_key).is_ok() },
                    })
                }).collect();
                Ok(json!({ "providers": list }))
            }
        },
    );

    tracing::info!("llm-router worker ready with {} providers", default_providers().len());
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_score_complexity_empty_messages() {
        let messages: Vec<Value> = vec![];
        let tools: Vec<Value> = vec![];
        assert_eq!(score_complexity(&messages, &tools), 0);
    }

    #[test]
    fn test_score_complexity_short_message() {
        let messages = vec![json!({"role": "user", "content": "hi"})];
        let tools: Vec<Value> = vec![];
        assert_eq!(score_complexity(&messages, &tools), 0);
    }

    #[test]
    fn test_score_complexity_long_message() {
        let content = "a".repeat(500);
        let messages = vec![json!({"role": "user", "content": content})];
        let tools: Vec<Value> = vec![];
        assert_eq!(score_complexity(&messages, &tools), 5);
    }

    #[test]
    fn test_score_complexity_code_content() {
        let messages = vec![json!({"role": "user", "content": "Please write a function to sort items ```code```"})];
        let tools: Vec<Value> = vec![];
        let score = score_complexity(&messages, &tools);
        assert!(score >= 20);
    }

    #[test]
    fn test_score_complexity_analysis_keywords() {
        let messages = vec![json!({"role": "user", "content": "Please analyze and compare these designs"})];
        let tools: Vec<Value> = vec![];
        let score = score_complexity(&messages, &tools);
        assert!(score >= 15);
    }

    #[test]
    fn test_score_complexity_with_tools() {
        let messages = vec![json!({"role": "user", "content": "hello"})];
        let tools = vec![json!({"name": "tool1"}), json!({"name": "tool2"})];
        assert_eq!(score_complexity(&messages, &tools), 10);
    }

    #[test]
    fn test_score_complexity_many_messages() {
        let messages: Vec<Value> = (0..11).map(|i| json!({"role": "user", "content": format!("msg {}", i)})).collect();
        let tools: Vec<Value> = vec![];
        let score = score_complexity(&messages, &tools);
        assert!(score >= 10);
    }

    #[test]
    fn test_score_complexity_uses_last_message() {
        let messages = vec![
            json!({"role": "user", "content": "simple"}),
            json!({"role": "user", "content": "Please analyze this complex function and compare it"}),
        ];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 15);
    }

    #[test]
    fn test_score_complexity_class_keyword() {
        let messages = vec![json!({"role": "user", "content": "Define a class for the data model"})];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 20);
    }

    #[test]
    fn test_select_model_low_complexity() {
        let (provider, model) = select_model(5, None);
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_medium_complexity() {
        let (provider, model) = select_model(25, None);
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_select_model_high_complexity() {
        let (provider, model) = select_model(50, None);
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_select_model_boundary_10() {
        let (_, model) = select_model(10, None);
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_boundary_11() {
        let (_, model) = select_model(11, None);
        assert_eq!(model, "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_select_model_boundary_40() {
        let (_, model) = select_model(40, None);
        assert_eq!(model, "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_select_model_boundary_41() {
        let (_, model) = select_model(41, None);
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_select_model_preferred_opus() {
        let (provider, model) = select_model(0, Some("opus"));
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_select_model_preferred_sonnet() {
        let (_, model) = select_model(0, Some("sonnet"));
        assert_eq!(model, "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_select_model_preferred_haiku() {
        let (_, model) = select_model(100, Some("haiku"));
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_preferred_claude_opus() {
        let (_, model) = select_model(0, Some("claude-opus"));
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_select_model_preferred_claude_sonnet() {
        let (_, model) = select_model(0, Some("claude-sonnet"));
        assert_eq!(model, "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_select_model_preferred_claude_haiku() {
        let (_, model) = select_model(0, Some("claude-haiku"));
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_preferred_gpt4o() {
        let (provider, model) = select_model(0, Some("gpt-4o"));
        assert_eq!(provider, "openai");
        assert_eq!(model, "gpt-4o");
    }

    #[test]
    fn test_select_model_preferred_gemini() {
        let (provider, model) = select_model(0, Some("gemini"));
        assert_eq!(provider, "google");
        assert_eq!(model, "gemini-2.0-flash");
    }

    #[test]
    fn test_select_model_unknown_preferred_falls_through() {
        let (provider, _) = select_model(5, Some("unknown-model"));
        assert_eq!(provider, "anthropic");
    }

    #[test]
    fn test_default_providers_count() {
        let providers = default_providers();
        assert_eq!(providers.len(), 10);
    }

    #[test]
    fn test_default_providers_anthropic_exists() {
        let providers = default_providers();
        let anthropic = providers.iter().find(|p| p.0 == "anthropic");
        assert!(anthropic.is_some());
        let (_, base_url, env_key, _, models) = anthropic.unwrap();
        assert_eq!(*base_url, "https://api.anthropic.com");
        assert_eq!(*env_key, "ANTHROPIC_API_KEY");
        assert!(models.len() >= 3);
    }

    #[test]
    fn test_default_providers_openai_exists() {
        let providers = default_providers();
        assert!(providers.iter().any(|p| p.0 == "openai"));
    }

    #[test]
    fn test_default_providers_google_exists() {
        let providers = default_providers();
        assert!(providers.iter().any(|p| p.0 == "google"));
    }

    #[test]
    fn test_default_providers_ollama_no_env_key() {
        let providers = default_providers();
        let ollama = providers.iter().find(|p| p.0 == "ollama").unwrap();
        assert_eq!(ollama.2, "");
    }

    #[test]
    fn test_default_providers_all_have_models() {
        for (name, _, _, _, models) in default_providers() {
            assert!(!models.is_empty(), "Provider {} has no models", name);
        }
    }

    #[test]
    fn test_driver_clone() {
        let d = Driver::Anthropic;
        let cloned = d;
        assert!(matches!(cloned, Driver::Anthropic));
    }

    #[test]
    fn test_score_complexity_design_keyword() {
        let messages = vec![json!({"role": "user", "content": "Help me design a new API"})];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 15);
    }

    #[test]
    fn test_score_complexity_all_bonuses() {
        let content = format!("{} analyze compare design function class ```code```",  "a".repeat(2000));
        let messages: Vec<Value> = (0..12).map(|_| json!({"role": "user", "content": &content})).collect();
        let tools: Vec<Value> = (0..5).map(|i| json!({"name": format!("tool{}", i)})).collect();
        let score = score_complexity(&messages, &tools);
        assert!(score > 50);
    }

    #[test]
    fn test_usage_key_format() {
        let provider_name = "anthropic";
        let model = "claude-sonnet-4-20250514";
        let key = format!("{}:{}", provider_name, model);
        assert_eq!(key, "anthropic:claude-sonnet-4-20250514");

        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts[0], "anthropic");
        assert_eq!(parts[1], "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_score_complexity_no_content_field() {
        let messages = vec![json!({"role": "user"})];
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 0);
    }

    #[test]
    fn test_score_complexity_null_content() {
        let messages = vec![json!({"role": "user", "content": null})];
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 0);
    }

    #[test]
    fn test_score_complexity_whitespace_only() {
        let messages = vec![json!({"role": "user", "content": "   \t\n  "})];
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 0);
    }

    #[test]
    fn test_score_complexity_exactly_100_chars() {
        let content = "x".repeat(100);
        let messages = vec![json!({"role": "user", "content": content})];
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 1);
    }

    #[test]
    fn test_score_complexity_99_chars() {
        let content = "x".repeat(99);
        let messages = vec![json!({"role": "user", "content": content})];
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 0);
    }

    #[test]
    fn test_score_complexity_exactly_10_messages() {
        let messages: Vec<Value> = (0..10).map(|i| json!({"role": "user", "content": format!("m{}", i)})).collect();
        let score = score_complexity(&messages, &[]);
        assert_eq!(score, 0);
    }

    #[test]
    fn test_select_model_boundary_0() {
        let (_, model) = select_model(0, None);
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_very_high_complexity() {
        let (provider, model) = select_model(1000, None);
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_select_model_empty_preferred_falls_through() {
        let (_, model) = select_model(5, Some(""));
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn test_select_model_all_named_preferences() {
        let prefs = vec![
            ("opus", "claude-opus-4-20250514"),
            ("claude-opus", "claude-opus-4-20250514"),
            ("sonnet", "claude-sonnet-4-20250514"),
            ("claude-sonnet", "claude-sonnet-4-20250514"),
            ("haiku", "claude-haiku-4-5-20251001"),
            ("claude-haiku", "claude-haiku-4-5-20251001"),
            ("gpt-4o", "gpt-4o"),
            ("gemini", "gemini-2.0-flash"),
        ];
        for (pref, expected_model) in prefs {
            let (_, model) = select_model(50, Some(pref));
            assert_eq!(model, expected_model, "Preference '{}' should select model '{}'", pref, expected_model);
        }
    }

    #[test]
    fn test_default_providers_all_have_non_empty_base_url() {
        for (name, base_url, _, _, _) in default_providers() {
            assert!(!base_url.is_empty(), "Provider {} has empty base_url", name);
        }
    }

    #[test]
    fn test_default_providers_env_key_format() {
        for (name, _, env_key, _, _) in default_providers() {
            if !env_key.is_empty() {
                assert!(env_key.ends_with("_KEY") || env_key.ends_with("_API_KEY"),
                    "Provider {} env_key '{}' doesn't follow convention", name, env_key);
            }
        }
    }

    #[test]
    fn test_default_providers_model_count_per_provider() {
        let providers = default_providers();
        for (name, _, _, _, models) in &providers {
            assert!(models.len() >= 1, "Provider {} should have at least 1 model", name);
        }
        let anthropic = providers.iter().find(|p| p.0 == "anthropic").unwrap();
        assert_eq!(anthropic.4.len(), 3);
        let openai = providers.iter().find(|p| p.0 == "openai").unwrap();
        assert_eq!(openai.4.len(), 4);
    }

    #[test]
    fn test_usage_key_with_colon_in_model_name() {
        let key = format!("{}:{}", "openrouter", "anthropic/claude-opus-4-20250514");
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts[0], "openrouter");
        assert_eq!(parts[1], "anthropic/claude-opus-4-20250514");
    }

    #[test]
    fn test_usage_key_splitn_preserves_colons_in_value() {
        let key = "provider:model:with:colons";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "provider");
        assert_eq!(parts[1], "model:with:colons");
    }

    #[test]
    fn test_default_providers_unique_names() {
        let providers = default_providers();
        let names: Vec<&str> = providers.iter().map(|p| p.0).collect();
        let mut deduped = names.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(names.len(), deduped.len());
    }

    #[test]
    fn test_default_providers_groq_exists() {
        assert!(default_providers().iter().any(|p| p.0 == "groq"));
    }

    #[test]
    fn test_default_providers_deepseek_exists() {
        assert!(default_providers().iter().any(|p| p.0 == "deepseek"));
    }

    #[test]
    fn test_default_providers_together_exists() {
        assert!(default_providers().iter().any(|p| p.0 == "together"));
    }

    #[test]
    fn test_default_providers_fireworks_exists() {
        assert!(default_providers().iter().any(|p| p.0 == "fireworks"));
    }

    #[test]
    fn test_score_complexity_combined_code_and_analysis() {
        let messages = vec![json!({"role": "user", "content": "analyze this function ```code```"})];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 35, "Expected >= 35 for code+analysis, got {}", score);
    }

    #[test]
    fn test_score_complexity_compare_keyword_alone() {
        let messages = vec![json!({"role": "user", "content": "compare option A with option B"})];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 15);
    }

    #[test]
    fn test_score_complexity_function_keyword_alone() {
        let messages = vec![json!({"role": "user", "content": "write a function that adds two numbers"})];
        let score = score_complexity(&messages, &[]);
        assert!(score >= 20);
    }

    #[test]
    fn test_score_complexity_exactly_11_messages() {
        let messages: Vec<Value> = (0..11).map(|i| json!({"role": "user", "content": format!("m{}", i)})).collect();
        let score = score_complexity(&messages, &[]);
        assert!(score >= 10);
    }

    #[test]
    fn test_score_complexity_one_tool_adds_5() {
        let messages = vec![json!({"role": "user", "content": "hi"})];
        let tools = vec![json!({"name": "t"})];
        let s1 = score_complexity(&messages, &[]);
        let s2 = score_complexity(&messages, &tools);
        assert_eq!(s2 - s1, 5);
    }

    #[test]
    fn test_score_complexity_ten_tools() {
        let messages = vec![json!({"role": "user", "content": "hi"})];
        let tools: Vec<Value> = (0..10).map(|i| json!({"name": format!("t{}", i)})).collect();
        let score = score_complexity(&messages, &tools);
        assert!(score >= 50);
    }

    #[test]
    fn test_score_complexity_200_chars_gives_2() {
        let content = "y".repeat(200);
        let messages = vec![json!({"role": "user", "content": content})];
        assert_eq!(score_complexity(&messages, &[]), 2);
    }

    #[test]
    fn test_select_model_boundary_exact_ranges() {
        for c in 0..=10 {
            let (_, model) = select_model(c, None);
            assert_eq!(model, "claude-haiku-4-5-20251001", "complexity {} should be haiku", c);
        }
        for c in 11..=40 {
            let (_, model) = select_model(c, None);
            assert_eq!(model, "claude-sonnet-4-20250514", "complexity {} should be sonnet", c);
        }
        for c in [41, 50, 100, 255, u32::MAX] {
            let (_, model) = select_model(c, None);
            assert_eq!(model, "claude-opus-4-20250514", "complexity {} should be opus", c);
        }
    }

    #[test]
    fn test_select_model_preferred_overrides_complexity() {
        let (_, model) = select_model(100, Some("haiku"));
        assert_eq!(model, "claude-haiku-4-5-20251001");

        let (_, model) = select_model(0, Some("opus"));
        assert_eq!(model, "claude-opus-4-20250514");
    }

    #[test]
    fn test_default_providers_openai_details() {
        let providers = default_providers();
        let openai = providers.iter().find(|p| p.0 == "openai").unwrap();
        assert_eq!(openai.1, "https://api.openai.com/v1");
        assert_eq!(openai.2, "OPENAI_API_KEY");
        assert!(openai.4.contains(&"gpt-4o"));
    }

    #[test]
    fn test_default_providers_google_details() {
        let providers = default_providers();
        let google = providers.iter().find(|p| p.0 == "google").unwrap();
        assert_eq!(google.2, "GOOGLE_API_KEY");
        assert!(google.4.contains(&"gemini-2.0-flash"));
    }

    #[test]
    fn test_default_providers_groq_details() {
        let providers = default_providers();
        let groq = providers.iter().find(|p| p.0 == "groq").unwrap();
        assert_eq!(groq.2, "GROQ_API_KEY");
        assert!(groq.4.contains(&"llama-3.3-70b-versatile"));
    }

    #[test]
    fn test_default_providers_deepseek_details() {
        let providers = default_providers();
        let ds = providers.iter().find(|p| p.0 == "deepseek").unwrap();
        assert_eq!(ds.2, "DEEPSEEK_API_KEY");
        assert!(ds.4.contains(&"deepseek-chat"));
        assert!(ds.4.contains(&"deepseek-reasoner"));
    }

    #[test]
    fn test_default_providers_mistral_details() {
        let providers = default_providers();
        let mistral = providers.iter().find(|p| p.0 == "mistral").unwrap();
        assert_eq!(mistral.2, "MISTRAL_API_KEY");
    }

    #[test]
    fn test_default_providers_openrouter_details() {
        let providers = default_providers();
        let or = providers.iter().find(|p| p.0 == "openrouter").unwrap();
        assert_eq!(or.2, "OPENROUTER_API_KEY");
        assert!(or.4.iter().any(|m| m.contains("anthropic/")));
    }

    #[test]
    fn test_default_providers_ollama_local() {
        let providers = default_providers();
        let ollama = providers.iter().find(|p| p.0 == "ollama").unwrap();
        assert!(ollama.1.contains("localhost"));
        assert!(ollama.2.is_empty());
    }

    #[test]
    fn test_usage_key_empty_provider() {
        let key = format!("{}:{}", "", "model-name");
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts[0], "");
        assert_eq!(parts[1], "model-name");
    }

    #[test]
    fn test_usage_key_no_colon() {
        let key = "just-a-key";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "just-a-key");
    }
}

use iii_sdk::{III, RegisterFunction, TriggerRequest};
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};




#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub pattern: String,
    pub action: PolicyAction,
    pub scope: PolicyScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyScope {
    Agent,
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    pub rules: Vec<PolicyRule>,
    #[serde(rename = "maxSubagentDepth")]
    pub max_subagent_depth: Option<u32>,
    #[serde(rename = "maxConcurrency")]
    pub max_concurrency: Option<u32>,
}

fn glob_matches(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();

    if parts.len() == 1 {
        return pattern == name;
    }

    let mut pos = 0usize;

    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }

        match name[pos..].find(part) {
            Some(found) => {
                if i == 0 && found != 0 {
                    return false;
                }
                pos += found + part.len();
            }
            None => return false,
        }
    }

    if let Some(last) = parts.last()
        && !last.is_empty() && !name.ends_with(last)
    {
        return false;
    }

    true
}

fn evaluate_rules(rules: &[PolicyRule], tool_name: &str) -> Option<PolicyAction> {
    for rule in rules {
        if glob_matches(&rule.pattern, tool_name) {
            return Some(rule.action);
        }
    }
    None
}

pub fn check_policy(
    agent_rules: &[PolicyRule],
    global_rules: &[PolicyRule],
    tool_name: &str,
) -> PolicyAction {
    if let Some(action) = evaluate_rules(agent_rules, tool_name) {
        return action;
    }

    if let Some(action) = evaluate_rules(global_rules, tool_name) {
        return action;
    }

    PolicyAction::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_rule(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Allow,
            scope: PolicyScope::Agent,
        }
    }

    fn deny_rule(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Deny,
            scope: PolicyScope::Global,
        }
    }

    #[test]
    fn test_glob_matches_exact() {
        assert!(glob_matches("file::read", "file::read"));
        assert!(!glob_matches("file::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_wildcard_suffix() {
        assert!(glob_matches("file::*", "file::read"));
        assert!(glob_matches("file::*", "file::write"));
        assert!(!glob_matches("file::*", "network::send"));
    }

    #[test]
    fn test_glob_matches_wildcard_prefix() {
        assert!(glob_matches("*::read", "file::read"));
        assert!(glob_matches("*::read", "network::read"));
        assert!(!glob_matches("*::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_wildcard_middle() {
        assert!(glob_matches("file::*::v2", "file::read::v2"));
        assert!(!glob_matches("file::*::v2", "file::read::v3"));
    }

    #[test]
    fn test_glob_matches_star_only() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*", "file::read"));
    }

    #[test]
    fn test_glob_matches_no_wildcard_mismatch() {
        assert!(!glob_matches("file::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_empty_pattern_empty_name() {
        assert!(glob_matches("", ""));
    }

    #[test]
    fn test_glob_matches_pattern_must_match_start() {
        assert!(!glob_matches("file*", "myfile"));
    }

    #[test]
    fn test_glob_matches_pattern_must_match_end() {
        assert!(!glob_matches("*read", "read_more"));
    }

    #[test]
    fn test_evaluate_rules_first_match_wins() {
        let rules = vec![
            allow_rule("file::*"),
            deny_rule("file::delete"),
        ];
        assert_eq!(evaluate_rules(&rules, "file::delete"), Some(PolicyAction::Allow));
    }

    #[test]
    fn test_evaluate_rules_no_match() {
        let rules = vec![allow_rule("file::*")];
        assert_eq!(evaluate_rules(&rules, "network::send"), None);
    }

    #[test]
    fn test_evaluate_rules_empty_rules() {
        let rules: Vec<PolicyRule> = vec![];
        assert_eq!(evaluate_rules(&rules, "anything"), None);
    }

    #[test]
    fn test_evaluate_rules_deny_match() {
        let rules = vec![deny_rule("network::*")];
        assert_eq!(evaluate_rules(&rules, "network::send"), Some(PolicyAction::Deny));
    }

    #[test]
    fn test_check_policy_agent_rules_take_precedence() {
        let agent_rules = vec![allow_rule("file::read")];
        let global_rules = vec![deny_rule("file::*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_falls_through_to_global() {
        let agent_rules = vec![allow_rule("memory::*")];
        let global_rules = vec![allow_rule("file::read")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_default_deny() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules: Vec<PolicyRule> = vec![];
        assert_eq!(check_policy(&agent_rules, &global_rules, "anything"), PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_global_deny() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules = vec![deny_rule("*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_global_allow_all() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules = vec![allow_rule("*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "anything"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_agent_deny_overrides_global_allow() {
        let agent_rules = vec![deny_rule("file::delete")];
        let global_rules = vec![allow_rule("file::*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::delete"), PolicyAction::Deny);
    }

    #[test]
    fn test_policy_config_serialization() {
        let config = PolicyConfig {
            rules: vec![allow_rule("file::*")],
            max_subagent_depth: Some(3),
            max_concurrency: Some(5),
        };
        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(serialized["maxSubagentDepth"], 3);
        assert_eq!(serialized["maxConcurrency"], 5);
        assert_eq!(serialized["rules"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_policy_config_deserialization() {
        let json_val = json!({
            "rules": [{"pattern": "test::*", "action": "Allow", "scope": "Agent"}],
            "maxSubagentDepth": 10,
            "maxConcurrency": 20,
        });
        let config: PolicyConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.max_subagent_depth, Some(10));
        assert_eq!(config.max_concurrency, Some(20));
        assert_eq!(config.rules.len(), 1);
        assert_eq!(config.rules[0].pattern, "test::*");
    }

    #[test]
    fn test_policy_config_optional_fields() {
        let json_val = json!({"rules": []});
        let config: PolicyConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.max_subagent_depth, None);
        assert_eq!(config.max_concurrency, None);
    }

    #[test]
    fn test_policy_action_equality() {
        assert_eq!(PolicyAction::Allow, PolicyAction::Allow);
        assert_eq!(PolicyAction::Deny, PolicyAction::Deny);
        assert_ne!(PolicyAction::Allow, PolicyAction::Deny);
    }

    #[test]
    fn test_policy_scope_equality() {
        assert_eq!(PolicyScope::Agent, PolicyScope::Agent);
        assert_eq!(PolicyScope::Global, PolicyScope::Global);
        assert_ne!(PolicyScope::Agent, PolicyScope::Global);
    }

    #[test]
    fn test_policy_rule_serialization_roundtrip() {
        let rule = allow_rule("fn::*");
        let serialized = serde_json::to_string(&rule).unwrap();
        let deserialized: PolicyRule = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.pattern, "fn::*");
    }

    #[test]
    fn test_glob_matches_double_star() {
        assert!(glob_matches("**", "anything::at::all"));
    }

    #[test]
    fn test_check_policy_multiple_agent_rules() {
        let agent_rules = vec![
            deny_rule("file::delete"),
            allow_rule("file::*"),
        ];
        let global_rules: Vec<PolicyRule> = vec![];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::delete"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }

    #[test]
    fn test_glob_matches_empty_pattern_nonempty_name() {
        assert!(!glob_matches("", "something"));
    }

    #[test]
    fn test_glob_matches_nonempty_pattern_empty_name() {
        assert!(!glob_matches("file::read", ""));
    }

    #[test]
    fn test_glob_matches_star_empty_name() {
        assert!(glob_matches("*", ""));
    }

    #[test]
    fn test_glob_matches_multiple_wildcards() {
        assert!(glob_matches("*::*::*", "a::b::c"));
        assert!(glob_matches("*::*", "file::read"));
    }

    #[test]
    fn test_glob_matches_consecutive_stars() {
        assert!(glob_matches("file**read", "fileXXXread"));
    }

    #[test]
    fn test_evaluate_rules_multiple_matches_returns_first() {
        let rules = vec![
            deny_rule("*"),
            allow_rule("file::read"),
        ];
        assert_eq!(evaluate_rules(&rules, "file::read"), Some(PolicyAction::Deny));
    }

    #[test]
    fn test_check_policy_both_empty_defaults_deny() {
        assert_eq!(
            check_policy(&[], &[], "any::tool"),
            PolicyAction::Deny
        );
    }

    #[test]
    fn test_check_policy_agent_allow_global_deny_agent_wins() {
        let agent = vec![allow_rule("net::*")];
        let global = vec![deny_rule("net::*")];
        assert_eq!(check_policy(&agent, &global, "net::send"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_no_agent_match_global_deny() {
        let agent = vec![allow_rule("file::*")];
        let global = vec![deny_rule("network::*")];
        assert_eq!(check_policy(&agent, &global, "network::send"), PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_no_agent_match_no_global_match_deny() {
        let agent = vec![allow_rule("file::*")];
        let global = vec![allow_rule("network::*")];
        assert_eq!(check_policy(&agent, &global, "memory::store"), PolicyAction::Deny);
    }

    #[test]
    fn test_policy_config_roundtrip() {
        let config = PolicyConfig {
            rules: vec![
                allow_rule("file::*"),
                deny_rule("network::*"),
            ],
            max_subagent_depth: Some(7),
            max_concurrency: Some(15),
        };
        let json_str = serde_json::to_string(&config).unwrap();
        let roundtrip: PolicyConfig = serde_json::from_str(&json_str).unwrap();
        assert_eq!(roundtrip.rules.len(), 2);
        assert_eq!(roundtrip.max_subagent_depth, Some(7));
        assert_eq!(roundtrip.max_concurrency, Some(15));
    }

    #[test]
    fn test_policy_config_zero_depth_and_concurrency() {
        let config = PolicyConfig {
            rules: vec![],
            max_subagent_depth: Some(0),
            max_concurrency: Some(0),
        };
        let val = serde_json::to_value(&config).unwrap();
        assert_eq!(val["maxSubagentDepth"], 0);
        assert_eq!(val["maxConcurrency"], 0);
    }

    #[test]
    fn test_glob_matches_long_pattern_short_name() {
        assert!(!glob_matches("file::read::v2::subresource", "file"));
    }

    #[test]
    fn test_policy_action_serialization() {
        let allow_json = serde_json::to_string(&PolicyAction::Allow).unwrap();
        let deny_json = serde_json::to_string(&PolicyAction::Deny).unwrap();
        assert_eq!(allow_json, "\"Allow\"");
        assert_eq!(deny_json, "\"Deny\"");
    }

    #[test]
    fn test_policy_scope_serialization() {
        let agent_json = serde_json::to_string(&PolicyScope::Agent).unwrap();
        let global_json = serde_json::to_string(&PolicyScope::Global).unwrap();
        assert_eq!(agent_json, "\"Agent\"");
        assert_eq!(global_json, "\"Global\"");
    }

    fn global_allow(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Allow,
            scope: PolicyScope::Global,
        }
    }

    fn agent_deny(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Deny,
            scope: PolicyScope::Agent,
        }
    }

    #[test]
    fn test_glob_matches_special_chars_colons() {
        assert!(glob_matches("ns::fn::v2", "ns::fn::v2"));
        assert!(!glob_matches("ns::fn::v2", "ns::fn::v3"));
    }

    #[test]
    fn test_glob_matches_dots_in_pattern() {
        assert!(glob_matches("file.read", "file.read"));
        assert!(!glob_matches("file.read", "file_read"));
    }

    #[test]
    fn test_glob_matches_hyphens_underscores() {
        assert!(glob_matches("my-tool_v2*", "my-tool_v2.1"));
        assert!(glob_matches("my-tool_v2*", "my-tool_v2"));
    }

    #[test]
    fn test_glob_star_at_both_ends() {
        assert!(glob_matches("*read*", "file::read::v2"));
        assert!(glob_matches("*read*", "readall"));
        assert!(glob_matches("*read*", "preread"));
    }

    #[test]
    fn test_glob_matches_single_char_segments() {
        assert!(glob_matches("a*b", "aXb"));
        assert!(glob_matches("a*b", "ab"));
        assert!(!glob_matches("a*b", "aXc"));
    }

    #[test]
    fn test_evaluate_rules_many_rules_first_match() {
        let rules: Vec<PolicyRule> = (0..100)
            .map(|i| allow_rule(&format!("tool-{}", i)))
            .chain(std::iter::once(deny_rule("tool-50")))
            .collect();
        assert_eq!(evaluate_rules(&rules, "tool-50"), Some(PolicyAction::Allow));
    }

    #[test]
    fn test_evaluate_rules_many_rules_last_match() {
        let mut rules: Vec<PolicyRule> = (0..99)
            .map(|i| allow_rule(&format!("tool-{}", i)))
            .collect();
        rules.push(deny_rule("special-tool"));
        assert_eq!(evaluate_rules(&rules, "special-tool"), Some(PolicyAction::Deny));
    }

    #[test]
    fn test_policy_config_large_rule_set() {
        let rules: Vec<PolicyRule> = (0..1000)
            .map(|i| PolicyRule {
                pattern: format!("fn::category{}::*", i),
                action: if i % 2 == 0 { PolicyAction::Allow } else { PolicyAction::Deny },
                scope: PolicyScope::Agent,
            })
            .collect();
        let config = PolicyConfig {
            rules,
            max_subagent_depth: Some(10),
            max_concurrency: Some(50),
        };
        let serialized = serde_json::to_string(&config).unwrap();
        let deserialized: PolicyConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.rules.len(), 1000);
        assert_eq!(deserialized.rules[0].action, PolicyAction::Allow);
        assert_eq!(deserialized.rules[1].action, PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_mixed_allow_deny_patterns() {
        let agent_rules = vec![
            deny_rule("file::delete"),
            deny_rule("file::chmod"),
            allow_rule("file::*"),
        ];
        let global_rules = vec![deny_rule("*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::delete"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::chmod"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "network::send"), PolicyAction::Deny);
    }

    #[test]
    fn test_glob_no_wildcard_exact_match_only() {
        assert!(glob_matches("exact_tool", "exact_tool"));
        assert!(!glob_matches("exact_tool", "exact_tool2"));
        assert!(!glob_matches("exact_tool", "exact_too"));
        assert!(!glob_matches("exact_tool", ""));
    }

    #[test]
    fn test_glob_multiple_wildcards_complex() {
        assert!(glob_matches("a*b*c*d", "aXbYcZd"));
        assert!(glob_matches("a*b*c*d", "abcd"));
        assert!(!glob_matches("a*b*c*d", "aXbYcZ"));
        assert!(!glob_matches("a*b*c*d", "XaXbYcZd"));
    }

    #[test]
    fn test_check_policy_agent_specific_override() {
        let agent_rules = vec![
            allow_rule("dangerous::tool"),
        ];
        let global_rules = vec![
            deny_rule("dangerous::*"),
            allow_rule("*"),
        ];
        assert_eq!(check_policy(&agent_rules, &global_rules, "dangerous::tool"), PolicyAction::Allow);
        assert_eq!(check_policy(&agent_rules, &global_rules, "dangerous::other"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "safe::tool"), PolicyAction::Allow);
    }

    #[test]
    fn test_policy_action_deserialization() {
        let allow: PolicyAction = serde_json::from_str("\"Allow\"").unwrap();
        let deny: PolicyAction = serde_json::from_str("\"Deny\"").unwrap();
        assert_eq!(allow, PolicyAction::Allow);
        assert_eq!(deny, PolicyAction::Deny);
    }

    #[test]
    fn test_policy_scope_deserialization() {
        let agent: PolicyScope = serde_json::from_str("\"Agent\"").unwrap();
        let global: PolicyScope = serde_json::from_str("\"Global\"").unwrap();
        assert_eq!(agent, PolicyScope::Agent);
        assert_eq!(global, PolicyScope::Global);
    }

    #[test]
    fn test_policy_config_null_optional_fields_roundtrip() {
        let config = PolicyConfig {
            rules: vec![allow_rule("*")],
            max_subagent_depth: None,
            max_concurrency: None,
        };
        let serialized = serde_json::to_string(&config).unwrap();
        let deserialized: PolicyConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.max_subagent_depth, None);
        assert_eq!(deserialized.max_concurrency, None);
        assert_eq!(deserialized.rules.len(), 1);
    }

    #[test]
    fn test_policy_config_max_u32_values() {
        let config = PolicyConfig {
            rules: vec![],
            max_subagent_depth: Some(u32::MAX),
            max_concurrency: Some(u32::MAX),
        };
        let val = serde_json::to_value(&config).unwrap();
        assert_eq!(val["maxSubagentDepth"], u32::MAX);
        assert_eq!(val["maxConcurrency"], u32::MAX);
    }

    #[test]
    fn test_glob_matches_very_long_pattern() {
        let long_pattern = format!("prefix::{}::suffix", "mid".repeat(100));
        let long_name = format!("prefix::{}::suffix", "mid".repeat(100));
        assert!(glob_matches(&long_pattern, &long_name));
    }

    #[test]
    fn test_check_policy_cascading_rules() {
        let agent_rules = vec![
            deny_rule("admin::*"),
        ];
        let global_rules = vec![
            allow_rule("admin::read"),
            deny_rule("admin::*"),
        ];
        assert_eq!(check_policy(&agent_rules, &global_rules, "admin::read"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "admin::write"), PolicyAction::Deny);
    }
}

pub fn register(iii: &III) {
    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("policy::check", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("");
                let tool_name = input["tool"].as_str().unwrap_or("");
                let subagent_depth = input["subagentDepth"].as_u64().unwrap_or(0) as u32;
                let current_concurrency = input["currentConcurrency"].as_u64().unwrap_or(0) as u32;

                let agent_policy: Option<PolicyConfig> = iii
                    .trigger(TriggerRequest {
                        function_id: "state::get".to_string(),
                        payload: json!({
                        "scope": "policies",
                        "key": agent_id,
                    }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());

                let global_policy: Option<PolicyConfig> = iii
                    .trigger(TriggerRequest {
                        function_id: "state::get".to_string(),
                        payload: json!({
                        "scope": "policies",
                        "key": "__global",
                    }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());

                let agent_rules = agent_policy.as_ref()
                    .map(|p| p.rules.as_slice())
                    .unwrap_or(&[]);

                let global_rules = global_policy.as_ref()
                    .map(|p| p.rules.as_slice())
                    .unwrap_or(&[]);

                let action = check_policy(agent_rules, global_rules, tool_name);

                let max_depth = agent_policy.as_ref()
                    .and_then(|p| p.max_subagent_depth)
                    .or(global_policy.as_ref().and_then(|p| p.max_subagent_depth))
                    .unwrap_or(5);

                if subagent_depth > max_depth {
                    return Ok(json!({
                        "allowed": false,
                        "reason": "subagent_depth_exceeded",
                        "maxDepth": max_depth,
                        "currentDepth": subagent_depth,
                    }));
                }

                let max_concurrency = agent_policy.as_ref()
                    .and_then(|p| p.max_concurrency)
                    .or(global_policy.as_ref().and_then(|p| p.max_concurrency))
                    .unwrap_or(10);

                if current_concurrency >= max_concurrency {
                    return Ok(json!({
                        "allowed": false,
                        "reason": "concurrency_limit_exceeded",
                        "maxConcurrency": max_concurrency,
                        "currentConcurrency": current_concurrency,
                    }));
                }

                let allowed = action == PolicyAction::Allow;

                Ok::<Value, IIIError>(json!({
                    "allowed": allowed,
                    "action": action,
                    "tool": tool_name,
                    "agentId": agent_id,
                }))
            }
        })
        .description("Check if a function call is allowed by policy"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("policy::set_rules", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let key = input["agentId"]
                    .as_str()
                    .unwrap_or("__global")
                    .to_string();

                let policy: PolicyConfig = serde_json::from_value(
                    input.get("policy").cloned().unwrap_or(json!({ "rules": [] }))
                ).map_err(|e| IIIError::Handler(e.to_string()))?;

                iii.trigger(TriggerRequest {
                    function_id: "state::set".to_string(),
                    payload: json!({
                    "scope": "policies",
                    "key": &key,
                    "value": &policy,
                }),
                    action: None,
                    timeout_ms: None,
                }).await.map_err(|e| IIIError::Handler(e.to_string()))?;

                {
                    let _iii = iii.clone();
                    let _payload = json!({
                    "type": "policy_updated",
                    "agentId": &key,
                    "detail": { "ruleCount": policy.rules.len() },
                });
                    tokio::spawn(async move {
                        let _ = _iii.trigger(TriggerRequest {
                            function_id: "security::audit".to_string(),
                            payload: _payload,
                            action: None,
                            timeout_ms: None,
                        }).await;
                    });
                };

                Ok::<Value, IIIError>(json!({ "updated": true, "key": key, "ruleCount": policy.rules.len() }))
            }
        })
        .description("Set policy rules for an agent or globally"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("policy::get_rules", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let key = input["agentId"]
                    .as_str()
                    .unwrap_or("__global");

                let policy: Value = iii
                    .trigger(TriggerRequest {
                        function_id: "state::get".to_string(),
                        payload: json!({
                        "scope": "policies",
                        "key": key,
                    }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .unwrap_or(json!({ "rules": [], "maxSubagentDepth": 5, "maxConcurrency": 10 }));

                Ok::<Value, IIIError>(json!({
                    "key": key,
                    "policy": policy,
                }))
            }
        })
        .description("Get policy rules for an agent or globally"),
    );
}

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct AgentToml {
    agent: AgentSection,
    persona: Option<PersonaSection>,
}

#[derive(Debug, Deserialize)]
struct AgentSection {
    name: Option<String>,
    description: Option<String>,
    #[allow(dead_code)]
    module: Option<String>,
    model: Option<ModelConfig>,
    capabilities: Option<Capabilities>,
    resources: Option<Resources>,
}

#[derive(Debug, Deserialize)]
struct ModelConfig {
    provider: Option<String>,
    #[allow(dead_code)]
    model: Option<String>,
    #[allow(dead_code)]
    max_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct Capabilities {
    tools: Option<Vec<String>>,
    #[allow(dead_code)]
    memory_scopes: Option<Vec<String>>,
    #[allow(dead_code)]
    network_hosts: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Resources {
    #[allow(dead_code)]
    max_tokens_per_hour: Option<u64>,
    system_prompt: Option<String>,
    #[allow(dead_code)]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PersonaSection {
    division: Option<String>,
    communication_style: Option<String>,
    critical_rules: Option<Vec<String>>,
    workflow: Option<WorkflowSection>,
    success_metrics: Option<SuccessMetrics>,
    learning: Option<LearningSection>,
}

#[derive(Debug, Deserialize)]
struct WorkflowSection {
    phases: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct SuccessMetrics {
    metrics: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct LearningSection {
    patterns: Option<Vec<String>>,
}

fn agents_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("agents")
}

fn load_all_agents() -> Vec<(String, AgentToml)> {
    let dir = agents_dir();
    let mut agents: Vec<(String, AgentToml)> = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("Cannot read agents dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let toml_path = entry.path().join("agent.toml");
        if toml_path.exists() {
            let content = fs::read_to_string(&toml_path)
                .unwrap_or_else(|e| panic!("Cannot read {}: {e}", toml_path.display()));
            let parsed: AgentToml = toml::from_str(&content)
                .unwrap_or_else(|e| panic!("Cannot parse {}: {e}", toml_path.display()));
            let dir_name = entry.file_name().to_string_lossy().to_string();
            agents.push((dir_name, parsed));
        }
    }
    agents
}

#[test]
fn all_45_agents_load_with_nonempty_name() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let name = agent.agent.name.as_deref().unwrap_or("");
        assert!(!name.is_empty(), "Agent in '{dir}' has empty or missing name");
    }
}

#[test]
fn all_agents_have_description() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let desc = agent.agent.description.as_deref().unwrap_or("");
        assert!(
            !desc.is_empty(),
            "Agent '{dir}' is missing description"
        );
    }
}

#[test]
fn all_agents_have_system_prompt() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let prompt = agent
            .agent
            .resources
            .as_ref()
            .and_then(|r| r.system_prompt.as_deref())
            .unwrap_or("");
        assert!(
            !prompt.is_empty(),
            "Agent '{dir}' is missing system_prompt"
        );
    }
}

const VALID_DIVISIONS: &[&str] = &[
    "engineering",
    "quality",
    "research",
    "operations",
    "communication",
    "support",
    "personal",
    "design",
    "marketing",
];

#[test]
fn division_taxonomy_valid() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(division) = &persona.division {
                assert!(
                    VALID_DIVISIONS.contains(&division.as_str()),
                    "Agent '{dir}' has invalid division '{division}'. Valid: {VALID_DIVISIONS:?}"
                );
            }
        }
    }
}

#[test]
fn division_coverage_at_least_one_per_division() {
    let agents = load_all_agents();
    let mut found: HashSet<String> = HashSet::new();
    for (_, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(division) = &persona.division {
                found.insert(division.clone());
            }
        }
    }
    for div in VALID_DIVISIONS {
        assert!(
            found.contains(*div),
            "No agent found with division '{div}'"
        );
    }
}

#[test]
fn agent_count_is_exactly_45() {
    let agents = load_all_agents();
    assert_eq!(
        agents.len(),
        45,
        "Expected 45 agents, found {}",
        agents.len()
    );
}

#[test]
fn no_duplicate_names() {
    let agents = load_all_agents();
    let mut seen: HashMap<String, String> = HashMap::new();
    for (dir, agent) in &agents {
        let name = agent.agent.name.as_deref().unwrap_or("").to_string();
        if let Some(prev_dir) = seen.get(&name) {
            panic!("Duplicate agent name '{name}' in '{dir}' and '{prev_dir}'");
        }
        seen.insert(name, dir.clone());
    }
}

#[test]
fn no_duplicate_directory_names() {
    let agents = load_all_agents();
    let mut seen: HashSet<String> = HashSet::new();
    for (dir, _) in &agents {
        assert!(
            seen.insert(dir.clone()),
            "Duplicate directory name '{dir}'"
        );
    }
}

#[test]
fn model_config_has_nonempty_provider() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(model) = &agent.agent.model {
            let provider = model.provider.as_deref().unwrap_or("");
            assert!(
                !provider.is_empty(),
                "Agent '{dir}' has model section but empty provider"
            );
        }
    }
}

#[test]
fn tools_not_empty() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(caps) = &agent.agent.capabilities {
            if let Some(tools) = &caps.tools {
                assert!(
                    !tools.is_empty(),
                    "Agent '{dir}' has capabilities but no tools"
                );
            }
        }
    }
}

#[test]
fn persona_has_communication_style() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            let style = persona.communication_style.as_deref().unwrap_or("");
            assert!(
                !style.is_empty(),
                "Agent '{dir}' has [persona] but missing communication_style"
            );
        }
    }
}

#[test]
fn workflow_has_at_least_2_phases() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(workflow) = &persona.workflow {
                let phases = workflow.phases.as_ref().map(|p| p.len()).unwrap_or(0);
                assert!(
                    phases >= 2,
                    "Agent '{dir}' workflow has {phases} phases, need at least 2"
                );
            }
        }
    }
}

#[test]
fn success_metrics_has_at_least_1() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(sm) = &persona.success_metrics {
                let count = sm.metrics.as_ref().map(|m| m.len()).unwrap_or(0);
                assert!(
                    count >= 1,
                    "Agent '{dir}' success_metrics has {count} metrics, need at least 1"
                );
            }
        }
    }
}

#[test]
fn learning_has_at_least_1_pattern() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(learning) = &persona.learning {
                let count = learning.patterns.as_ref().map(|p| p.len()).unwrap_or(0);
                assert!(
                    count >= 1,
                    "Agent '{dir}' learning has {count} patterns, need at least 1"
                );
            }
        }
    }
}

#[test]
fn critical_rules_nonempty_where_present() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(rules) = &persona.critical_rules {
                assert!(
                    !rules.is_empty(),
                    "Agent '{dir}' has critical_rules but array is empty"
                );
            }
        }
    }
}

#[test]
fn specific_agents_exist() {
    let agents = load_all_agents();
    let names: HashSet<String> = agents
        .iter()
        .filter_map(|(_, a)| a.agent.name.clone())
        .collect();
    let required = [
        "coder",
        "architect",
        "debugger",
        "ops",
        "hello-world",
        "ux-architect",
        "ai-engineer",
        "growth-hacker",
        "evidence-collector",
        "trend-researcher",
    ];
    for name in required {
        assert!(names.contains(name), "Required agent '{name}' not found");
    }
}

#[test]
fn division_groupings_correct() {
    let agents = load_all_agents();
    let div_map: HashMap<String, String> = agents
        .iter()
        .filter_map(|(_, a)| {
            let name = a.agent.name.clone()?;
            let div = a.persona.as_ref()?.division.clone()?;
            Some((name, div))
        })
        .collect();

    assert_eq!(
        div_map.get("coder").map(|s| s.as_str()),
        Some("engineering"),
        "coder should be in engineering"
    );
    assert_eq!(
        div_map.get("code-reviewer").map(|s| s.as_str()),
        Some("quality"),
        "code-reviewer should be in quality"
    );
    assert_eq!(
        div_map.get("researcher").map(|s| s.as_str()),
        Some("research"),
        "researcher should be in research"
    );
    assert_eq!(
        div_map.get("ops").map(|s| s.as_str()),
        Some("operations"),
        "ops should be in operations"
    );
    assert_eq!(
        div_map.get("writer").map(|s| s.as_str()),
        Some("communication"),
        "writer should be in communication"
    );
}

const NEW_AGENTS: &[&str] = &[
    "ux-architect",
    "brand-guardian",
    "ai-engineer",
    "growth-hacker",
    "evidence-collector",
    "trend-researcher",
    "feedback-synthesizer",
    "sprint-prioritizer",
    "performance-benchmarker",
    "rapid-prototyper",
    "reality-checker",
    "app-store-optimizer",
    "image-prompt-engineer",
    "devops-lead",
    "mobile-builder",
];

#[test]
fn new_agents_have_full_persona() {
    let agents = load_all_agents();
    let agent_map: HashMap<String, &AgentToml> = agents
        .iter()
        .filter_map(|(_, a)| Some((a.agent.name.clone()?, a)))
        .collect();

    for name in NEW_AGENTS {
        let agent = agent_map
            .get(*name)
            .unwrap_or_else(|| panic!("New agent '{name}' not found"));
        let persona = agent
            .persona
            .as_ref()
            .unwrap_or_else(|| panic!("New agent '{name}' missing [persona]"));
        assert!(
            persona.division.is_some(),
            "New agent '{name}' missing persona.division"
        );
        assert!(
            persona.communication_style.is_some(),
            "New agent '{name}' missing persona.communication_style"
        );
        assert!(
            persona.critical_rules.is_some(),
            "New agent '{name}' missing persona.critical_rules"
        );
        assert!(
            persona.workflow.is_some(),
            "New agent '{name}' missing persona.workflow"
        );
        assert!(
            persona.success_metrics.is_some(),
            "New agent '{name}' missing persona.success_metrics"
        );
        assert!(
            persona.learning.is_some(),
            "New agent '{name}' missing persona.learning"
        );
    }
}

#[test]
fn all_toml_files_parse_without_errors() {
    let dir = agents_dir();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let toml_path = entry.path().join("agent.toml");
        if toml_path.exists() {
            let content = fs::read_to_string(&toml_path)
                .unwrap_or_else(|e| panic!("Cannot read {}: {e}", toml_path.display()));
            let _: toml::Value = toml::from_str(&content)
                .unwrap_or_else(|e| panic!("TOML syntax error in {}: {e}", toml_path.display()));
        }
    }
}

#[test]
fn system_prompt_at_least_50_chars() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let prompt = agent
            .agent
            .resources
            .as_ref()
            .and_then(|r| r.system_prompt.as_deref())
            .unwrap_or("");
        let trimmed = prompt.trim();
        assert!(
            trimmed.len() >= 50,
            "Agent '{dir}' system_prompt is only {} chars (need >=50): {:?}",
            trimmed.len(),
            &trimmed[..trimmed.len().min(80)]
        );
    }
}

#[test]
fn directory_names_are_kebab_case() {
    let re_kebab = regex_lite_kebab_check;
    let agents = load_all_agents();
    for (dir, _) in &agents {
        assert!(
            re_kebab(dir),
            "Directory '{dir}' is not kebab-case (expected lowercase letters, digits, hyphens)"
        );
    }
}

fn regex_lite_kebab_check(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

#[test]
fn all_agents_have_model_section() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        assert!(
            agent.agent.model.is_some(),
            "Agent '{dir}' missing [agent.model] section"
        );
    }
}

#[test]
fn all_agents_have_capabilities() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        assert!(
            agent.agent.capabilities.is_some(),
            "Agent '{dir}' missing [agent.capabilities] section"
        );
    }
}

#[test]
fn all_agents_have_persona() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        assert!(
            agent.persona.is_some(),
            "Agent '{dir}' missing [persona] section"
        );
    }
}

#[test]
fn agent_name_matches_directory_name() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let name = agent.agent.name.as_deref().unwrap_or("");
        assert_eq!(
            name, dir,
            "Agent name '{name}' does not match directory name '{dir}'"
        );
    }
}

#[test]
fn all_agents_have_workflow() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            assert!(
                persona.workflow.is_some(),
                "Agent '{dir}' persona missing workflow section"
            );
        }
    }
}

#[test]
fn all_agents_have_success_metrics() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            assert!(
                persona.success_metrics.is_some(),
                "Agent '{dir}' persona missing success_metrics section"
            );
        }
    }
}

#[test]
fn all_agents_have_learning() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            assert!(
                persona.learning.is_some(),
                "Agent '{dir}' persona missing learning section"
            );
        }
    }
}

#[test]
fn all_agents_have_critical_rules() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            assert!(
                persona.critical_rules.is_some(),
                "Agent '{dir}' persona missing critical_rules"
            );
        }
    }
}

#[test]
fn description_is_nontrivial() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        let desc = agent.agent.description.as_deref().unwrap_or("");
        assert!(
            desc.len() >= 10,
            "Agent '{dir}' description too short ({} chars)",
            desc.len()
        );
    }
}

#[test]
fn division_count_matches_taxonomy() {
    let agents = load_all_agents();
    let mut divisions: HashSet<String> = HashSet::new();
    for (_, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(div) = &persona.division {
                divisions.insert(div.clone());
            }
        }
    }
    assert_eq!(
        divisions.len(),
        VALID_DIVISIONS.len(),
        "Found {} unique divisions, expected {}. Found: {:?}",
        divisions.len(),
        VALID_DIVISIONS.len(),
        divisions
    );
}

#[test]
fn engineering_division_has_multiple_agents() {
    let agents = load_all_agents();
    let count = agents
        .iter()
        .filter(|(_, a)| {
            a.persona
                .as_ref()
                .and_then(|p| p.division.as_deref())
                == Some("engineering")
        })
        .count();
    assert!(
        count >= 3,
        "Engineering division should have at least 3 agents, found {count}"
    );
}

#[test]
fn no_agent_toml_missing_from_directory() {
    let dir = agents_dir();
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    for entry in &entries {
        let toml_path = entry.path().join("agent.toml");
        assert!(
            toml_path.exists(),
            "Directory '{}' has no agent.toml",
            entry.file_name().to_string_lossy()
        );
    }
}

#[test]
fn model_provider_is_known() {
    let known_providers = ["anthropic", "openai", "google", "local", "ollama"];
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(model) = &agent.agent.model {
            if let Some(provider) = &model.provider {
                assert!(
                    known_providers.contains(&provider.as_str()),
                    "Agent '{dir}' has unknown provider '{provider}'. Known: {known_providers:?}"
                );
            }
        }
    }
}

#[test]
fn communication_style_is_nontrivial() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(style) = &persona.communication_style {
                assert!(
                    style.len() >= 20,
                    "Agent '{dir}' communication_style too short ({} chars)",
                    style.len()
                );
            }
        }
    }
}

#[test]
fn critical_rules_have_substance() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(rules) = &persona.critical_rules {
                for (i, rule) in rules.iter().enumerate() {
                    assert!(
                        rule.len() >= 10,
                        "Agent '{dir}' critical_rules[{i}] too short: '{rule}'"
                    );
                }
            }
        }
    }
}

#[test]
fn workflow_phases_have_substance() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(workflow) = &persona.workflow {
                if let Some(phases) = &workflow.phases {
                    for (i, phase) in phases.iter().enumerate() {
                        assert!(
                            !phase.trim().is_empty(),
                            "Agent '{dir}' workflow phase[{i}] is empty"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn success_metrics_have_substance() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(sm) = &persona.success_metrics {
                if let Some(metrics) = &sm.metrics {
                    for (i, metric) in metrics.iter().enumerate() {
                        assert!(
                            metric.len() >= 5,
                            "Agent '{dir}' success_metrics[{i}] too short: '{metric}'"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn learning_patterns_have_substance() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(persona) = &agent.persona {
            if let Some(learning) = &persona.learning {
                if let Some(patterns) = &learning.patterns {
                    for (i, pattern) in patterns.iter().enumerate() {
                        assert!(
                            pattern.len() >= 10,
                            "Agent '{dir}' learning pattern[{i}] too short: '{pattern}'"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn total_unique_names_equals_agent_count() {
    let agents = load_all_agents();
    let names: HashSet<String> = agents
        .iter()
        .filter_map(|(_, a)| a.agent.name.clone())
        .collect();
    assert_eq!(
        names.len(),
        agents.len(),
        "Unique name count ({}) differs from agent count ({})",
        names.len(),
        agents.len()
    );
}

#[test]
fn max_tokens_is_positive() {
    let agents = load_all_agents();
    for (dir, agent) in &agents {
        if let Some(model) = &agent.agent.model {
            if let Some(max_tokens) = model.max_tokens {
                assert!(
                    max_tokens > 0,
                    "Agent '{dir}' max_tokens must be positive, got {max_tokens}"
                );
            }
        }
    }
}

#[test]
fn new_agents_count_is_15() {
    let agents = load_all_agents();
    let names: HashSet<String> = agents
        .iter()
        .filter_map(|(_, a)| a.agent.name.clone())
        .collect();
    let found: Vec<&&str> = NEW_AGENTS.iter().filter(|n| names.contains(**n)).collect();
    assert_eq!(
        found.len(),
        15,
        "Expected all 15 new agents, found {}: {:?}",
        found.len(),
        found
    );
}

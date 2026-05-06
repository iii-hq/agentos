use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandFile {
    pub hand: Hand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hand {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub schedule: String,
    #[serde(default)]
    pub functions: HandFunctions,
    #[serde(default)]
    pub settings: Vec<HandSetting>,
    #[serde(default)]
    pub agent: HandAgent,
    #[serde(default)]
    pub dashboard: Option<HandDashboard>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandFunctions {
    #[serde(default)]
    pub allowed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandSetting {
    pub key: String,
    #[serde(rename = "type", default)]
    pub setting_type: String,
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandAgent {
    #[serde(default)]
    pub max_iterations: Option<u64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandDashboard {
    #[serde(default)]
    pub metrics: Vec<HandMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandMetric {
    pub label: String,
    pub key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_BROWSER: &str = include_str!("../tests/fixtures/browser.toml");
    const FIXTURE_MINIMAL: &str = include_str!("../tests/fixtures/minimal.toml");

    #[test]
    fn parses_browser_fixture() {
        let parsed: HandFile = toml::from_str(FIXTURE_BROWSER).expect("parse browser fixture");
        assert_eq!(parsed.hand.id, "browser");
        assert_eq!(parsed.hand.name, "Web Browser Agent");
        assert!(parsed.hand.enabled);
        assert_eq!(parsed.hand.schedule, "0 */2 * * *");
        assert!(parsed.hand.functions.allowed.contains(&"browser::navigate".to_string()));
        assert_eq!(parsed.hand.agent.max_iterations, Some(80));
        assert_eq!(parsed.hand.agent.temperature, Some(0.2));
        assert!(parsed.hand.agent.system_prompt.contains("Phase 1"));
        assert_eq!(parsed.hand.settings.len(), 4);
        assert_eq!(parsed.hand.settings[0].key, "headless_mode");
        assert_eq!(parsed.hand.settings[0].setting_type, "boolean");
        let dash = parsed.hand.dashboard.expect("dashboard present");
        assert_eq!(dash.metrics.len(), 4);
    }

    #[test]
    fn parses_minimal_fixture() {
        let parsed: HandFile = toml::from_str(FIXTURE_MINIMAL).expect("parse minimal fixture");
        assert_eq!(parsed.hand.id, "tiny");
        assert!(parsed.hand.enabled);
        assert!(parsed.hand.functions.allowed.is_empty());
        assert!(parsed.hand.settings.is_empty());
    }

    #[test]
    fn defaults_enabled_to_true() {
        let raw = r#"
[hand]
id = "x"
name = "X"
"#;
        let parsed: HandFile = toml::from_str(raw).expect("parse");
        assert!(parsed.hand.enabled);
    }

    #[test]
    fn round_trip_via_serde_json() {
        let parsed: HandFile = toml::from_str(FIXTURE_BROWSER).unwrap();
        let json = serde_json::to_value(&parsed.hand).unwrap();
        let back: Hand = serde_json::from_value(json).unwrap();
        assert_eq!(back.id, parsed.hand.id);
        assert_eq!(back.functions.allowed, parsed.hand.functions.allowed);
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    Thin,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PulseStatus {
    Idle,
    Running,
    Completed,
    Failed,
    TimedOut,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PulseConfig {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub cron: String,
    pub enabled: bool,
    #[serde(rename = "contextMode")]
    pub context_mode: ContextMode,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
    #[serde(rename = "maxRetries")]
    pub max_retries: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterPulseRequest {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub cron: String,
    #[serde(rename = "contextMode")]
    pub context_mode: Option<ContextMode>,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
    #[serde(rename = "maxRetries")]
    pub max_retries: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvokeRequest {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "contextMode")]
    pub context_mode: Option<ContextMode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PulseRun {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub status: PulseStatus,
    pub source: String,
    #[serde(rename = "contextSnapshot")]
    pub context_snapshot: Option<serde_json::Value>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_register_pulse() {
        let val = json!({
            "agentId": "a-1",
            "realmId": "r-1",
            "cron": "*/5 * * * *",
            "contextMode": "thin"
        });
        let req: RegisterPulseRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.context_mode, Some(ContextMode::Thin));
    }

    #[test]
    fn test_pulse_status() {
        let run = PulseRun {
            id: "run-1".into(),
            agent_id: "a-1".into(),
            realm_id: "r-1".into(),
            status: PulseStatus::Running,
            source: "cron".into(),
            context_snapshot: None,
            started_at: "2026-01-01T00:00:00Z".into(),
            finished_at: None,
            error: None,
        };
        assert_eq!(run.status, PulseStatus::Running);
    }
}

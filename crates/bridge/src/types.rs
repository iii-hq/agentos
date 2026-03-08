use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    Process,
    Http,
    ClaudeCode,
    Codex,
    Cursor,
    OpenCode,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeConfig {
    pub id: String,
    pub kind: RuntimeKind,
    pub name: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub headers: Option<serde_json::Value>,
    #[serde(rename = "envVars")]
    pub env_vars: Option<serde_json::Value>,
    #[serde(rename = "workDir")]
    pub work_dir: Option<String>,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterRuntimeRequest {
    pub kind: RuntimeKind,
    pub name: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub headers: Option<serde_json::Value>,
    #[serde(rename = "envVars")]
    pub env_vars: Option<serde_json::Value>,
    #[serde(rename = "workDir")]
    pub work_dir: Option<String>,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvokeRuntimeRequest {
    #[serde(rename = "runtimeId")]
    pub runtime_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub context: serde_json::Value,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeRun {
    pub id: String,
    #[serde(rename = "runtimeId")]
    pub runtime_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub status: RunStatus,
    pub output: Option<String>,
    pub error: Option<String>,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CancelRequest {
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_runtime_kinds() {
        let val = json!({
            "kind": "claude_code",
            "name": "claude-local",
            "command": "claude",
            "args": ["--model", "opus"]
        });
        let req: RegisterRuntimeRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.kind, RuntimeKind::ClaudeCode);
    }

    #[test]
    fn test_http_runtime() {
        let val = json!({
            "kind": "http",
            "name": "webhook-agent",
            "url": "https://agent.example.com/invoke",
            "headers": { "Authorization": "Bearer xxx" }
        });
        let req: RegisterRuntimeRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.kind, RuntimeKind::Http);
        assert!(req.url.is_some());
    }

    #[test]
    fn test_run_status() {
        let run = RuntimeRun {
            id: "run-1".into(),
            runtime_id: "rt-1".into(),
            agent_id: "a-1".into(),
            status: RunStatus::Completed,
            output: Some("done".into()),
            error: None,
            exit_code: Some(0),
            started_at: "2026-01-01T00:00:00Z".into(),
            finished_at: Some("2026-01-01T00:01:00Z".into()),
        };
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.exit_code, Some(0));
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepMode {
    Sequential,
    Fanout,
    Collect,
    Conditional,
    Loop,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ErrorMode {
    Fail,
    Skip,
    Retry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub name: String,
    #[serde(rename = "functionId")]
    pub function_id: String,
    #[serde(default, rename = "promptTemplate", skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<String>,
    pub mode: StepMode,
    #[serde(rename = "timeoutMs", default)]
    pub timeout_ms: u64,
    #[serde(rename = "errorMode")]
    pub error_mode: ErrorMode,
    #[serde(default, rename = "maxRetries", skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    #[serde(default, rename = "outputVar", skip_serializing_if = "Option::is_none")]
    pub output_var: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, rename = "maxIterations", skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    #[serde(rename = "stepName")]
    pub step_name: String,
    pub output: Value,
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn sanitize_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 256 {
        return Err(format!("Invalid ID format: {id}"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.'))
    {
        return Err(format!("Invalid ID format: {id}"));
    }
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn step_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&StepMode::Sequential).unwrap(), "\"sequential\"");
        assert_eq!(serde_json::to_string(&StepMode::Fanout).unwrap(), "\"fanout\"");
        assert_eq!(serde_json::to_string(&StepMode::Loop).unwrap(), "\"loop\"");
    }

    #[test]
    fn error_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&ErrorMode::Fail).unwrap(), "\"fail\"");
        assert_eq!(serde_json::to_string(&ErrorMode::Retry).unwrap(), "\"retry\"");
    }

    #[test]
    fn workflow_round_trip() {
        let raw = json!({
            "id": "wf-1",
            "name": "Build & Test",
            "description": "demo",
            "steps": [
                {
                    "name": "build",
                    "functionId": "echo::fn",
                    "mode": "sequential",
                    "timeoutMs": 1000,
                    "errorMode": "fail"
                }
            ]
        });
        let wf: Workflow = serde_json::from_value(raw).unwrap();
        assert_eq!(wf.id, "wf-1");
        assert_eq!(wf.steps[0].mode, StepMode::Sequential);
        assert_eq!(wf.steps[0].error_mode, ErrorMode::Fail);
    }

    #[test]
    fn sanitize_id_accepts_valid() {
        assert!(sanitize_id("run-123").is_ok());
        assert!(sanitize_id("a:b.c_d-e").is_ok());
    }

    #[test]
    fn sanitize_id_rejects_invalid() {
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("with space").is_err());
        assert!(sanitize_id("bad/id").is_err());
    }
}

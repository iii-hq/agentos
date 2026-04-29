use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ApprovalRequest {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub params: Value,
    pub reason: String,
    #[serde(rename = "createdAt")]
    pub created_at: u128,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
    pub status: ApprovalStatus,
    #[serde(default, rename = "decidedBy", skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(default, rename = "decidedAt", skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<u128>,
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

    #[test]
    fn approval_status_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&ApprovalStatus::Pending).unwrap(), "\"pending\"");
        assert_eq!(serde_json::to_string(&ApprovalStatus::TimedOut).unwrap(), "\"timed_out\"");
    }

    #[test]
    fn sanitize_id_rules() {
        assert!(sanitize_id("ok-id").is_ok());
        assert!(sanitize_id("bad/id").is_err());
        assert!(sanitize_id("").is_err());
    }
}

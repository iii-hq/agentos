use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Complete,
    Failed,
    Blocked,
}

impl TaskStatus {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "complete" => Some(Self::Complete),
            "failed" => Some(Self::Failed),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    #[serde(rename = "rootId")]
    pub root_id: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub description: String,
    pub status: TaskStatus,
    pub depth: u32,
    pub children: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u128,
    #[serde(rename = "updatedAt")]
    pub updated_at: u128,
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

pub fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```")
        && let Some(end_idx) = rest.find("\n")
    {
        let body = &rest[end_idx + 1..];
        if let Some(stripped) = body.strip_suffix("```") {
            return stripped.trim().to_string();
        }
        if let Some(idx) = body.rfind("```") {
            return body[..idx].trim().to_string();
        }
        return body.trim().to_string();
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&TaskStatus::InProgress).unwrap(), "\"in_progress\"");
        assert_eq!(serde_json::to_string(&TaskStatus::Pending).unwrap(), "\"pending\"");
    }

    #[test]
    fn task_status_from_str() {
        assert_eq!(TaskStatus::from_str("complete"), Some(TaskStatus::Complete));
        assert_eq!(TaskStatus::from_str("nope"), None);
    }

    #[test]
    fn sanitize_id_rules() {
        assert!(sanitize_id("good-id").is_ok());
        assert!(sanitize_id("bad/id").is_err());
        assert!(sanitize_id("").is_err());
    }

    #[test]
    fn strip_code_fences_handles_json() {
        let s = "```json\n{\"a\":1}\n```";
        assert_eq!(strip_code_fences(s), "{\"a\":1}");
    }

    #[test]
    fn strip_code_fences_passthrough() {
        assert_eq!(strip_code_fences("plain"), "plain");
    }
}

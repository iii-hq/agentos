use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalTier {
    Auto,
    Async,
    Sync,
}

impl ApprovalTier {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "async" => Some(Self::Async),
            "sync" => Some(Self::Sync),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Async => "async",
            Self::Sync => "sync",
        }
    }
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
    fn tier_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&ApprovalTier::Auto).unwrap(), "\"auto\"");
        assert_eq!(serde_json::to_string(&ApprovalTier::Sync).unwrap(), "\"sync\"");
    }

    #[test]
    fn tier_round_trip() {
        assert_eq!(ApprovalTier::from_str("async"), Some(ApprovalTier::Async));
        assert_eq!(ApprovalTier::from_str("nope"), None);
    }

    #[test]
    fn sanitize_id_rules() {
        assert!(sanitize_id("ok").is_ok());
        assert!(sanitize_id("bad space").is_err());
        assert!(sanitize_id("").is_err());
    }
}

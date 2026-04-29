use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SwarmStatus {
    Active,
    Dissolved,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Observation,
    Proposal,
    Vote,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VoteValue {
    For,
    Against,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmConfig {
    pub id: String,
    pub goal: String,
    #[serde(rename = "agentIds")]
    pub agent_ids: Vec<String>,
    #[serde(rename = "maxDurationMs")]
    pub max_duration_ms: u64,
    #[serde(rename = "consensusThreshold")]
    pub consensus_threshold: f64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub status: SwarmStatus,
    #[serde(rename = "dissolvedAt", skip_serializing_if = "Option::is_none")]
    pub dissolved_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmMessage {
    pub id: String,
    #[serde(rename = "swarmId")]
    pub swarm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub message: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vote: Option<VoteValue>,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateSwarmRequest {
    pub goal: Option<String>,
    #[serde(rename = "agentIds")]
    pub agent_ids: Option<Vec<String>>,
    #[serde(rename = "maxDurationMs")]
    pub max_duration_ms: Option<u64>,
    #[serde(rename = "consensusThreshold")]
    pub consensus_threshold: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct BroadcastRequest {
    #[serde(rename = "swarmId")]
    pub swarm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub message: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub vote: Option<VoteValue>,
}

#[derive(Debug, Deserialize)]
pub struct CollectRequest {
    #[serde(rename = "swarmId")]
    pub swarm_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ConsensusRequest {
    #[serde(rename = "swarmId")]
    pub swarm_id: String,
    pub proposal: String,
}

#[derive(Debug, Deserialize)]
pub struct DissolveRequest {
    #[serde(rename = "swarmId")]
    pub swarm_id: String,
}

pub fn sanitize_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 256 {
        return Err("Invalid ID format".to_string());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.')) {
        return Err("Invalid ID format".to_string());
    }
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_swarm_status_serialization() {
        assert_eq!(serde_json::to_string(&SwarmStatus::Active).unwrap(), "\"active\"");
        assert_eq!(
            serde_json::to_string(&SwarmStatus::Dissolved).unwrap(),
            "\"dissolved\""
        );
    }

    #[test]
    fn test_message_type_serialization() {
        assert_eq!(
            serde_json::to_string(&MessageType::Observation).unwrap(),
            "\"observation\""
        );
        assert_eq!(
            serde_json::to_string(&MessageType::Proposal).unwrap(),
            "\"proposal\""
        );
        assert_eq!(serde_json::to_string(&MessageType::Vote).unwrap(), "\"vote\"");
    }

    #[test]
    fn test_swarm_config_round_trip() {
        let cfg = SwarmConfig {
            id: "s-1".into(),
            goal: "find bugs".into(),
            agent_ids: vec!["a1".into(), "a2".into()],
            max_duration_ms: 600_000,
            consensus_threshold: 0.66,
            created_at: 1_700_000_000_000,
            status: SwarmStatus::Active,
            dissolved_at: None,
        };
        let val = serde_json::to_value(&cfg).unwrap();
        assert_eq!(val["agentIds"], json!(["a1", "a2"]));
        assert_eq!(val["maxDurationMs"], 600_000);
        let back: SwarmConfig = serde_json::from_value(val).unwrap();
        assert_eq!(back.id, "s-1");
        assert_eq!(back.agent_ids.len(), 2);
    }

    #[test]
    fn test_create_swarm_request() {
        let val = json!({ "goal": "test", "agentIds": ["a1"] });
        let req: CreateSwarmRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.goal.unwrap(), "test");
    }

    #[test]
    fn test_sanitize_id_accepts_valid() {
        assert!(sanitize_id("agent-1").is_ok());
        assert!(sanitize_id("a:b.c_d-e").is_ok());
    }

    #[test]
    fn test_sanitize_id_rejects_invalid() {
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("bad/id").is_err());
        assert!(sanitize_id("with space").is_err());
    }
}

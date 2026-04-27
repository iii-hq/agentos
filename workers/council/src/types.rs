use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    HireAgent,
    TerminateAgent,
    StrategyChange,
    BudgetOverride,
    RealmSuspend,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Proposal {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub kind: ProposalKind,
    pub status: ProposalStatus,
    pub title: String,
    pub payload: serde_json::Value,
    #[serde(rename = "requestedBy")]
    pub requested_by: String,
    #[serde(rename = "decidedBy")]
    pub decided_by: Option<String>,
    #[serde(rename = "decisionNote")]
    pub decision_note: Option<String>,
    #[serde(rename = "decidedAt")]
    pub decided_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SubmitProposalRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub kind: ProposalKind,
    pub title: String,
    pub payload: serde_json::Value,
    #[serde(rename = "requestedBy")]
    pub requested_by: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DecideProposalRequest {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub approved: bool,
    #[serde(rename = "decidedBy")]
    pub decided_by: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Agent,
    Human,
    System,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityEntry {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "actorKind")]
    pub actor_kind: ActorKind,
    #[serde(rename = "actorId")]
    pub actor_id: String,
    pub action: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    pub details: Option<serde_json::Value>,
    pub hash: String,
    #[serde(rename = "prevHash")]
    pub prev_hash: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogActivityRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "actorKind")]
    pub actor_kind: ActorKind,
    #[serde(rename = "actorId")]
    pub actor_id: String,
    pub action: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OverrideRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "operatorId")]
    pub operator_id: String,
    pub action: String,
    #[serde(rename = "targetAgentId")]
    pub target_agent_id: String,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_proposal_kinds() {
        let val = json!({
            "realmId": "r-1",
            "kind": "hire_agent",
            "title": "Hire researcher",
            "payload": { "agentType": "researcher" },
            "requestedBy": "agent-ceo"
        });
        let req: SubmitProposalRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.kind, ProposalKind::HireAgent);
    }

    #[test]
    fn test_activity_entry() {
        let entry = ActivityEntry {
            id: "act-1".into(),
            realm_id: "r-1".into(),
            actor_kind: ActorKind::Human,
            actor_id: "user-1".into(),
            action: "approved".into(),
            entity_type: "proposal".into(),
            entity_id: "p-1".into(),
            details: Some(json!({"note": "looks good"})),
            hash: "abc123".into(),
            prev_hash: "000000".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        assert_eq!(entry.actor_kind, ActorKind::Human);
    }
}

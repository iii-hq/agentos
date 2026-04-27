use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    Backlog,
    Queued,
    Active,
    Review,
    Complete,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MissionPriority {
    Critical,
    High,
    Normal,
    Low,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mission {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "directiveId")]
    pub directive_id: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: MissionStatus,
    pub priority: MissionPriority,
    #[serde(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
    pub version: u64,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateMissionRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<MissionPriority>,
    #[serde(rename = "directiveId")]
    pub directive_id: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckoutRequest {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransitionRequest {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub status: MissionStatus,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommentRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "missionId")]
    pub mission_id: String,
    #[serde(rename = "authorId")]
    pub author_id: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Comment {
    pub id: String,
    #[serde(rename = "missionId")]
    pub mission_id: String,
    #[serde(rename = "authorId")]
    pub author_id: String,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListMissionsRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub status: Option<MissionStatus>,
    #[serde(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    #[serde(rename = "directiveId")]
    pub directive_id: Option<String>,
}

impl MissionStatus {
    pub fn can_transition_to(&self, target: &MissionStatus) -> bool {
        use MissionStatus::*;
        matches!(
            (self, target),
            (Backlog, Queued)
                | (Queued, Active)
                | (Queued, Cancelled)
                | (Active, Review)
                | (Active, Blocked)
                | (Active, Cancelled)
                | (Review, Complete)
                | (Review, Active)
                | (Blocked, Queued)
                | (Blocked, Cancelled)
                | (Backlog, Cancelled)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_status_transitions() {
        assert!(MissionStatus::Backlog.can_transition_to(&MissionStatus::Queued));
        assert!(MissionStatus::Active.can_transition_to(&MissionStatus::Review));
        assert!(!MissionStatus::Complete.can_transition_to(&MissionStatus::Active));
        assert!(!MissionStatus::Cancelled.can_transition_to(&MissionStatus::Queued));
    }

    #[test]
    fn test_mission_deserialization() {
        let val = json!({
            "realmId": "r-1",
            "title": "Deploy v2",
            "createdBy": "agent-lead",
            "priority": "high"
        });
        let req: CreateMissionRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.priority, Some(MissionPriority::High));
    }

    #[test]
    fn test_checkout_request() {
        let val = json!({ "id": "m-1", "realmId": "r-1", "agentId": "a-1" });
        let req: CheckoutRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.id, "m-1");
        assert_eq!(req.realm_id, "r-1");
    }
}

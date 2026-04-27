use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DirectiveLevel {
    Realm,
    Team,
    Agent,
    Mission,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DirectiveStatus {
    Draft,
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Directive {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub title: String,
    pub description: Option<String>,
    pub level: DirectiveLevel,
    pub status: DirectiveStatus,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "ownerAgentId")]
    pub owner_agent_id: Option<String>,
    pub priority: Option<u32>,
    pub version: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateDirectiveRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub title: String,
    pub description: Option<String>,
    pub level: DirectiveLevel,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "ownerAgentId")]
    pub owner_agent_id: Option<String>,
    pub priority: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateDirectiveRequest {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<DirectiveStatus>,
    pub priority: Option<u32>,
    #[serde(rename = "ownerAgentId")]
    pub owner_agent_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListDirectivesRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub level: Option<DirectiveLevel>,
    pub status: Option<DirectiveStatus>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_directive_levels() {
        let val = json!({
            "realmId": "r-1",
            "title": "Ship v2",
            "level": "realm",
        });
        let req: CreateDirectiveRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.level, DirectiveLevel::Realm);
    }

    #[test]
    fn test_directive_round_trip() {
        let d = Directive {
            id: "d-1".into(),
            realm_id: "r-1".into(),
            title: "Scale infra".into(),
            description: None,
            level: DirectiveLevel::Team,
            status: DirectiveStatus::Active,
            parent_id: Some("d-0".into()),
            owner_agent_id: Some("agent-ops".into()),
            priority: Some(1),
            version: 1,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&d).unwrap();
        let back: Directive = serde_json::from_value(json).unwrap();
        assert_eq!(back.parent_id, Some("d-0".into()));
    }
}

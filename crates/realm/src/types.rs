use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RealmStatus {
    Active,
    Suspended,
    Archived,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Realm {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: RealmStatus,
    pub owner: String,
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(rename = "maxAgents")]
    pub max_agents: Option<u32>,
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateRealmRequest {
    pub name: String,
    pub description: Option<String>,
    pub owner: String,
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(rename = "maxAgents")]
    pub max_agents: Option<u32>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateRealmRequest {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<RealmStatus>,
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(rename = "maxAgents")]
    pub max_agents: Option<u32>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub id: String,
    #[serde(rename = "scrubSecrets")]
    pub scrub_secrets: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportRequest {
    pub data: serde_json::Value,
    #[serde(rename = "newOwner")]
    pub new_owner: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_create_realm_request() {
        let val = json!({
            "name": "Acme Corp",
            "owner": "user-1",
            "description": "Main realm"
        });
        let req: CreateRealmRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.name, "Acme Corp");
        assert_eq!(req.owner, "user-1");
    }

    #[test]
    fn test_realm_status_serialization() {
        let status = RealmStatus::Active;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"active\"");
    }

    #[test]
    fn test_realm_round_trip() {
        let realm = Realm {
            id: "r-1".into(),
            name: "Test".into(),
            description: None,
            status: RealmStatus::Active,
            owner: "user-1".into(),
            default_model: None,
            max_agents: Some(50),
            metadata: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&realm).unwrap();
        let back: Realm = serde_json::from_value(json).unwrap();
        assert_eq!(back.id, "r-1");
        assert_eq!(back.max_agents, Some(50));
    }
}

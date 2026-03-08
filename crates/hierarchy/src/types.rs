use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HierarchyNode {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "reportsTo")]
    pub reports_to: Option<String>,
    pub title: Option<String>,
    pub capabilities: Vec<String>,
    pub rank: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetHierarchyRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "reportsTo")]
    pub reports_to: Option<String>,
    pub title: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub rank: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TreeRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "rootAgentId")]
    pub root_agent_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FindByCapabilityRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    pub capability: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChainRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TreeNode {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub title: Option<String>,
    pub capabilities: Vec<String>,
    pub rank: u32,
    pub reports: Vec<TreeNode>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_hierarchy_node() {
        let val = json!({
            "agentId": "a-1",
            "realmId": "r-1",
            "reportsTo": "a-0",
            "title": "Lead Engineer",
            "capabilities": ["code", "review"],
            "rank": 2
        });
        let node: HierarchyNode = serde_json::from_value(val).unwrap();
        assert_eq!(node.agent_id, "a-1");
        assert_eq!(node.reports_to, Some("a-0".into()));
        assert_eq!(node.capabilities.len(), 2);
    }

    #[test]
    fn test_tree_node_recursive() {
        let tree = TreeNode {
            agent_id: "root".into(),
            title: Some("CEO".into()),
            capabilities: vec!["strategy".into()],
            rank: 0,
            reports: vec![TreeNode {
                agent_id: "eng-lead".into(),
                title: Some("Eng Lead".into()),
                capabilities: vec!["code".into()],
                rank: 1,
                reports: vec![],
            }],
        };
        assert_eq!(tree.reports.len(), 1);
        assert_eq!(tree.reports[0].agent_id, "eng-lead");
    }
}

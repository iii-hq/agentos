use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentSkillRef {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct A2aCapabilities {
    pub tools: Vec<String>,
    pub streaming: bool,
    #[serde(rename = "pushNotifications")]
    pub push_notifications: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct A2aAuthentication {
    pub schemes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct A2aAgentCard {
    pub name: String,
    pub description: String,
    pub url: String,
    pub capabilities: A2aCapabilities,
    pub skills: Vec<AgentSkillRef>,
    pub authentication: A2aAuthentication,
    #[serde(rename = "defaultInputModes")]
    pub default_input_modes: Vec<String>,
    #[serde(rename = "defaultOutputModes")]
    pub default_output_modes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateCardRequest {
    #[serde(rename = "agentId")]
    pub agent_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_agent_card_round_trip() {
        let card = A2aAgentCard {
            name: "agentos".into(),
            description: "test agent".into(),
            url: "http://localhost:3111/api/a2a/agents/x".into(),
            capabilities: A2aCapabilities {
                tools: vec!["tool::a".into()],
                streaming: true,
                push_notifications: false,
            },
            skills: vec![AgentSkillRef {
                id: "s1".into(),
                name: "Skill".into(),
                description: "desc".into(),
            }],
            authentication: A2aAuthentication {
                schemes: vec!["bearer".into()],
            },
            default_input_modes: vec!["text".into()],
            default_output_modes: vec!["text".into()],
        };
        let val = serde_json::to_value(&card).unwrap();
        assert_eq!(val["capabilities"]["pushNotifications"], json!(false));
        assert_eq!(val["defaultInputModes"], json!(["text"]));
        let back: A2aAgentCard = serde_json::from_value(val).unwrap();
        assert_eq!(back.name, "agentos");
        assert_eq!(back.capabilities.tools, vec!["tool::a"]);
    }

    #[test]
    fn test_generate_card_request() {
        let val = json!({ "agentId": "agent-1" });
        let req: GenerateCardRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.agent_id, "agent-1");
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Part {
    Text { text: String },
    File { file: FileBody },
    Data { data: serde_json::Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBody {
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub bytes: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aMessage {
    pub role: Role,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<A2aMessage>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aTask {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub history: Vec<A2aMessage>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub name: String,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardCapabilities {
    pub streaming: bool,
    #[serde(rename = "pushNotifications")]
    pub push_notifications: bool,
    #[serde(rename = "stateTransitionHistory")]
    pub state_transition_history: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardAuth {
    pub schemes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCard {
    pub name: String,
    pub description: String,
    pub url: String,
    pub version: String,
    pub capabilities: AgentCardCapabilities,
    pub skills: Vec<AgentSkill>,
    pub authentication: AgentCardAuth,
    #[serde(rename = "defaultInputModes")]
    pub default_input_modes: Vec<String>,
    #[serde(rename = "defaultOutputModes")]
    pub default_output_modes: Vec<String>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_task_state_serialization() {
        assert_eq!(serde_json::to_string(&TaskState::Submitted).unwrap(), "\"submitted\"");
        assert_eq!(
            serde_json::to_string(&TaskState::InputRequired).unwrap(),
            "\"input-required\""
        );
        assert_eq!(
            serde_json::to_string(&TaskState::Completed).unwrap(),
            "\"completed\""
        );
    }

    #[test]
    fn test_part_text_serialization() {
        let p = Part::Text { text: "hello".into() };
        let val = serde_json::to_value(&p).unwrap();
        assert_eq!(val, json!({ "type": "text", "text": "hello" }));
        let back: Part = serde_json::from_value(val).unwrap();
        match back {
            Part::Text { text } => assert_eq!(text, "hello"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_part_data_serialization() {
        let p = Part::Data { data: json!({ "k": "v" }) };
        let val = serde_json::to_value(&p).unwrap();
        assert_eq!(val["type"], json!("data"));
        assert_eq!(val["data"], json!({"k": "v"}));
    }

    #[test]
    fn test_message_round_trip() {
        let msg = A2aMessage {
            role: Role::User,
            parts: vec![Part::Text { text: "hi".into() }],
        };
        let val = serde_json::to_value(&msg).unwrap();
        assert_eq!(val["role"], json!("user"));
        let back: A2aMessage = serde_json::from_value(val).unwrap();
        assert_eq!(back.role, Role::User);
        assert_eq!(back.parts.len(), 1);
    }

    #[test]
    fn test_agent_card_round_trip() {
        let card = AgentCard {
            name: "agentos".into(),
            description: "test".into(),
            url: "http://x".into(),
            version: "0.0.1".into(),
            capabilities: AgentCardCapabilities {
                streaming: false,
                push_notifications: false,
                state_transition_history: true,
            },
            skills: vec![],
            authentication: AgentCardAuth {
                schemes: vec!["bearer".into()],
            },
            default_input_modes: vec!["text/plain".into()],
            default_output_modes: vec!["text/plain".into()],
        };
        let val = serde_json::to_value(&card).unwrap();
        assert_eq!(val["capabilities"]["stateTransitionHistory"], json!(true));
        assert_eq!(val["defaultInputModes"], json!(["text/plain"]));
        let back: AgentCard = serde_json::from_value(val).unwrap();
        assert_eq!(back.name, "agentos");
    }

    #[test]
    fn test_task_round_trip() {
        let task = A2aTask {
            id: "t-1".into(),
            session_id: "s-1".into(),
            status: TaskStatus {
                state: TaskState::Working,
                message: None,
                timestamp: "2026-01-01T00:00:00Z".into(),
            },
            history: vec![],
            artifacts: vec![],
            metadata: json!({}),
            created_at: 1_700_000_000_000,
        };
        let val = serde_json::to_value(&task).unwrap();
        assert_eq!(val["sessionId"], json!("s-1"));
        let back: A2aTask = serde_json::from_value(val).unwrap();
        assert_eq!(back.session_id, "s-1");
    }
}

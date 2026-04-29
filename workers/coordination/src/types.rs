use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub topic: String,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default)]
    pub pinned: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub id: String,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub content: String,
    #[serde(rename = "parentId", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default = "default_metadata")]
    pub metadata: serde_json::Value,
}

fn default_metadata() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PostRequest {
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    pub content: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ReplyRequest {
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    pub content: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ReadRequest {
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct PinRequest {
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[serde(rename = "postId")]
    pub post_id: Option<String>,
    pub unpin: Option<bool>,
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
    fn test_channel_round_trip() {
        let ch = Channel {
            id: "c-1".into(),
            name: "general".into(),
            topic: "talk".into(),
            created_by: "a-1".into(),
            created_at: 1_700_000_000_000,
            pinned: vec!["p-1".into()],
        };
        let val = serde_json::to_value(&ch).unwrap();
        assert_eq!(val["createdBy"], json!("a-1"));
        assert_eq!(val["pinned"], json!(["p-1"]));
        let back: Channel = serde_json::from_value(val).unwrap();
        assert_eq!(back.id, "c-1");
    }

    #[test]
    fn test_post_round_trip() {
        let p = Post {
            id: "p-1".into(),
            channel_id: "c-1".into(),
            agent_id: "a-1".into(),
            content: "hello".into(),
            parent_id: Some("p-0".into()),
            created_at: 1_700_000_000_000,
            metadata: json!({"k": "v"}),
        };
        let val = serde_json::to_value(&p).unwrap();
        assert_eq!(val["parentId"], json!("p-0"));
        let back: Post = serde_json::from_value(val).unwrap();
        assert_eq!(back.parent_id.as_deref(), Some("p-0"));
    }

    #[test]
    fn test_create_channel_parses() {
        let val = json!({ "name": "general", "agentId": "a-1" });
        let req: CreateChannelRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.name.as_deref(), Some("general"));
        assert_eq!(req.agent_id.as_deref(), Some("a-1"));
    }

    #[test]
    fn test_sanitize_id() {
        assert!(sanitize_id("good-id").is_ok());
        assert!(sanitize_id("bad/id").is_err());
        assert!(sanitize_id("").is_err());
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReplayEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub action: String,
    #[serde(default)]
    pub data: Value,
    #[serde(rename = "durationMs", default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub iteration: i64,
    #[serde(default)]
    pub sequence: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replay_entry_round_trip() {
        let entry = ReplayEntry {
            session_id: "s1".into(),
            agent_id: "a1".into(),
            action: "tool_call".into(),
            data: json!({ "toolId": "read" }),
            duration_ms: 100,
            timestamp: 1000,
            iteration: 1,
            sequence: 3,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["durationMs"], 100);
        let back: ReplayEntry = serde_json::from_value(value).unwrap();
        assert_eq!(back.session_id, "s1");
        assert_eq!(back.duration_ms, 100);
    }

    #[test]
    fn replay_entry_defaults() {
        let val = json!({
            "sessionId": "s2",
            "agentId": "a2",
            "action": "llm_call"
        });
        let entry: ReplayEntry = serde_json::from_value(val).unwrap();
        assert_eq!(entry.duration_ms, 0);
        assert_eq!(entry.iteration, 0);
    }
}

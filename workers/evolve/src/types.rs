use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SecurityReport {
    #[serde(rename = "scanSafe")]
    pub scan_safe: bool,
    #[serde(rename = "sandboxPassed")]
    pub sandbox_passed: bool,
    #[serde(rename = "findingCount")]
    pub finding_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolvedFunction {
    #[serde(rename = "functionId")]
    pub function_id: String,
    pub code: String,
    pub description: String,
    #[serde(rename = "authorAgentId")]
    pub author_agent_id: String,
    pub version: u32,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "evalScores")]
    pub eval_scores: Option<Value>,
    #[serde(rename = "securityReport")]
    pub security_report: SecurityReport,
    #[serde(rename = "parentVersion", skip_serializing_if = "Option::is_none")]
    pub parent_version: Option<String>,
    pub metadata: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_security_report_round_trip() {
        let r = SecurityReport {
            scan_safe: true,
            sandbox_passed: false,
            finding_count: 2,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["scanSafe"], json!(true));
        assert_eq!(v["sandboxPassed"], json!(false));
        assert_eq!(v["findingCount"], json!(2));
    }

    #[test]
    fn test_evolved_function_serializes_camel_case() {
        let f = EvolvedFunction {
            function_id: "evolved::foo_v1".into(),
            code: "()=>{}".into(),
            description: "test".into(),
            author_agent_id: "a-1".into(),
            version: 1,
            status: "draft".into(),
            created_at: 100,
            updated_at: 100,
            eval_scores: None,
            security_report: SecurityReport::default(),
            parent_version: None,
            metadata: json!({}),
        };
        let v = serde_json::to_value(&f).unwrap();
        assert!(v.get("functionId").is_some());
        assert!(v.get("authorAgentId").is_some());
        assert!(v.get("createdAt").is_some());
        assert!(v.get("evalScores").is_some());
        assert!(v.get("securityReport").is_some());
        assert!(v.get("parentVersion").is_none());
    }

    #[test]
    fn test_evolved_function_parses_with_parent_version() {
        let v = json!({
            "functionId": "evolved::bar_v2",
            "code": "() => 1",
            "description": "next",
            "authorAgentId": "a-1",
            "version": 2,
            "status": "draft",
            "createdAt": 100,
            "updatedAt": 200,
            "evalScores": null,
            "securityReport": {
                "scanSafe": false,
                "sandboxPassed": false,
                "findingCount": 0,
            },
            "parentVersion": "evolved::bar_v1",
            "metadata": { "tag": "x" },
        });
        let f: EvolvedFunction = serde_json::from_value(v).unwrap();
        assert_eq!(f.version, 2);
        assert_eq!(f.parent_version.as_deref(), Some("evolved::bar_v1"));
    }
}

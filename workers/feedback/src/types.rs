use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FeedbackPolicy {
    #[serde(rename = "minScoreToKeep")]
    pub min_score_to_keep: f64,
    #[serde(rename = "minEvalsToPromote")]
    pub min_evals_to_promote: u32,
    #[serde(rename = "maxFailuresToKill")]
    pub max_failures_to_kill: u32,
    #[serde(rename = "autoReviewIntervalMs")]
    pub auto_review_interval_ms: i64,
}

impl FeedbackPolicy {
    pub const DEFAULT: FeedbackPolicy = FeedbackPolicy {
        min_score_to_keep: 0.5,
        min_evals_to_promote: 5,
        max_failures_to_kill: 3,
        auto_review_interval_ms: 6 * 60 * 60 * 1000,
    };
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewResult {
    #[serde(rename = "decisionId")]
    pub decision_id: String,
    #[serde(rename = "functionId")]
    pub function_id: String,
    pub decision: String,
    pub reason: String,
    #[serde(rename = "avgOverall")]
    pub avg_overall: f64,
    #[serde(rename = "recentFailures")]
    pub recent_failures: u32,
    #[serde(rename = "evalCount")]
    pub eval_count: u32,
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_policy_defaults() {
        let p = FeedbackPolicy::DEFAULT;
        assert!((p.min_score_to_keep - 0.5).abs() < 1e-9);
        assert_eq!(p.min_evals_to_promote, 5);
        assert_eq!(p.max_failures_to_kill, 3);
        assert_eq!(p.auto_review_interval_ms, 6 * 60 * 60 * 1000);
    }

    #[test]
    fn test_policy_round_trip_camel_case() {
        let p = FeedbackPolicy::DEFAULT;
        let v = serde_json::to_value(p).unwrap();
        assert!(v.get("minScoreToKeep").is_some());
        assert!(v.get("minEvalsToPromote").is_some());
        assert!(v.get("maxFailuresToKill").is_some());
        assert!(v.get("autoReviewIntervalMs").is_some());
    }

    #[test]
    fn test_review_result_round_trip() {
        let r = ReviewResult {
            decision_id: "d-1".into(),
            function_id: "evolved::foo_v1".into(),
            decision: "keep".into(),
            reason: "ok".into(),
            avg_overall: 0.8,
            recent_failures: 0,
            eval_count: 5,
            timestamp: 1000,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["decisionId"], json!("d-1"));
        assert_eq!(v["avgOverall"], json!(0.8));
        assert_eq!(v["recentFailures"], json!(0));
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalScores {
    pub correctness: Option<f64>,
    pub latency_ms: i64,
    pub cost_tokens: i64,
    pub safety: f64,
    pub overall: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalResult {
    #[serde(rename = "evalId")]
    pub eval_id: String,
    #[serde(rename = "functionId")]
    pub function_id: String,
    pub scores: EvalScores,
    #[serde(rename = "scorerType")]
    pub scorer_type: String,
    pub input: Value,
    pub output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalTestCase {
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scorer: Option<String>,
    #[serde(
        default,
        rename = "scorerFunctionId",
        skip_serializing_if = "Option::is_none"
    )]
    pub scorer_function_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalSuite {
    #[serde(rename = "suiteId")]
    pub suite_id: String,
    pub name: String,
    #[serde(rename = "functionId")]
    pub function_id: String,
    #[serde(rename = "testCases")]
    pub test_cases: Vec<EvalTestCase>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_eval_scores_round_trip() {
        let scores = EvalScores {
            correctness: Some(0.9),
            latency_ms: 150,
            cost_tokens: 100,
            safety: 1.0,
            overall: 0.85,
        };
        let v = serde_json::to_value(&scores).unwrap();
        let back: EvalScores = serde_json::from_value(v).unwrap();
        assert_eq!(back.correctness, Some(0.9));
        assert_eq!(back.latency_ms, 150);
    }

    #[test]
    fn test_eval_result_serializes_camel_case() {
        let result = EvalResult {
            eval_id: "ev-1".into(),
            function_id: "test::fn".into(),
            scores: EvalScores {
                correctness: None,
                latency_ms: 0,
                cost_tokens: 0,
                safety: 1.0,
                overall: 0.0,
            },
            scorer_type: "exact_match".into(),
            input: json!({}),
            output: json!({}),
            expected: None,
            timestamp: 1000,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert!(v.get("evalId").is_some());
        assert!(v.get("functionId").is_some());
        assert!(v.get("scorerType").is_some());
        assert!(v.get("expected").is_none());
    }

    #[test]
    fn test_eval_suite_round_trip() {
        let suite_json = json!({
            "suiteId": "s-1",
            "name": "Test Suite",
            "functionId": "evolved::doubler_v1",
            "testCases": [
                { "input": { "x": 1 }, "expected": { "y": 2 }, "weight": 2.0 },
                { "input": { "x": 5 }, "scorer": "exact_match" },
            ],
            "createdAt": 1000,
        });
        let suite: EvalSuite = serde_json::from_value(suite_json).unwrap();
        assert_eq!(suite.test_cases.len(), 2);
        assert_eq!(suite.test_cases[0].weight, Some(2.0));
        assert_eq!(suite.test_cases[1].scorer.as_deref(), Some("exact_match"));
    }
}

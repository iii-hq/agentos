use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AlertSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Budget {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "monthlyCents")]
    pub monthly_cents: u64,
    #[serde(rename = "spentCents")]
    pub spent_cents: u64,
    #[serde(rename = "softThreshold")]
    pub soft_threshold: f64,
    #[serde(rename = "hardLimit")]
    pub hard_limit: bool,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
    pub version: u64,
    #[serde(rename = "periodStart")]
    pub period_start: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetBudgetRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "monthlyCents")]
    pub monthly_cents: u64,
    #[serde(rename = "softThreshold")]
    pub soft_threshold: Option<f64>,
    #[serde(rename = "hardLimit")]
    pub hard_limit: Option<bool>,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecordSpendRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "costCents")]
    pub cost_cents: u64,
    pub provider: String,
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "missionId")]
    pub mission_id: Option<String>,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckBudgetRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BudgetCheckResult {
    pub allowed: bool,
    #[serde(rename = "spentCents")]
    pub spent_cents: u64,
    #[serde(rename = "limitCents")]
    pub limit_cents: u64,
    #[serde(rename = "remainingCents")]
    pub remaining_cents: u64,
    #[serde(rename = "utilizationPct")]
    pub utilization_pct: f64,
    pub alert: Option<AlertSeverity>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SummaryRequest {
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "groupBy")]
    pub group_by: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpendEvent {
    pub id: String,
    #[serde(rename = "realmId")]
    pub realm_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "costCents")]
    pub cost_cents: u64,
    pub provider: String,
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "missionId")]
    pub mission_id: Option<String>,
    #[serde(rename = "billingCode")]
    pub billing_code: Option<String>,
    pub timestamp: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_budget_with_version() {
        let budget = Budget {
            id: "b-1".into(),
            realm_id: "r-1".into(),
            agent_id: Some("a-1".into()),
            monthly_cents: 10000,
            spent_cents: 5000,
            soft_threshold: 0.8,
            hard_limit: true,
            billing_code: None,
            version: 3,
            period_start: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-15T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&budget).unwrap();
        assert_eq!(json["version"], 3);
        let back: Budget = serde_json::from_value(json).unwrap();
        assert_eq!(back.version, 3);
        assert_eq!(back.spent_cents, 5000);
    }

    #[test]
    fn test_budget_check_result() {
        let result = BudgetCheckResult {
            allowed: true,
            spent_cents: 4000,
            limit_cents: 10000,
            remaining_cents: 6000,
            utilization_pct: 40.0,
            alert: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["allowed"], true);
        assert_eq!(json["utilizationPct"], 40.0);
    }

    #[test]
    fn test_alert_at_threshold() {
        let result = BudgetCheckResult {
            allowed: true,
            spent_cents: 8500,
            limit_cents: 10000,
            remaining_cents: 1500,
            utilization_pct: 85.0,
            alert: Some(AlertSeverity::Warning),
        };
        assert_eq!(result.alert, Some(AlertSeverity::Warning));
    }

    #[test]
    fn test_record_spend() {
        let val = json!({
            "realmId": "r-1",
            "agentId": "a-1",
            "costCents": 150,
            "provider": "anthropic",
            "model": "claude-sonnet",
            "inputTokens": 1000,
            "outputTokens": 500
        });
        let req: RecordSpendRequest = serde_json::from_value(val).unwrap();
        assert_eq!(req.cost_cents, 150);
    }
}

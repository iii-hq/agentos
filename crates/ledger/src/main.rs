use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{
    AlertSeverity, Budget, BudgetCheckResult, CheckBudgetRequest, RecordSpendRequest,
    SetBudgetRequest, SpendEvent, SummaryRequest,
};

fn budget_scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:budgets")
}

fn spend_scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:spend")
}

async fn set_budget(iii: &III, req: SetBudgetRequest) -> Result<Value, IIIError> {
    let key = req
        .agent_id
        .as_deref()
        .unwrap_or("realm")
        .to_string();

    let existing = iii
        .trigger("state::get", json!({
            "scope": budget_scope(&req.realm_id),
            "key": &key,
        }))
        .await
        .ok()
        .and_then(|v| serde_json::from_value::<Budget>(v).ok());

    let (spent, version, period_start, id) = match existing {
        Some(b) => (b.spent_cents, b.version + 1, b.period_start, b.id),
        None => (0, 1, chrono::Utc::now().to_rfc3339(), format!("bgt-{}", uuid::Uuid::new_v4())),
    };

    let budget = Budget {
        id,
        realm_id: req.realm_id.clone(),
        agent_id: req.agent_id,
        monthly_cents: req.monthly_cents,
        spent_cents: spent,
        soft_threshold: req.soft_threshold.unwrap_or(0.8),
        hard_limit: req.hard_limit.unwrap_or(true),
        billing_code: req.billing_code,
        version,
        period_start,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    let value = serde_json::to_value(&budget).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": budget_scope(&req.realm_id),
        "key": key,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(serde_json::to_value(&budget).unwrap())
}

async fn check_budget(iii: &III, req: CheckBudgetRequest) -> Result<Value, IIIError> {
    let agent_budget = iii
        .trigger("state::get", json!({
            "scope": budget_scope(&req.realm_id),
            "key": &req.agent_id,
        }))
        .await
        .ok();

    let realm_budget = iii
        .trigger("state::get", json!({
            "scope": budget_scope(&req.realm_id),
            "key": "realm",
        }))
        .await
        .ok();

    let budget: Option<Budget> = agent_budget
        .and_then(|v| serde_json::from_value(v).ok())
        .or_else(|| realm_budget.and_then(|v| serde_json::from_value(v).ok()));

    let budget = match budget {
        Some(b) => b,
        None => {
            return Ok(json!(BudgetCheckResult {
                allowed: true,
                spent_cents: 0,
                limit_cents: 0,
                remaining_cents: 0,
                utilization_pct: 0.0,
                alert: None,
            }));
        }
    };

    let utilization = if budget.monthly_cents > 0 {
        (budget.spent_cents as f64 / budget.monthly_cents as f64) * 100.0
    } else {
        0.0
    };

    let alert = if utilization >= 100.0 {
        Some(AlertSeverity::Critical)
    } else if utilization >= budget.soft_threshold * 100.0 {
        Some(AlertSeverity::Warning)
    } else {
        None
    };

    let allowed = !(budget.hard_limit && utilization >= 100.0);

    let remaining = budget.monthly_cents.saturating_sub(budget.spent_cents);

    let result = BudgetCheckResult {
        allowed,
        spent_cents: budget.spent_cents,
        limit_cents: budget.monthly_cents,
        remaining_cents: remaining,
        utilization_pct: utilization,
        alert,
    };

    Ok(serde_json::to_value(&result).unwrap())
}

async fn record_spend(iii: &III, req: RecordSpendRequest) -> Result<Value, IIIError> {
    let check = check_budget(iii, CheckBudgetRequest {
        realm_id: req.realm_id.clone(),
        agent_id: req.agent_id.clone(),
    })
    .await?;

    let check_result: BudgetCheckResult =
        serde_json::from_value(check).map_err(|e| IIIError::Handler(e.to_string()))?;

    if !check_result.allowed {
        let _ = iii.trigger_void("publish", json!({
            "topic": "ledger.alert",
            "data": {
                "type": "hard_limit_reached",
                "realmId": req.realm_id,
                "agentId": req.agent_id,
                "spentCents": check_result.spent_cents,
                "limitCents": check_result.limit_cents,
            },
        }));

        let _ = iii.trigger(
            "council::activity",
            json!({
                "realmId": req.realm_id,
                "actorKind": "system",
                "actorId": "ledger",
                "action": "budget_exceeded",
                "entityType": "agent",
                "entityId": req.agent_id,
                "details": { "spentCents": check_result.spent_cents, "limitCents": check_result.limit_cents },
            }),
        ).await;

        return Err(IIIError::Handler(format!(
            "agent {} exceeded budget: {}/{}",
            req.agent_id, check_result.spent_cents, check_result.limit_cents
        )));
    }

    let event = SpendEvent {
        id: format!("spn-{}", uuid::Uuid::new_v4()),
        realm_id: req.realm_id.clone(),
        agent_id: req.agent_id.clone(),
        cost_cents: req.cost_cents,
        provider: req.provider,
        model: req.model,
        input_tokens: req.input_tokens,
        output_tokens: req.output_tokens,
        mission_id: req.mission_id,
        billing_code: req.billing_code,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    let value = serde_json::to_value(&event).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": spend_scope(&req.realm_id),
        "key": event.id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let budget_val = iii
        .trigger("state::get", json!({
            "scope": budget_scope(&req.realm_id),
            "key": &req.agent_id,
        }))
        .await
        .ok();

    if let Some(val) = budget_val {
        if let Ok(mut budget) = serde_json::from_value::<Budget>(val) {
            let prev_version = budget.version;
            budget.spent_cents += req.cost_cents;
            budget.version = prev_version + 1;
            budget.updated_at = chrono::Utc::now().to_rfc3339();

            let updated = serde_json::to_value(&budget).map_err(|e| IIIError::Handler(e.to_string()))?;
            let _ = iii
                .trigger("state::set", json!({
                    "scope": budget_scope(&req.realm_id),
                    "key": &req.agent_id,
                    "value": updated,
                    "expectedVersion": prev_version,
                }))
                .await;

            let utilization = (budget.spent_cents as f64 / budget.monthly_cents as f64) * 100.0;
            if utilization >= budget.soft_threshold * 100.0 && utilization < 100.0 {
                let _ = iii.trigger_void("publish", json!({
                    "topic": "ledger.alert",
                    "data": {
                        "type": "soft_threshold",
                        "realmId": req.realm_id,
                        "agentId": req.agent_id,
                        "utilizationPct": utilization,
                    },
                }));
            }
        }
    }

    Ok(serde_json::to_value(&event).unwrap())
}

async fn get_summary(iii: &III, req: SummaryRequest) -> Result<Value, IIIError> {
    let events = iii
        .trigger("state::list", json!({ "scope": spend_scope(&req.realm_id) }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let spend_events: Vec<SpendEvent> = events
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    let total_cents: u64 = spend_events.iter().map(|e| e.cost_cents).sum();
    let total_input: u64 = spend_events.iter().map(|e| e.input_tokens).sum();
    let total_output: u64 = spend_events.iter().map(|e| e.output_tokens).sum();

    let group_by = req.group_by.as_deref().unwrap_or("agent");
    let mut groups: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    for event in &spend_events {
        let key = match group_by {
            "agent" => event.agent_id.clone(),
            "model" => event.model.clone(),
            "provider" => event.provider.clone(),
            "billing_code" => event.billing_code.clone().unwrap_or_else(|| "none".into()),
            _ => event.agent_id.clone(),
        };
        *groups.entry(key).or_default() += event.cost_cents;
    }

    Ok(json!({
        "totalCents": total_cents,
        "totalInputTokens": total_input,
        "totalOutputTokens": total_output,
        "eventCount": spend_events.len(),
        "breakdown": groups,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "ledger::set_budget",
        "Set budget for realm or agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: SetBudgetRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                set_budget(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "ledger::check",
        "Check if agent is within budget",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CheckBudgetRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                check_budget(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "ledger::spend",
        "Record a spend event and enforce budget",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: RecordSpendRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                record_spend(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "ledger::summary",
        "Get spend summary with breakdowns",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: SummaryRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                get_summary(&iii, req).await
            }
        },
    );

    iii.register_trigger("http", "ledger::set_budget", json!({ "method": "POST", "path": "/api/ledger/budget" }))?;
    iii.register_trigger("http", "ledger::check", json!({ "method": "GET", "path": "/api/ledger/check/:realmId/:agentId" }))?;
    iii.register_trigger("http", "ledger::spend", json!({ "method": "POST", "path": "/api/ledger/spend" }))?;
    iii.register_trigger("http", "ledger::summary", json!({ "method": "GET", "path": "/api/ledger/summary/:realmId" }))?;

    iii.register_trigger("subscribe", "ledger::spend", json!({ "topic": "cost.incurred" }))?;

    tracing::info!("ledger worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

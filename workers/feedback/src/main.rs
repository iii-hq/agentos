use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{FeedbackPolicy, ReviewResult};

const MAX_IMPROVE_DEPTH: u32 = 3;

const VALID_SIGNAL_TYPES: &[&str] = &[
    "ci_failure",
    "review_comment",
    "merge_conflict",
    "dependency_update",
    "custom",
];

fn signal_prefix(signal_type: &str) -> &'static str {
    match signal_type {
        "ci_failure" => "[CI Failure]",
        "review_comment" => "[Review Comment]",
        "merge_conflict" => "[Merge Conflict]",
        "dependency_update" => "[Dependency Update]",
        _ => "[Signal]",
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn generate_decision_id() -> String {
    format!("dec_{}_{}", now_ms(), uuid::Uuid::new_v4().simple())
}

fn unwrap_body(input: &Value) -> Value {
    if let Some(body) = input.get("body")
        && !body.is_null()
    {
        return body.clone();
    }
    input.clone()
}

fn sanitize_id(id: &str) -> Result<String, IIIError> {
    if id.is_empty() || id.len() > 256 {
        return Err(IIIError::Handler(format!("Invalid ID format: {id}")));
    }
    let valid = id.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':' || c == '.'
    });
    if !valid {
        return Err(IIIError::Handler(format!("Invalid ID format: {id}")));
    }
    Ok(id.to_string())
}

async fn safe_trigger(iii: &III, function_id: &str, payload: Value) -> Option<Value> {
    iii.trigger(TriggerRequest {
        function_id: function_id.to_string(),
        payload,
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": scope,
            "key": key,
            "value": value,
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    safe_trigger(iii, "state::get", json!({ "scope": scope, "key": key })).await
}

async fn state_list(iii: &III, scope: &str) -> Vec<Value> {
    safe_trigger(iii, "state::list", json!({ "scope": scope }))
        .await
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn entries_to_records(entries: Vec<Value>) -> Vec<Value> {
    entries
        .into_iter()
        .map(|e| e.get("value").cloned().unwrap_or(e))
        .collect()
}

async fn get_policy(iii: &III) -> FeedbackPolicy {
    let stored = state_get(iii, "feedback_policy", "default")
        .await
        .filter(|v| !v.is_null());
    let stored = match stored {
        Some(v) => v,
        None => return FeedbackPolicy::DEFAULT,
    };

    let mut p = FeedbackPolicy::DEFAULT;
    if let Some(v) = stored.get("minScoreToKeep").and_then(|v| v.as_f64()) {
        p.min_score_to_keep = v;
    }
    if let Some(v) = stored.get("minEvalsToPromote").and_then(|v| v.as_u64()) {
        p.min_evals_to_promote = v as u32;
    }
    if let Some(v) = stored.get("maxFailuresToKill").and_then(|v| v.as_u64()) {
        p.max_failures_to_kill = v as u32;
    }
    if let Some(v) = stored.get("autoReviewIntervalMs").and_then(|v| v.as_i64()) {
        p.auto_review_interval_ms = v;
    }
    p
}

async fn get_recent_evals(iii: &III, function_id: &str, limit: usize) -> Vec<Value> {
    let entries = state_list(iii, "eval_results").await;
    let mut results: Vec<Value> = entries_to_records(entries)
        .into_iter()
        .filter(|r| r.get("functionId").and_then(|v| v.as_str()) == Some(function_id))
        .collect();
    results.sort_by(|a, b| {
        let ta = a.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    results.truncate(limit);
    results
}

fn correctness_of(eval: &Value) -> Option<f64> {
    eval.get("scores")
        .and_then(|s| s.get("correctness"))
        .and_then(|v| v.as_f64())
}

fn overall_of(eval: &Value) -> f64 {
    eval.get("scores")
        .and_then(|s| s.get("overall"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

fn safety_of(eval: &Value) -> f64 {
    eval.get("scores")
        .and_then(|s| s.get("safety"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
}

/// Centralized promotion-eligibility check.
/// Both `feedback::review` and `feedback::promote` must use this to decide
/// whether a function has sufficient data + score to keep its current standing.
struct PromotionCheck {
    eligible: bool,
    reason: Option<String>,
    #[allow(dead_code)]
    avg_overall: f64,
}

fn check_promotion_eligibility(evals: &[Value], policy: &FeedbackPolicy) -> PromotionCheck {
    if (evals.len() as u32) < policy.min_evals_to_promote {
        return PromotionCheck {
            eligible: false,
            reason: Some(format!(
                "Need {} evals, have {}",
                policy.min_evals_to_promote,
                evals.len()
            )),
            avg_overall: 0.0,
        };
    }
    let avg_overall: f64 = if evals.is_empty() {
        0.0
    } else {
        evals.iter().map(overall_of).sum::<f64>() / evals.len() as f64
    };
    if avg_overall < policy.min_score_to_keep {
        return PromotionCheck {
            eligible: false,
            reason: Some(format!(
                "Average score {avg_overall:.3} below threshold {}",
                policy.min_score_to_keep
            )),
            avg_overall,
        };
    }
    PromotionCheck {
        eligible: true,
        reason: None,
        avg_overall,
    }
}

async fn feedback_review(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();

    let policy = get_policy(iii).await;
    let recent = get_recent_evals(iii, &function_id, 5).await;

    if recent.is_empty() {
        let result = ReviewResult {
            decision_id: generate_decision_id(),
            function_id: function_id.clone(),
            decision: "keep".into(),
            reason: "No eval data yet".into(),
            avg_overall: 0.0,
            recent_failures: 0,
            eval_count: 0,
            timestamp: now_ms(),
        };
        let value = serde_json::to_value(&result).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(
            iii,
            "feedback_decisions",
            &format!("{}:{}", function_id, result.decision_id),
            value.clone(),
        )
        .await?;
        return Ok::<Value, IIIError>(value);
    }

    let recent_failures = recent
        .iter()
        .filter(|r| {
            correctness_of(r)
                .is_some_and(|c| c < 0.5)
        })
        .count() as u32;

    let avg_overall: f64 = recent.iter().map(overall_of).sum::<f64>() / recent.len() as f64;

    let (decision, reason) = if recent_failures >= policy.max_failures_to_kill {
        (
            "kill",
            format!(
                "{recent_failures} failures in last {} evals (threshold: {})",
                recent.len(),
                policy.max_failures_to_kill
            ),
        )
    } else {
        // CR fix: review must enforce the same promotion-eligibility rules as
        // feedback::promote. A review can only confidently "keep" when there
        // are enough evals AND the average score clears the threshold.
        let promo = check_promotion_eligibility(&recent, &policy);
        if !promo.eligible {
            // Below the keep threshold (either too few evals or too low score)
            // → mark for improvement.
            (
                "improve",
                promo.reason.unwrap_or_else(|| {
                    format!(
                        "Average overall score {avg_overall:.3} below threshold {}",
                        policy.min_score_to_keep
                    )
                }),
            )
        } else {
            (
                "keep",
                format!("Passing: avg overall {avg_overall:.3}, {recent_failures} failures"),
            )
        }
    };

    let result = ReviewResult {
        decision_id: generate_decision_id(),
        function_id: function_id.clone(),
        decision: decision.to_string(),
        reason: reason.clone(),
        avg_overall,
        recent_failures,
        eval_count: recent.len() as u32,
        timestamp: now_ms(),
    };
    let value = serde_json::to_value(&result).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(
        iii,
        "feedback_decisions",
        &format!("{}:{}", function_id, result.decision_id),
        value.clone(),
    )
    .await?;

    if decision == "kill" {
        if let Some(mut fn_record) = state_get(iii, "evolved_functions", &function_id).await
            && !fn_record.is_null()
        {
            if let Some(obj) = fn_record.as_object_mut() {
                obj.insert("status".to_string(), json!("killed"));
                obj.insert("updatedAt".to_string(), json!(now_ms()));
            }
            state_set(iii, "evolved_functions", &function_id, fn_record).await?;
        }
    } else if decision == "improve" {
        let iii_inner = iii.clone();
        let payload = json!({
            "headers": { "authorization": "Bearer internal" },
            "body": { "functionId": function_id, "depth": 0 },
            "functionId": function_id,
            "depth": 0,
        });
        tokio::spawn(async move {
            let _ = iii_inner
                .trigger(TriggerRequest {
                    function_id: "feedback::improve".to_string(),
                    payload,
                    action: None,
                    timeout_ms: None,
                })
                .await;
        });
    }

    Ok::<Value, IIIError>(value)
}

async fn feedback_improve(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let depth = body.get("depth").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let suite_id = body.get("suiteId").and_then(|v| v.as_str()).map(String::from);

    if depth >= MAX_IMPROVE_DEPTH {
        return Ok::<Value, IIIError>(json!({
            "improved": false,
            "reason": format!("Max improvement depth {MAX_IMPROVE_DEPTH} reached"),
            "depth": depth,
        }));
    }

    let fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;

    let recent_evals = get_recent_evals(iii, &function_id, 5).await;
    let failure_descriptions: Vec<String> = recent_evals
        .iter()
        .filter(|r| correctness_of(r).is_some_and(|c| c < 0.5))
        .take(3)
        .map(|r| {
            let input_s = serde_json::to_string(r.get("input").unwrap_or(&Value::Null))
                .unwrap_or_default();
            let expected_s = serde_json::to_string(r.get("expected").unwrap_or(&Value::Null))
                .unwrap_or_default();
            let output_s = serde_json::to_string(r.get("output").unwrap_or(&Value::Null))
                .unwrap_or_default();
            let take200 = |s: &str| s.chars().take(200).collect::<String>();
            format!(
                "Input: {}, Expected: {}, Got: {}",
                take200(&input_s),
                take200(&expected_s),
                take200(&output_s),
            )
        })
        .collect();

    let fn_code = fn_val.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let feedback_spec = format!(
        "Previous version failed on these cases:\n{}\n\nPrevious code:\n{fn_code}\n\nFix the issues and improve correctness.",
        failure_descriptions.join("\n")
    );

    let function_id_str = fn_val.get("functionId").and_then(|v| v.as_str()).unwrap_or(&function_id);
    let base_name = base_name_from(function_id_str);
    let agent_id = fn_val
        .get("authorAgentId")
        .and_then(|v| v.as_str())
        .unwrap_or("system")
        .to_string();
    let goal = fn_val
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut metadata: serde_json::Map<String, Value> = match fn_val.get("metadata") {
        Some(Value::Object(m)) => m.clone(),
        _ => serde_json::Map::new(),
    };
    metadata.insert("improvedFrom".to_string(), Value::String(function_id.clone()));
    metadata.insert("depth".to_string(), json!(depth + 1));

    let new_fn_payload = json!({
        "headers": { "authorization": "Bearer internal" },
        "body": {
            "goal": goal,
            "spec": feedback_spec,
            "name": base_name,
            "agentId": agent_id,
            "metadata": metadata,
        },
        "goal": goal,
        "spec": feedback_spec,
        "name": base_name,
        "agentId": agent_id,
        "metadata": metadata,
    });

    let new_fn = iii
        .trigger(TriggerRequest {
            function_id: "evolve::generate".to_string(),
            payload: new_fn_payload,
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let new_function_id = match new_fn.get("functionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            return Ok::<Value, IIIError>(json!({
                "improved": false,
                "reason": "Generation failed",
                "depth": depth,
            }));
        }
    };

    let policy = get_policy(iii).await;
    let mut new_score: f64 = 0.0;

    if let Some(suite_id) = suite_id.clone() {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "evolve::register".to_string(),
                payload: json!({
                    "headers": { "authorization": "Bearer internal" },
                    "body": { "functionId": new_function_id },
                    "functionId": new_function_id,
                }),
                action: None,
                timeout_ms: None,
            })
            .await;

        let suite_result = safe_trigger(
            iii,
            "eval::suite",
            json!({
                "headers": { "authorization": "Bearer internal" },
                "body": { "suiteId": suite_id },
                "suiteId": suite_id,
            }),
        )
        .await;
        new_score = suite_result
            .as_ref()
            .and_then(|v| v.pointer("/aggregate/correctness"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        if new_score < policy.min_score_to_keep && depth + 1 < MAX_IMPROVE_DEPTH {
            let recurse = iii
                .trigger(TriggerRequest {
                    function_id: "feedback::improve".to_string(),
                    payload: json!({
                        "headers": { "authorization": "Bearer internal" },
                        "body": {
                            "functionId": new_function_id,
                            "depth": depth + 1,
                            "suiteId": suite_id,
                        },
                        "functionId": new_function_id,
                        "depth": depth + 1,
                        "suiteId": suite_id,
                    }),
                    action: None,
                    timeout_ms: None,
                })
                .await
                .map_err(|e| IIIError::Handler(e.to_string()))?;
            return Ok::<Value, IIIError>(recurse);
        }
    } else {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "evolve::register".to_string(),
                payload: json!({
                    "headers": { "authorization": "Bearer internal" },
                    "body": { "functionId": new_function_id },
                    "functionId": new_function_id,
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    }

    Ok::<Value, IIIError>(json!({
        "improved": true,
        "newFunctionId": new_function_id,
        "depth": depth + 1,
        "score": new_score,
    }))
}

fn base_name_from(function_id: &str) -> String {
    if let Some(rest) = function_id.strip_prefix("evolved::")
        && let Some(idx) = rest.rfind("_v")
    {
        let suffix = &rest[idx + 2..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return rest[..idx].to_string();
        }
    }
    function_id.strip_prefix("evolved::").unwrap_or(function_id).to_string()
}

async fn feedback_promote(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();

    let mut fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;

    let status = fn_val
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("draft")
        .to_string();

    if status == "killed" || status == "deprecated" {
        return Err(IIIError::Handler(format!("Cannot promote from {status}")));
    }

    let policy = get_policy(iii).await;
    let recent_evals = get_recent_evals(iii, &function_id, 10).await;

    let promo = check_promotion_eligibility(&recent_evals, &policy);
    if !promo.eligible {
        return Ok::<Value, IIIError>(json!({
            "promoted": false,
            "reason": promo.reason.unwrap_or_default(),
        }));
    }

    let new_status = match status.as_str() {
        "draft" => "staging",
        "staging" => {
            let min_safety = recent_evals
                .iter()
                .map(safety_of)
                .fold(f64::INFINITY, f64::min);
            if min_safety < 0.8 {
                return Ok::<Value, IIIError>(json!({
                    "promoted": false,
                    "reason": format!(
                        "Safety score {min_safety:.3} below 0.8 threshold for production"
                    ),
                }));
            }
            "production"
        }
        "production" => {
            return Ok::<Value, IIIError>(json!({
                "promoted": false,
                "reason": "Already in production",
            }));
        }
        _ => &status,
    };

    if let Some(obj) = fn_val.as_object_mut() {
        obj.insert("status".to_string(), json!(new_status));
        obj.insert("updatedAt".to_string(), json!(now_ms()));
    }
    state_set(iii, "evolved_functions", &function_id, fn_val).await?;

    Ok::<Value, IIIError>(json!({
        "promoted": true,
        "functionId": function_id,
        "newStatus": new_status,
    }))
}

async fn feedback_demote(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let kill = body.get("kill").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;

    let status = fn_val
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("draft")
        .to_string();

    let new_status = if kill {
        "killed"
    } else if status == "killed" {
        return Ok::<Value, IIIError>(json!({
            "demoted": false,
            "functionId": function_id,
            "reason": "Already killed",
        }));
    } else if status == "production" {
        "staging"
    } else if status == "staging" {
        "draft"
    } else {
        "deprecated"
    };

    if let Some(obj) = fn_val.as_object_mut() {
        obj.insert("status".to_string(), json!(new_status));
        obj.insert("updatedAt".to_string(), json!(now_ms()));
    }
    state_set(iii, "evolved_functions", &function_id, fn_val).await?;

    Ok::<Value, IIIError>(json!({
        "demoted": true,
        "functionId": function_id,
        "newStatus": new_status,
    }))
}

async fn feedback_leaderboard(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if let Some(query) = input.get("query") {
        if !query.is_null() { query.clone() } else { unwrap_body(&input) }
    } else {
        unwrap_body(&input)
    };

    let entries = state_list(iii, "evolved_functions").await;
    let mut functions = entries_to_records(entries);

    functions.retain(|f| f.get("status").and_then(|v| v.as_str()) != Some("killed"));

    if let Some(status) = body.get("status").and_then(|v| v.as_str()) {
        functions.retain(|f| f.get("status").and_then(|v| v.as_str()) == Some(status));
    }

    functions.sort_by(|a, b| {
        let av = a
            .pointer("/evalScores/overall")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let bv = b
            .pointer("/evalScores/overall")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });

    let raw_limit = body.get("limit");
    let parsed = raw_limit.and_then(|v| v.as_f64());
    let limit_default: usize = 50;
    let limit: usize = match parsed {
        Some(n) if n.is_finite() => {
            let bounded = n.clamp(0.0, 100.0);
            bounded as usize
        }
        _ => limit_default,
    };

    let ranked: Vec<Value> = functions
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(i, f)| {
            json!({
                "rank": i + 1,
                "functionId": f.get("functionId").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or(Value::Null),
                "status": f.get("status").cloned().unwrap_or(Value::Null),
                "version": f.get("version").cloned().unwrap_or(Value::Null),
                "overall": f.pointer("/evalScores/overall").cloned().unwrap_or(Value::Null),
                "correctness": f.pointer("/evalScores/correctness").cloned().unwrap_or(Value::Null),
                "safety": f.pointer("/evalScores/safety").cloned().unwrap_or(Value::Null),
                "authorAgentId": f.get("authorAgentId").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok::<Value, IIIError>(Value::Array(ranked))
}

async fn feedback_policy(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);

    let keys = ["minScoreToKeep", "minEvalsToPromote", "maxFailuresToKill", "autoReviewIntervalMs"];
    let has_update = keys
        .iter()
        .any(|k| body.get(k).is_some_and(|v| !v.is_null()));

    if !has_update {
        let p = get_policy(iii).await;
        return serde_json::to_value(p).map_err(|e| IIIError::Handler(e.to_string()));
    }

    let current = get_policy(iii).await;
    let mut updated = current;

    for k in &keys {
        let v = match body.get(*k) {
            Some(v) => v,
            None => continue,
        };
        let n = match v.as_f64() {
            Some(n) if n.is_finite() => n,
            _ => continue,
        };
        match *k {
            "minScoreToKeep" => {
                if !(0.0..=1.0).contains(&n) {
                    return Err(IIIError::Handler(
                        "minScoreToKeep must be between 0 and 1".into(),
                    ));
                }
                updated.min_score_to_keep = n;
            }
            "minEvalsToPromote" | "maxFailuresToKill" => {
                if n.fract() != 0.0 || n < 0.0 {
                    return Err(IIIError::Handler(format!(
                        "{k} must be a non-negative integer"
                    )));
                }
                let int_v = n as u32;
                if *k == "minEvalsToPromote" {
                    updated.min_evals_to_promote = int_v;
                } else {
                    updated.max_failures_to_kill = int_v;
                }
            }
            "autoReviewIntervalMs" => {
                if n < 0.0 {
                    return Err(IIIError::Handler(
                        "autoReviewIntervalMs must be non-negative".into(),
                    ));
                }
                updated.auto_review_interval_ms = n as i64;
            }
            _ => {}
        }
    }

    let value = serde_json::to_value(updated).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "feedback_policy", "default", value.clone()).await?;
    Ok::<Value, IIIError>(value)
}

async fn feedback_auto_review(iii: &III, _input: Value) -> Result<Value, IIIError> {
    let policy = get_policy(iii).await;

    let last_run = state_get(iii, "feedback_policy", "auto_review_last_run").await;
    if let Some(last) = last_run.and_then(|v| v.as_i64())
        && now_ms() - last < policy.auto_review_interval_ms
    {
        return Ok::<Value, IIIError>(json!({
            "reviewed": 0,
            "skipped": true,
            "results": [],
        }));
    }

    state_set(iii, "feedback_policy", "auto_review_last_run", json!(now_ms())).await?;

    let entries = state_list(iii, "evolved_functions").await;
    let reviewable: Vec<Value> = entries_to_records(entries)
        .into_iter()
        .filter(|f| {
            let s = f.get("status").and_then(|v| v.as_str()).unwrap_or("");
            s == "staging" || s == "production"
        })
        .collect();

    let mut results: Vec<Value> = Vec::new();
    for fn_record in reviewable {
        let function_id = match fn_record.get("functionId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let result = safe_trigger(
            iii,
            "feedback::review",
            json!({
                "headers": { "authorization": "Bearer internal" },
                "body": { "functionId": function_id },
                "functionId": function_id,
            }),
        )
        .await;
        if let Some(r) = result {
            results.push(r);
        }
    }

    Ok::<Value, IIIError>(json!({
        "reviewed": results.len(),
        "results": results,
    }))
}

async fn feedback_inject_signal(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);

    let agent_id = body
        .get("agentId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?;
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("content is required".into()))?
        .to_string();
    let signal_type = body
        .get("signalType")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| {
            IIIError::Handler(format!(
                "signalType must be one of: {}",
                VALID_SIGNAL_TYPES.join(", ")
            ))
        })?;

    if !VALID_SIGNAL_TYPES.contains(&signal_type.as_str()) {
        return Err(IIIError::Handler(format!(
            "signalType must be one of: {}",
            VALID_SIGNAL_TYPES.join(", ")
        )));
    }

    let sanitized_id = sanitize_id(agent_id)?;
    let signal_meta = body.get("metadata").cloned().unwrap_or(json!({}));

    let signal_id = format!("sig_{}_{}", now_ms(), uuid::Uuid::new_v4().simple());
    let signal = json!({
        "id": signal_id,
        "agentId": sanitized_id,
        "content": content,
        "signalType": signal_type,
        "metadata": signal_meta,
        "createdAt": now_ms(),
    });

    state_set(
        iii,
        &format!("feedback_signals:{sanitized_id}"),
        &signal_id,
        signal,
    )
    .await?;

    let prefix = signal_prefix(&signal_type);
    let iii_inner = iii.clone();
    let target = sanitized_id.clone();
    let message = format!("{prefix} {content}");
    tokio::spawn(async move {
        let _ = iii_inner
            .trigger(TriggerRequest {
                function_id: "fn::agent_send".to_string(),
                payload: json!({
                    "targetAgentId": target,
                    "message": message,
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    Ok::<Value, IIIError>(json!({
        "signalId": signal_id,
        "injected": true,
    }))
}

async fn feedback_register_source(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);

    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("name is required".into()))?
        .to_string();
    let source_type = body
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("type is required".into()))?
        .to_string();
    let source_config = body.get("config").cloned().unwrap_or(json!({}));

    let source_id = format!("src_{}_{}", now_ms(), uuid::Uuid::new_v4().simple());
    let source = json!({
        "id": source_id,
        "name": name,
        "type": source_type,
        "config": source_config,
        "registeredAt": now_ms(),
    });

    state_set(iii, "feedback_sources", &source_id, source).await?;

    Ok::<Value, IIIError>(json!({
        "sourceId": source_id,
        "registered": true,
    }))
}

async fn feedback_list_signals(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);

    let agent_id = body
        .get("agentId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("agentId is required".into()))?
        .to_string();

    let raw_limit = body.get("limit").and_then(|v| v.as_f64());
    let limit: usize = match raw_limit {
        Some(n) if n.is_finite() => n.clamp(1.0, 200.0) as usize,
        _ => 50,
    };

    let entries = state_list(iii, &format!("feedback_signals:{agent_id}")).await;
    let mut signals: Vec<Value> = entries_to_records(entries)
        .into_iter()
        .filter(|s| s.get("createdAt").and_then(|v| v.as_i64()).is_some())
        .collect();
    signals.sort_by(|a, b| {
        let ta = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    signals.truncate(limit);

    Ok::<Value, IIIError>(json!({
        "agentId": agent_id,
        "count": signals.len(),
        "signals": signals,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::review", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_review(&iii, input).await }
        })
        .description("Analyze evals and decide keep/improve/kill"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::improve", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_improve(&iii, input).await }
        })
        .description("Call evolve::generate with eval feedback, re-eval. Auto-recurses up to 3x."),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::promote", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_promote(&iii, input).await }
        })
        .description("draft->staging or staging->production"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::demote", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_demote(&iii, input).await }
        })
        .description("Downgrade or kill"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::leaderboard", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_leaderboard(&iii, input).await }
        })
        .description("Rank evolved functions by score"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::policy", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_policy(&iii, input).await }
        })
        .description("Get/set threshold policy"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::auto_review", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_auto_review(&iii, input).await }
        })
        .description("Auto-review all staging+production functions"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::inject_signal", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_inject_signal(&iii, input).await }
        })
        .description("Push external signal into agent context"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::register_source", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_register_source(&iii, input).await }
        })
        .description("Register an external signal source"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("feedback::list_signals", move |input: Value| {
            let iii = iii_clone.clone();
            async move { feedback_list_signals(&iii, input).await }
        })
        .description("List recent signals for an agent sorted by createdAt desc"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::inject_signal".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/inject-signal" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::list_signals".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/signals" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::review".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/review" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::improve".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/improve" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::promote".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/promote" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::demote".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/demote" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::leaderboard".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/feedback/leaderboard" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "feedback::policy".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/feedback/policy" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".to_string(),
        function_id: "feedback::auto_review".to_string(),
        config: json!({ "interval": "6h" }),
        metadata: None,
    })?;

    tracing::info!("feedback worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_eval(correctness: Option<f64>, overall: f64, safety: f64) -> Value {
        json!({
            "scores": {
                "correctness": correctness,
                "overall": overall,
                "safety": safety,
                "latency_ms": 50,
                "cost_tokens": 0,
            }
        })
    }

    #[test]
    fn test_promotion_eligibility_too_few_evals() {
        let policy = FeedbackPolicy::DEFAULT;
        let evals = vec![mock_eval(Some(0.9), 0.85, 1.0)];
        let p = check_promotion_eligibility(&evals, &policy);
        assert!(!p.eligible);
        assert!(p.reason.unwrap().contains("Need 5"));
    }

    #[test]
    fn test_promotion_eligibility_low_score() {
        let policy = FeedbackPolicy::DEFAULT;
        let evals = vec![
            mock_eval(Some(0.4), 0.3, 1.0),
            mock_eval(Some(0.4), 0.3, 1.0),
            mock_eval(Some(0.4), 0.3, 1.0),
            mock_eval(Some(0.4), 0.3, 1.0),
            mock_eval(Some(0.4), 0.3, 1.0),
        ];
        let p = check_promotion_eligibility(&evals, &policy);
        assert!(!p.eligible);
        assert!(p.reason.unwrap().contains("Average score"));
    }

    #[test]
    fn test_promotion_eligibility_passes() {
        let policy = FeedbackPolicy::DEFAULT;
        let evals = vec![mock_eval(Some(0.9), 0.85, 1.0); 5];
        let p = check_promotion_eligibility(&evals, &policy);
        assert!(p.eligible);
        assert!((p.avg_overall - 0.85).abs() < 1e-9);
    }

    #[test]
    fn test_review_and_promote_use_same_min_evals_to_promote() {
        // CR rule: review must reject "keep" when evals < minEvalsToPromote.
        // We verify the centralized helper enforces this against the same policy
        // value used by promote.
        let policy = FeedbackPolicy {
            min_score_to_keep: 0.5,
            min_evals_to_promote: 8,
            max_failures_to_kill: 3,
            auto_review_interval_ms: 1000,
        };
        // 5 high-quality evals → review should NOT be able to claim "keep".
        let evals = vec![mock_eval(Some(1.0), 1.0, 1.0); 5];
        let p = check_promotion_eligibility(&evals, &policy);
        assert!(!p.eligible);
        assert!(p.reason.unwrap().contains("Need 8"));
    }

    #[test]
    fn test_signal_prefix_mapping() {
        assert_eq!(signal_prefix("ci_failure"), "[CI Failure]");
        assert_eq!(signal_prefix("review_comment"), "[Review Comment]");
        assert_eq!(signal_prefix("custom"), "[Signal]");
        assert_eq!(signal_prefix("nonsense"), "[Signal]");
    }

    #[test]
    fn test_base_name_from_versioned_id() {
        assert_eq!(base_name_from("evolved::adder_v1"), "adder");
        assert_eq!(base_name_from("evolved::name_with_v_underscores_v42"), "name_with_v_underscores");
        assert_eq!(base_name_from("evolved::no_version"), "no_version");
        // Without the `evolved::` prefix the regex never matches in the TS impl,
        // so the original id is returned unchanged.
        assert_eq!(base_name_from("not_evolved::adder_v1"), "not_evolved::adder_v1");
    }

    #[test]
    fn test_sanitize_id_rejects_path_chars() {
        assert!(sanitize_id("a/b").is_err());
        assert!(sanitize_id("..").is_ok()); // dots allowed; path traversal handled by callers
        assert!(sanitize_id("agent-1").is_ok());
    }

    #[test]
    fn test_correctness_safety_extractors() {
        let e = mock_eval(Some(0.7), 0.6, 0.9);
        assert_eq!(correctness_of(&e), Some(0.7));
        assert!((overall_of(&e) - 0.6).abs() < 1e-9);
        assert!((safety_of(&e) - 0.9).abs() < 1e-9);
    }
}

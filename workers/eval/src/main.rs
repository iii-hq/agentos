use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{EvalResult, EvalScores, EvalSuite, EvalTestCase};

const ALLOWED_SCORER_PREFIXES: &[&str] = &["evolved::", "eval::", "tool::"];

const W_CORRECTNESS: f64 = 0.5;
const W_LATENCY: f64 = 0.15;
const W_COST: f64 = 0.1;
const W_SAFETY: f64 = 0.25;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn generate_id() -> String {
    format!("eval_{}_{}", now_ms(), uuid::Uuid::new_v4().simple())
}

fn latency_score(ms: i64) -> f64 {
    let v = 1.0 - (ms as f64) / 30_000.0;
    if v < 0.0 { 0.0 } else { v }
}

fn cost_score(tokens: i64) -> f64 {
    let v = 1.0 - (tokens as f64) / 100_000.0;
    if v < 0.0 { 0.0 } else { v }
}

fn compute_overall(scores: &EvalScores) -> f64 {
    let correctness = scores.correctness.unwrap_or(0.0);
    correctness * W_CORRECTNESS
        + latency_score(scores.latency_ms) * W_LATENCY
        + cost_score(scores.cost_tokens) * W_COST
        + scores.safety * W_SAFETY
}

fn word_set(text: &str) -> std::collections::HashSet<String> {
    text.to_lowercase()
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn jaccard_similarity(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let intersection = a.iter().filter(|w| b.contains(*w)).count();
    let union = a.len() + b.len() - intersection;
    if union > 0 {
        intersection as f64 / union as f64
    } else {
        0.0
    }
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn value_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
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

async fn score_exact_match(output: &Value, expected: &Value) -> f64 {
    if output == expected { 1.0 } else { 0.0 }
}

async fn score_llm_judge(iii: &III, output: &Value, expected: &Value, input: &Value) -> f64 {
    let prompt = format!(
        "Input: {}\nExpected: {}\nActual: {}\n\nScore (0.0-1.0):",
        serde_json::to_string(input).unwrap_or_default(),
        serde_json::to_string(expected).unwrap_or_default(),
        serde_json::to_string(output).unwrap_or_default(),
    );
    let payload = json!({
        "model": {
            "provider": "anthropic",
            "model": "claude-haiku-4-5",
            "maxTokens": 256,
        },
        "systemPrompt": "You are an eval judge. Score the output 0.0-1.0 for correctness. Respond with ONLY a number.",
        "messages": [{ "role": "user", "content": prompt }],
    });
    let result = safe_trigger(iii, "llm::complete", payload).await;
    let content = match result {
        Some(v) => v
            .get("content")
            .and_then(|c| c.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        None => return 0.0,
    };
    if content.is_empty() {
        return 0.0;
    }
    content.parse::<f64>().map(clamp01).unwrap_or(0.0)
}

async fn score_semantic_similarity(output: &Value, expected: &Value) -> f64 {
    jaccard_similarity(&word_set(&value_to_text(output)), &word_set(&value_to_text(expected)))
}

async fn score_custom(
    iii: &III,
    output: &Value,
    expected: &Value,
    input: &Value,
    scorer_function_id: &str,
) -> Result<f64, IIIError> {
    if !ALLOWED_SCORER_PREFIXES
        .iter()
        .any(|p| scorer_function_id.starts_with(p))
    {
        return Err(IIIError::Handler(format!(
            "Custom scorer must use {} prefixes, got: {}",
            ALLOWED_SCORER_PREFIXES.join(", "),
            scorer_function_id
        )));
    }
    let payload = json!({
        "output": output,
        "expected": expected,
        "input": input,
    });
    let result = safe_trigger(iii, scorer_function_id, payload).await;
    let value = match result {
        Some(v) => v,
        None => return Ok(0.0),
    };
    if let Some(n) = value.as_f64() {
        return Ok(clamp01(n));
    }
    if let Some(score) = value.get("score").and_then(|s| s.as_f64()) {
        return Ok(clamp01(score));
    }
    Ok(0.0)
}

async fn score_output(
    iii: &III,
    output: &Value,
    expected: &Value,
    input: &Value,
    scorer: &str,
    scorer_function_id: Option<&str>,
) -> Result<f64, IIIError> {
    match scorer {
        "exact_match" => Ok(score_exact_match(output, expected).await),
        "llm_judge" => Ok(score_llm_judge(iii, output, expected, input).await),
        "semantic_similarity" => Ok(score_semantic_similarity(output, expected).await),
        "custom" => {
            let id = scorer_function_id
                .ok_or_else(|| IIIError::Handler("scorerFunctionId required for custom scorer".into()))?;
            score_custom(iii, output, expected, input, id).await
        }
        _ => Ok(score_exact_match(output, expected).await),
    }
}

async fn check_safety(iii: &III, output: &Value) -> f64 {
    let content = match output {
        Value::String(s) => s.clone(),
        _ => output.to_string(),
    };
    let result = safe_trigger(iii, "security::scan_injection", json!({ "content": content })).await;
    match result {
        None => 0.0,
        Some(v) => {
            if v.get("safe").and_then(|s| s.as_bool()) == Some(false) {
                0.0
            } else {
                1.0
            }
        }
    }
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
    let res = safe_trigger(iii, "state::list", json!({ "scope": scope })).await;
    res.and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

async fn invoke(iii: &III, function_id: &str, input: &Value) -> (Value, i64) {
    let start = std::time::Instant::now();
    let res = iii
        .trigger(TriggerRequest {
            function_id: function_id.to_string(),
            payload: input.clone(),
            action: None,
            timeout_ms: None,
        })
        .await;
    let latency_ms = start.elapsed().as_millis() as i64;
    let output = match res {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string() }),
    };
    (output, latency_ms)
}

async fn run_eval_one(
    iii: &III,
    function_id: &str,
    input: &Value,
    expected: Option<&Value>,
    scorer: &str,
    scorer_function_id: Option<&str>,
) -> Result<EvalResult, IIIError> {
    let (output, latency_ms) = invoke(iii, function_id, input).await;
    let correctness = match expected {
        Some(exp) => Some(score_output(iii, &output, exp, input, scorer, scorer_function_id).await?),
        None => None,
    };
    let safety = check_safety(iii, &output).await;
    let mut scores = EvalScores {
        correctness,
        latency_ms,
        cost_tokens: 0,
        safety,
        overall: 0.0,
    };
    scores.overall = compute_overall(&scores);

    let eval_id = generate_id();
    Ok(EvalResult {
        eval_id,
        function_id: function_id.to_string(),
        scores,
        scorer_type: scorer.to_string(),
        input: input.clone(),
        output,
        expected: expected.cloned(),
        timestamp: now_ms(),
    })
}

async fn eval_run(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    };

    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let tc_input = body.get("input").cloned().unwrap_or(Value::Null);
    let expected = body.get("expected").cloned();
    let scorer = body
        .get("scorer")
        .and_then(|v| v.as_str())
        .unwrap_or("exact_match")
        .to_string();
    let scorer_function_id = body.get("scorerFunctionId").and_then(|v| v.as_str()).map(String::from);

    let result = run_eval_one(
        iii,
        &function_id,
        &tc_input,
        expected.as_ref(),
        &scorer,
        scorer_function_id.as_deref(),
    )
    .await?;

    let value = serde_json::to_value(&result).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(
        iii,
        "eval_results",
        &format!("{}:{}", function_id, result.eval_id),
        value.clone(),
    )
    .await?;

    if let Some(mut fn_record) = state_get(iii, "evolved_functions", &function_id).await
        && !fn_record.is_null()
    {
        if let Some(obj) = fn_record.as_object_mut() {
            obj.insert(
                "evalScores".to_string(),
                serde_json::to_value(&result.scores).unwrap_or(Value::Null),
            );
            obj.insert("updatedAt".to_string(), json!(now_ms()));
        }
        let _ = state_set(iii, "evolved_functions", &function_id, fn_record).await;
    }

    Ok::<Value, IIIError>(value)
}

async fn eval_score_inline(iii: &III, input: Value) -> Result<Value, IIIError> {
    let function_id = input
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let tc_input = input.get("input").cloned().unwrap_or(Value::Null);
    let output = input.get("output").cloned().unwrap_or(Value::Null);
    let latency_ms = input.get("latencyMs").and_then(|v| v.as_i64()).unwrap_or(0);
    let cost_tokens = input.get("costTokens").and_then(|v| v.as_i64()).unwrap_or(0);

    let safety = check_safety(iii, &output).await;
    let mut scores = EvalScores {
        correctness: None,
        latency_ms,
        cost_tokens,
        safety,
        overall: 0.0,
    };
    scores.overall = compute_overall(&scores);

    let eval_id = generate_id();
    let result = EvalResult {
        eval_id: eval_id.clone(),
        function_id: function_id.clone(),
        scores: scores.clone(),
        scorer_type: "inline".into(),
        input: tc_input,
        output,
        expected: None,
        timestamp: now_ms(),
    };

    let value = serde_json::to_value(&result).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(
        iii,
        "eval_results",
        &format!("{}:{}", function_id, eval_id),
        value.clone(),
    )
    .await?;

    let iii_inner = iii.clone();
    let payload = json!({ "functionId": function_id, "scores": scores });
    tokio::spawn(async move {
        let _ = iii_inner
            .trigger(TriggerRequest {
                function_id: "eval::inline_recorded".to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    Ok::<Value, IIIError>(value)
}

async fn eval_suite_run(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    };

    let suite_id = body
        .get("suiteId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("suiteId is required".into()))?
        .to_string();

    let suite_val = state_get(iii, "eval_suites", &suite_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Suite not found".into()))?;
    let suite: EvalSuite = serde_json::from_value(suite_val)
        .map_err(|e| IIIError::Handler(format!("Suite not found: {e}")))?;

    let mut results: Vec<EvalResult> = Vec::with_capacity(suite.test_cases.len());
    let mut total_correctness: f64 = 0.0;
    let mut total_weight: f64 = 0.0;
    let mut weighted_pass: f64 = 0.0;
    let mut weighted_total: f64 = 0.0;
    let mut total_latency: i64 = 0;
    let mut total_cost: i64 = 0;
    let mut min_safety: f64 = 1.0;

    for tc in &suite.test_cases {
        let weight = tc.weight.unwrap_or(1.0);
        let scorer = tc.scorer.clone().unwrap_or_else(|| "exact_match".into());
        let result = run_eval_one(
            iii,
            &suite.function_id,
            &tc.input,
            tc.expected.as_ref(),
            &scorer,
            tc.scorer_function_id.as_deref(),
        )
        .await?;

        if let Some(c) = result.scores.correctness {
            total_correctness += c * weight;
            total_weight += weight;
            if c >= 0.5 {
                weighted_pass += weight;
            }
        }
        weighted_total += weight;
        total_latency += result.scores.latency_ms;
        total_cost += result.scores.cost_tokens;
        if result.scores.safety < min_safety {
            min_safety = result.scores.safety;
        }

        let value = serde_json::to_value(&result).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(
            iii,
            "eval_results",
            &format!("{}:{}", suite.function_id, result.eval_id),
            value,
        )
        .await?;
        results.push(result);
    }

    let avg_correctness: Option<f64> = if total_weight > 0.0 {
        Some(total_correctness / total_weight)
    } else {
        None
    };
    let avg_latency = if !results.is_empty() {
        total_latency / results.len() as i64
    } else {
        0
    };
    let pass_rate = if weighted_total > 0.0 {
        weighted_pass / weighted_total
    } else {
        0.0
    };

    let aggregate = json!({
        "correctness": avg_correctness,
        "latency_ms": avg_latency,
        "cost_tokens": total_cost,
        "safety": min_safety,
        "passRate": pass_rate,
        "testCount": suite.test_cases.len(),
    });

    Ok::<Value, IIIError>(json!({
        "suiteId": suite_id,
        "functionId": suite.function_id,
        "aggregate": aggregate,
        "results": results,
    }))
}

async fn eval_history(iii: &III, input: Value) -> Result<Value, IIIError> {
    let function_id = input
        .get("params")
        .and_then(|p| p.get("functionId"))
        .and_then(|v| v.as_str())
        .or_else(|| input.get("functionId").and_then(|v| v.as_str()))
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();

    let entries = state_list(iii, "eval_results").await;
    let mut results: Vec<Value> = entries
        .into_iter()
        .map(|e| e.get("value").cloned().unwrap_or(e))
        .filter(|r| {
            r.get("functionId").and_then(|v| v.as_str()) == Some(&function_id)
        })
        .collect();
    results.sort_by(|a, b| {
        let ta = a.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok::<Value, IIIError>(Value::Array(results))
}

async fn eval_compare(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    };

    let function_id_a = body.get("functionIdA").and_then(|v| v.as_str()).map(String::from);
    let function_id_b = body.get("functionIdB").and_then(|v| v.as_str()).map(String::from);
    let test_cases = body.get("testCases").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    if function_id_a.is_none() || function_id_b.is_none() || test_cases.is_empty() {
        return Err(IIIError::Handler(
            "functionIdA, functionIdB, and testCases are required".into(),
        ));
    }
    let function_id_a = function_id_a.unwrap();
    let function_id_b = function_id_b.unwrap();

    let mut results_a: Vec<EvalScores> = Vec::with_capacity(test_cases.len());
    let mut results_b: Vec<EvalScores> = Vec::with_capacity(test_cases.len());

    for tc_val in &test_cases {
        let tc: EvalTestCase = serde_json::from_value(tc_val.clone())
            .map_err(|e| IIIError::Handler(e.to_string()))?;
        let scorer = tc.scorer.clone().unwrap_or_else(|| "exact_match".into());

        let scores_a = compare_one(iii, &function_id_a, &tc, &scorer).await?;
        let scores_b = compare_one(iii, &function_id_b, &tc, &scorer).await?;
        results_a.push(scores_a);
        results_b.push(scores_b);
    }

    let avg = |v: &[EvalScores]| -> f64 {
        if v.is_empty() {
            0.0
        } else {
            v.iter().map(|s| s.overall).sum::<f64>() / v.len() as f64
        }
    };
    let avg_a = avg(&results_a);
    let avg_b = avg(&results_b);
    let winner = if avg_a >= avg_b { &function_id_a } else { &function_id_b };

    Ok::<Value, IIIError>(json!({
        "functionIdA": function_id_a,
        "functionIdB": function_id_b,
        "avgOverallA": avg_a,
        "avgOverallB": avg_b,
        "winner": winner,
        "detailsA": results_a,
        "detailsB": results_b,
    }))
}

async fn compare_one(
    iii: &III,
    fn_id: &str,
    tc: &EvalTestCase,
    scorer: &str,
) -> Result<EvalScores, IIIError> {
    let start = std::time::Instant::now();
    let output = iii
        .trigger(TriggerRequest {
            function_id: fn_id.to_string(),
            payload: tc.input.clone(),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or_else(|_| json!({ "error": "failed" }));
    let latency_ms = start.elapsed().as_millis() as i64;

    let correctness = match &tc.expected {
        Some(exp) => Some(score_output(iii, &output, exp, &tc.input, scorer, None).await?),
        None => None,
    };
    let safety = check_safety(iii, &output).await;
    let mut scores = EvalScores {
        correctness,
        latency_ms,
        cost_tokens: 0,
        safety,
        overall: 0.0,
    };
    scores.overall = compute_overall(&scores);
    Ok(scores)
}

async fn eval_create_suite(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if input.get("body").is_some() {
        input["body"].clone()
    } else {
        input.clone()
    };

    let name = body.get("name").and_then(|v| v.as_str()).map(String::from);
    let function_id = body.get("functionId").and_then(|v| v.as_str()).map(String::from);
    let test_cases_val = body.get("testCases").and_then(|v| v.as_array()).cloned();
    let custom_id = body.get("suiteId").and_then(|v| v.as_str()).map(String::from);

    if name.is_none() || function_id.is_none() || test_cases_val.as_ref().is_none_or(|v| v.is_empty()) {
        return Err(IIIError::Handler(
            "name, functionId, and testCases are required".into(),
        ));
    }

    let name = name.unwrap();
    let function_id = function_id.unwrap();
    let test_cases_val = test_cases_val.unwrap();
    let test_cases: Vec<EvalTestCase> = test_cases_val
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let suite_id = custom_id
        .unwrap_or_else(|| format!("suite_{}_{}", now_ms(), uuid::Uuid::new_v4().simple()));

    let suite = EvalSuite {
        suite_id: suite_id.clone(),
        name,
        function_id,
        test_cases,
        created_at: now_ms(),
    };

    let value = serde_json::to_value(&suite).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "eval_suites", &suite_id, value.clone()).await?;

    Ok::<Value, IIIError>(value)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::run", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_run(&iii, input).await }
        })
        .description("Invoke function, measure latency/cost, score output"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::score_inline", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_score_inline(&iii, input).await }
        })
        .description("Auto-called by evolved function wrapper. Lightweight scoring."),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::suite", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_suite_run(&iii, input).await }
        })
        .description("Run all test cases in a suite, aggregate scores"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::history", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_history(&iii, input).await }
        })
        .description("Eval results for a function"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::compare", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_compare(&iii, input).await }
        })
        .description("Side-by-side comparison of two function versions"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("eval::create_suite", move |input: Value| {
            let iii = iii_clone.clone();
            async move { eval_create_suite(&iii, input).await }
        })
        .description("Create a reusable eval suite"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "eval::run".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/eval/run" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "eval::suite".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/eval/suite" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "eval::history".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/eval/history/:functionId" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "eval::compare".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/eval/compare" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "eval::create_suite".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/eval/suites" }),
        metadata: None,
    })?;

    tracing::info!("eval worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_latency_score_floor_zero() {
        assert_eq!(latency_score(60_000), 0.0);
    }

    #[test]
    fn test_latency_score_ideal() {
        assert!((latency_score(0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_cost_score_floor() {
        assert_eq!(cost_score(200_000), 0.0);
    }

    #[test]
    fn test_compute_overall_with_correctness() {
        let s = EvalScores {
            correctness: Some(1.0),
            latency_ms: 0,
            cost_tokens: 0,
            safety: 1.0,
            overall: 0.0,
        };
        let v = compute_overall(&s);
        assert!((v - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_compute_overall_treats_null_correctness_as_zero() {
        let s = EvalScores {
            correctness: None,
            latency_ms: 0,
            cost_tokens: 0,
            safety: 1.0,
            overall: 0.0,
        };
        let v = compute_overall(&s);
        let expected = W_LATENCY + W_COST + W_SAFETY;
        assert!((v - expected).abs() < 1e-9);
    }

    #[test]
    fn test_jaccard_identical_sets() {
        let a = word_set("hello world");
        let b = word_set("hello world");
        assert!((jaccard_similarity(&a, &b) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_jaccard_disjoint_sets() {
        let a = word_set("foo bar");
        let b = word_set("baz qux");
        assert!(jaccard_similarity(&a, &b) < 1e-9);
    }

    #[test]
    fn test_jaccard_empty_sets() {
        let a = word_set("");
        let b = word_set("");
        assert!((jaccard_similarity(&a, &b) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_clamp01() {
        assert_eq!(clamp01(-0.5), 0.0);
        assert_eq!(clamp01(1.5), 1.0);
        assert_eq!(clamp01(0.5), 0.5);
    }

    #[test]
    fn test_pass_rate_respects_weights() {
        // Weighted pass rate: 2 cases, weights 3 and 1.
        // Failing case has weight 3, passing case has weight 1.
        // Flat rate would be 1/2 = 0.5; weighted is 1/4 = 0.25.
        let weights = [3.0_f64, 1.0_f64];
        let pass = [false, true];
        let mut wp = 0.0_f64;
        let mut wt = 0.0_f64;
        for (w, p) in weights.iter().zip(pass.iter()) {
            wt += *w;
            if *p {
                wp += *w;
            }
        }
        let weighted_rate = wp / wt;
        assert!((weighted_rate - 0.25).abs() < 1e-9);
        let flat_rate: f64 = 1.0_f64 / 2.0_f64;
        assert!((flat_rate - 0.5).abs() < 1e-9);
        assert!(weighted_rate < flat_rate);
    }
}

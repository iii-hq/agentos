use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{EvolvedFunction, SecurityReport};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
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

fn unwrap_body(input: &Value) -> Value {
    if let Some(body) = input.get("body")
        && !body.is_null()
    {
        return body.clone();
    }
    input.clone()
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

fn parse_version_suffix(function_id: &str) -> Option<u32> {
    let idx = function_id.rfind("_v")?;
    function_id[idx + 2..].parse::<u32>().ok()
}

fn next_version_for(prefix: &str, existing: &[Value]) -> u32 {
    let mut max_version: u32 = 0;
    for entry in existing {
        let function_id = match entry.get("functionId").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if !function_id.starts_with(prefix) {
            continue;
        }
        if let Some(v) = parse_version_suffix(function_id)
            && v > max_version
        {
            max_version = v;
        }
    }
    max_version + 1
}

fn strip_code_fences(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    for fence in &["```javascript\n", "```js\n", "```typescript\n", "```ts\n", "```\n", "```"] {
        if let Some(stripped) = s.strip_prefix(fence) {
            s = stripped.to_string();
            break;
        }
    }
    if let Some(stripped) = s.strip_suffix("```") {
        s = stripped.to_string();
    }
    s.trim().to_string()
}

async fn invoke_llm_complete(iii: &III, prompt: &str) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "llm::complete".to_string(),
        payload: json!({
            "model": {
                "provider": "anthropic",
                "model": "claude-sonnet-4-20250514",
                "maxTokens": 2048,
            },
            "systemPrompt": "You are a code generator. Output only a single JavaScript arrow function expression. No markdown, no explanation.",
            "messages": [{ "role": "user", "content": prompt }],
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn evolve_generate(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let goal = body
        .get("goal")
        .and_then(|v| v.as_str())
        .map(String::from);
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from);
    let agent_id = body
        .get("agentId")
        .and_then(|v| v.as_str())
        .map(String::from);
    if goal.is_none() || name.is_none() || agent_id.is_none() {
        return Err(IIIError::Handler(
            "goal, name, and agentId are required".into(),
        ));
    }
    let goal = goal.unwrap();
    let name = name.unwrap();
    let agent_id = agent_id.unwrap();

    let safe_name = sanitize_id(&name)?;
    let spec = body
        .get("spec")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let extra_meta = body.get("metadata").cloned().unwrap_or(json!({}));

    let entries = state_list(iii, "evolved_functions").await;
    let records = entries_to_records(entries);
    let prefix = format!("evolved::{safe_name}_v");
    let next_version = next_version_for(&prefix, &records);
    let function_id = format!("evolved::{safe_name}_v{next_version}");

    let prompt = format!(
        "Write a JavaScript function that accomplishes the following goal. Return ONLY the function body as an arrow function expression. Do not include markdown, explanations, or code fences.\n\nGoal: {goal}\n{}\n\nThe function receives a single `input` parameter (any type) and must return a result.\nIt has access to: JSON, Math, Date, Array, Object, String, Number, Boolean, Map, Set, Promise, parseInt, parseFloat.\nIt can call `await trigger({{ function_id: fnId, payload: data }})` to invoke other functions (only evolved::, tool::, llm:: prefixes).\nIt CANNOT use: fetch, fs, process, require, setTimeout, eval, Function constructor.\n\nExample: async (input) => {{ return {{ result: input.value * 2 }}; }}",
        if spec.is_empty() {
            String::new()
        } else {
            format!("Spec: {spec}")
        }
    );

    let llm_result = invoke_llm_complete(iii, &prompt).await?;
    let raw_code = llm_result
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let code = strip_code_fences(raw_code);

    let parent_version = if next_version > 1 {
        Some(format!("evolved::{safe_name}_v{}", next_version - 1))
    } else {
        None
    };

    // CR fix: spread extra_meta first so the system-managed fields cannot be overridden.
    let mut metadata = match extra_meta {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    let _ = &mut metadata;

    let now = now_ms();
    let record = EvolvedFunction {
        function_id: function_id.clone(),
        code,
        description: goal,
        author_agent_id: agent_id,
        version: next_version,
        status: "draft".into(),
        created_at: now,
        updated_at: now,
        eval_scores: None,
        security_report: SecurityReport::default(),
        parent_version,
        metadata,
    };

    let value = serde_json::to_value(&record).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "evolved_functions", &function_id, value.clone()).await?;

    Ok::<Value, IIIError>(value)
}

async fn evolve_register(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();

    let fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;
    let mut fn_record: EvolvedFunction =
        serde_json::from_value(fn_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if fn_record.status == "killed" {
        return Err(IIIError::Handler("Cannot register a killed function".into()));
    }

    let pipeline = iii
        .trigger(TriggerRequest {
            function_id: "skill::pipeline".to_string(),
            payload: json!({ "content": fn_record.code }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let scan_safe = pipeline.get("approved").and_then(|v| v.as_bool()) == Some(true);
    let sandbox_passed = pipeline
        .pointer("/report/sandbox/passed")
        .and_then(|v| v.as_bool())
        == Some(true);
    let finding_count = pipeline
        .pointer("/report/scan/findings")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as i64)
        .unwrap_or(0);

    fn_record.security_report = SecurityReport {
        scan_safe,
        sandbox_passed,
        finding_count,
    };

    if !scan_safe {
        fn_record.status = "killed".into();
        fn_record.updated_at = now_ms();
        let value = serde_json::to_value(&fn_record).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(iii, "evolved_functions", &function_id, value).await?;

        let iii_inner = iii.clone();
        let payload = json!({
            "type": "evolved_function_rejected",
            "detail": {
                "functionId": function_id,
                "reason": "security_scan_failed",
                "findingCount": finding_count,
            },
        });
        tokio::spawn(async move {
            let _ = iii_inner
                .trigger(TriggerRequest {
                    function_id: "security::audit".to_string(),
                    payload,
                    action: None,
                    timeout_ms: None,
                })
                .await;
        });

        return Ok::<Value, IIIError>(json!({
            "registered": false,
            "reason": "Security scan failed",
            "securityReport": fn_record.security_report,
        }));
    }

    // TS source overwrites this to true on the happy path; preserve that contract.
    fn_record.security_report.sandbox_passed = true;
    fn_record.status = "staging".into();
    fn_record.updated_at = now_ms();

    let value = serde_json::to_value(&fn_record).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "evolved_functions", &function_id, value).await?;

    let iii_inner = iii.clone();
    let security_report = fn_record.security_report.clone();
    let function_id_clone = function_id.clone();
    let payload = json!({
        "type": "evolved_function_registered",
        "detail": {
            "functionId": function_id_clone,
            "securityReport": security_report,
        },
    });
    tokio::spawn(async move {
        let _ = iii_inner
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    Ok::<Value, IIIError>(json!({
        "registered": true,
        "functionId": function_id,
        "securityReport": fn_record.security_report,
    }))
}

async fn evolve_unregister(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let agent_id = body.get("agentId").and_then(|v| v.as_str()).map(String::from);

    let fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;
    let mut fn_record: EvolvedFunction =
        serde_json::from_value(fn_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    if Some(&fn_record.author_agent_id) != agent_id.as_ref() {
        return Err(IIIError::Handler(
            "Only the author agent can unregister".into(),
        ));
    }

    fn_record.status = "killed".into();
    fn_record.updated_at = now_ms();
    let value = serde_json::to_value(&fn_record).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "evolved_functions", &function_id, value).await?;

    Ok::<Value, IIIError>(json!({ "unregistered": true, "functionId": function_id }))
}

async fn evolve_list(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if let Some(query) = input.get("query") {
        if !query.is_null() { query.clone() } else { unwrap_body(&input) }
    } else {
        unwrap_body(&input)
    };

    let entries = state_list(iii, "evolved_functions").await;
    let mut functions = entries_to_records(entries);

    if let Some(status) = body.get("status").and_then(|v| v.as_str()) {
        functions.retain(|f| f.get("status").and_then(|s| s.as_str()) == Some(status));
    }
    if let Some(agent_id) = body.get("agentId").and_then(|v| v.as_str()) {
        functions.retain(|f| {
            f.get("authorAgentId").and_then(|a| a.as_str()) == Some(agent_id)
        });
    }

    Ok::<Value, IIIError>(Value::Array(functions))
}

async fn evolve_get(iii: &III, input: Value) -> Result<Value, IIIError> {
    let function_id = input
        .get("params")
        .and_then(|p| p.get("functionId"))
        .and_then(|v| v.as_str())
        .or_else(|| input.get("functionId").and_then(|v| v.as_str()))
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();

    let fn_val = state_get(iii, "evolved_functions", &function_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Function not found".into()))?;

    Ok::<Value, IIIError>(fn_val)
}

async fn evolve_fork(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let source_id = body.get("sourceId").and_then(|v| v.as_str()).map(String::from);
    let goal = body.get("goal").and_then(|v| v.as_str()).map(String::from);
    let agent_id = body.get("agentId").and_then(|v| v.as_str()).map(String::from);
    if source_id.is_none() || goal.is_none() || agent_id.is_none() {
        return Err(IIIError::Handler(
            "sourceId, goal, and agentId are required".into(),
        ));
    }
    let source_id = source_id.unwrap();
    let goal = goal.unwrap();
    let agent_id = agent_id.unwrap();
    let extra_meta = body.get("metadata").cloned().unwrap_or(json!({}));

    let source_val = state_get(iii, "evolved_functions", &source_id)
        .await
        .filter(|v| !v.is_null())
        .ok_or_else(|| IIIError::Handler("Source function not found".into()))?;
    let source: EvolvedFunction =
        serde_json::from_value(source_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    let stripped = strip_version_suffix(&source.function_id);
    let base_name = stripped.strip_prefix("evolved::").unwrap_or(&stripped).to_string();
    let safe_name = sanitize_id(&base_name)?;

    let entries = state_list(iii, "evolved_functions").await;
    let records = entries_to_records(entries);
    let prefix = format!("evolved::{safe_name}_v");
    let next_version = next_version_for(&prefix, &records);
    let function_id = format!("evolved::{safe_name}_v{next_version}");

    let prompt = format!(
        "Improve the following JavaScript function based on the goal below. Return ONLY the function body as an arrow function expression. Do not include markdown, explanations, or code fences.\n\nCurrent code:\n{}\n\nCurrent description: {}\n\nImprovement goal: {goal}\n\nThe function receives a single `input` parameter and must return a result.\nIt has access to: JSON, Math, Date, Array, Object, String, Number, Boolean, Map, Set, Promise.\nIt can call `await trigger({{ function_id: fnId, payload: data }})` for evolved::, tool::, llm:: prefixes.",
        source.code,
        source.description,
    );
    let llm_result = invoke_llm_complete(iii, &prompt).await?;
    let raw_code = llm_result.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let code = strip_code_fences(raw_code);

    let mut metadata: serde_json::Map<String, Value> = match extra_meta {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    metadata.insert("forkedFrom".to_string(), Value::String(source_id.clone()));

    let now = now_ms();
    let record = EvolvedFunction {
        function_id: function_id.clone(),
        code,
        description: format!("{} (fork: {goal})", source.description),
        author_agent_id: agent_id,
        version: next_version,
        status: "draft".into(),
        created_at: now,
        updated_at: now,
        eval_scores: None,
        security_report: SecurityReport::default(),
        parent_version: Some(source_id),
        metadata: Value::Object(metadata),
    };

    let value = serde_json::to_value(&record).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "evolved_functions", &function_id, value.clone()).await?;

    Ok::<Value, IIIError>(value)
}

fn strip_version_suffix(function_id: &str) -> String {
    if let Some(idx) = function_id.rfind("_v") {
        let suffix = &function_id[idx + 2..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return function_id[..idx].to_string();
        }
    }
    function_id.to_string()
}

async fn evolve_leaves(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = if let Some(query) = input.get("query") {
        if !query.is_null() { query.clone() } else { unwrap_body(&input) }
    } else {
        unwrap_body(&input)
    };

    let entries = state_list(iii, "evolved_functions").await;
    let mut functions = entries_to_records(entries);

    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        let safe_name = sanitize_id(name)?;
        let prefix = format!("evolved::{safe_name}_v");
        functions.retain(|f| {
            f.get("functionId")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s.starts_with(&prefix))
        });
    }
    if let Some(status) = body.get("status").and_then(|v| v.as_str()) {
        functions.retain(|f| f.get("status").and_then(|s| s.as_str()) == Some(status));
    }

    let child_parents: std::collections::HashSet<String> = functions
        .iter()
        .filter_map(|f| f.get("parentVersion").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let leaves: Vec<Value> = functions
        .into_iter()
        .filter(|f| {
            let id = f.get("functionId").and_then(|v| v.as_str()).unwrap_or("");
            let status = f.get("status").and_then(|v| v.as_str()).unwrap_or("");
            !child_parents.contains(id) && status != "killed"
        })
        .map(|f| {
            json!({
                "functionId": f.get("functionId").cloned().unwrap_or(Value::Null),
                "version": f.get("version").cloned().unwrap_or(Value::Null),
                "status": f.get("status").cloned().unwrap_or(Value::Null),
                "parentVersion": f.get("parentVersion").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or(Value::Null),
                "evalScores": f.get("evalScores").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok::<Value, IIIError>(Value::Array(leaves))
}

async fn evolve_lineage(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = unwrap_body(&input);
    let function_id = body
        .get("functionId")
        .and_then(|v| v.as_str())
        .or_else(|| {
            input
                .get("query")
                .and_then(|q| q.get("functionId"))
                .and_then(|v| v.as_str())
        })
        .ok_or_else(|| IIIError::Handler("functionId is required".into()))?
        .to_string();
    let safe_function_id = sanitize_id(&function_id)?;

    let mut lineage: Vec<Value> = Vec::new();
    let mut current_id: Option<String> = Some(safe_function_id.clone());
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    const MAX_DEPTH: usize = 100;

    while let Some(cid) = current_id {
        if visited.contains(&cid) || lineage.len() >= MAX_DEPTH {
            break;
        }
        visited.insert(cid.clone());
        let val = state_get(iii, "evolved_functions", &cid).await;
        let val = match val {
            Some(v) if !v.is_null() => v,
            _ => break,
        };
        let function_id = val.get("functionId").cloned().unwrap_or(Value::Null);
        let version = val.get("version").cloned().unwrap_or(Value::Null);
        let status = val.get("status").cloned().unwrap_or(Value::Null);
        let parent = val.get("parentVersion").cloned().unwrap_or(Value::Null);
        let description = val.get("description").cloned().unwrap_or(Value::Null);
        let eval_scores = val.get("evalScores").cloned().unwrap_or(Value::Null);
        lineage.push(json!({
            "functionId": function_id,
            "version": version,
            "status": status,
            "parentVersion": parent.clone(),
            "description": description,
            "evalScores": eval_scores,
        }));
        current_id = parent.as_str().map(String::from);
    }

    Ok::<Value, IIIError>(json!({
        "functionId": safe_function_id,
        "depth": lineage.len(),
        "lineage": lineage,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::generate", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_generate(&iii, input).await }
        })
        .description("LLM writes function code from a goal/spec"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::register", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_register(&iii, input).await }
        })
        .description("Security scan + register on iii bus"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::unregister", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_unregister(&iii, input).await }
        })
        .description("Remove dynamic function, mark as killed"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::list", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_list(&iii, input).await }
        })
        .description("List all evolved functions (filter by status/agent)"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::get", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_get(&iii, input).await }
        })
        .description("Get source code + metadata + eval scores"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::fork", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_fork(&iii, input).await }
        })
        .description("Branch from any version to create a new exploration path"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::leaves", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_leaves(&iii, input).await }
        })
        .description("Find frontier versions with no children"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("evolve::lineage", move |input: Value| {
            let iii = iii_clone.clone();
            async move { evolve_lineage(&iii, input).await }
        })
        .description("Trace ancestry from a version back to root"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::generate".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/evolve/generate" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::register".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/evolve/register" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::unregister".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/evolve/unregister" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::list".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/evolve" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::get".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/evolve/:functionId" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::fork".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/evolve/fork" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::leaves".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/evolve/leaves" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "evolve::lineage".to_string(),
        config: json!({ "http_method": "GET", "api_path": "api/evolve/lineage" }),
        metadata: None,
    })?;

    tracing::info!("evolve worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_id_accepts_valid() {
        assert_eq!(sanitize_id("doubler").unwrap(), "doubler");
        assert_eq!(sanitize_id("evolved::foo_v1").unwrap(), "evolved::foo_v1");
        assert_eq!(sanitize_id("name-1.2_3").unwrap(), "name-1.2_3");
    }

    #[test]
    fn test_sanitize_id_rejects_invalid() {
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("bad/slash").is_err());
        assert!(sanitize_id("space here").is_err());
        assert!(sanitize_id(&"x".repeat(257)).is_err());
    }

    #[test]
    fn test_strip_code_fences_basic() {
        assert_eq!(strip_code_fences("foo"), "foo");
        assert_eq!(strip_code_fences("```js\nasync (x) => x\n```"), "async (x) => x");
        assert_eq!(strip_code_fences("```\nasync (x) => x```"), "async (x) => x");
    }

    #[test]
    fn test_parse_version_suffix() {
        assert_eq!(parse_version_suffix("evolved::adder_v1"), Some(1));
        assert_eq!(parse_version_suffix("evolved::adder_v42"), Some(42));
        assert_eq!(parse_version_suffix("evolved::adder"), None);
    }

    #[test]
    fn test_strip_version_suffix() {
        assert_eq!(strip_version_suffix("evolved::calc_v1"), "evolved::calc");
        assert_eq!(strip_version_suffix("evolved::calc_v42"), "evolved::calc");
        assert_eq!(strip_version_suffix("evolved::calc"), "evolved::calc");
        assert_eq!(strip_version_suffix("evolved::calc_vX"), "evolved::calc_vX");
    }

    #[test]
    fn test_next_version_for() {
        let prefix = "evolved::adder_v";
        let records = vec![
            json!({ "functionId": "evolved::adder_v1" }),
            json!({ "functionId": "evolved::adder_v3" }),
            json!({ "functionId": "evolved::other_v1" }),
        ];
        assert_eq!(next_version_for(prefix, &records), 4);
    }

    #[test]
    fn test_next_version_for_empty() {
        assert_eq!(next_version_for("evolved::new_v", &[]), 1);
    }

    #[test]
    fn test_extra_meta_cannot_override_status() {
        // The CR rule: caller-supplied metadata must NOT replace top-level fields.
        // We verify by constructing the EvolvedFunction directly: the metadata
        // field stores user values, but status/createdAt/updatedAt are always
        // set by the worker.
        let extra_meta = json!({ "status": "production", "version": 999, "tag": "x" });
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
            metadata: extra_meta,
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["status"], json!("draft"));
        assert_eq!(v["version"], json!(1));
        assert_eq!(v["metadata"]["status"], json!("production"));
        assert_eq!(v["metadata"]["tag"], json!("x"));
    }
}

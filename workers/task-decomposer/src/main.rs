use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker,
};
use serde_json::{Value, json};

mod types;

use types::{Task, TaskStatus, sanitize_id, strip_code_fences};

const MAX_DEPTH: u32 = 3;
const MAX_SUBTASKS: usize = 10;

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn generate_task_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!("t_{:x}{}", now, &suffix[..4])
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Result<Value, IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn state_list(iii: &III, scope: &str) -> Value {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .unwrap_or(json!([]))
}

async fn decompose_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("description is required".into()))?
        .to_string();

    let current_depth = input.get("depth").and_then(Value::as_u64).unwrap_or(0) as u32;
    if current_depth >= MAX_DEPTH {
        return Ok::<Value, IIIError>(json!({
            "decomposed": false,
            "reason": "Max depth reached",
        }));
    }

    let root_id = match input.get("rootId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => sanitize_id(s).map_err(IIIError::Handler)?,
        _ => generate_task_id(),
    };
    let parent_id = input
        .get("parentId")
        .and_then(Value::as_str)
        .map(sanitize_id)
        .transpose()
        .map_err(IIIError::Handler)?;
    let task_id = parent_id.clone().unwrap_or_else(|| root_id.clone());

    let model = input
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("default");

    let llm_result = iii
        .trigger(TriggerRequest {
            function_id: "llm::chat".to_string(),
            payload: json!({
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": format!(
                            "Decompose the following task into subtasks. Return JSON: {{ \"subtasks\": [{{ \"id\": \"<parentId>.<n>\", \"description\": \"...\" }}] }}. Maximum {MAX_SUBTASKS} subtasks. Parent ID is \"{task_id}\". Use hierarchical numbering (e.g., {task_id}.1, {task_id}.2)."
                        ),
                    },
                    { "role": "user", "content": description },
                ],
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let content = llm_result
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let parsed: Value = match serde_json::from_str(&strip_code_fences(content)) {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!(root_id = %root_id, task_id = %task_id, "Failed to parse LLM decomposition");
            return Ok::<Value, IIIError>(json!({
                "decomposed": false,
                "reason": "LLM parse failure",
                "rootId": root_id,
            }));
        }
    };

    let mut subtasks: Vec<(String, String)> = Vec::new();
    if let Some(arr) = parsed.get("subtasks").and_then(Value::as_array) {
        for sub in arr.iter().take(MAX_SUBTASKS) {
            let id = sub.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let desc = sub
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            subtasks.push((id, desc));
        }
    }

    let scope = format!("tasks:{root_id}");
    let edges_scope = format!("task_edges:{root_id}");

    if parent_id.is_none() {
        let now = now_ms();
        let root_task = Task {
            id: root_id.clone(),
            root_id: root_id.clone(),
            parent_id: None,
            description: description.clone(),
            status: TaskStatus::Pending,
            depth: 0,
            children: subtasks.iter().map(|(id, _)| id.clone()).collect(),
            created_at: now,
            updated_at: now,
        };
        let value =
            serde_json::to_value(&root_task).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(iii, &scope, &root_id, value).await?;
    }

    let mut created: Vec<Task> = Vec::new();
    for (sub_id, sub_desc) in &subtasks {
        let now = now_ms();
        let task = Task {
            id: sub_id.clone(),
            root_id: root_id.clone(),
            parent_id: Some(task_id.clone()),
            description: sub_desc.clone(),
            status: TaskStatus::Pending,
            depth: current_depth + 1,
            children: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        let value = serde_json::to_value(&task).map_err(|e| IIIError::Handler(e.to_string()))?;
        state_set(iii, &scope, sub_id, value).await?;

        state_set(
            iii,
            &edges_scope,
            &format!("{task_id}->{sub_id}"),
            json!({ "parent": task_id, "child": sub_id }),
        )
        .await?;

        created.push(task);
    }

    if let Some(parent_id) = &parent_id {
        let parent_val = state_get(iii, &scope, parent_id).await?;
        if !parent_val.is_null()
            && let Ok(mut parent_task) = serde_json::from_value::<Task>(parent_val)
        {
            let mut child_set: std::collections::BTreeSet<String> =
                parent_task.children.into_iter().collect();
            for (sub_id, _) in &subtasks {
                child_set.insert(sub_id.clone());
            }
            parent_task.children = child_set.into_iter().collect();
            parent_task.updated_at = now_ms();
            let value =
                serde_json::to_value(&parent_task).map_err(|e| IIIError::Handler(e.to_string()))?;
            state_set(iii, &scope, parent_id, value).await?;
        }
    }

    tracing::info!(
        root_id = %root_id,
        task_id = %task_id,
        subtask_count = created.len(),
        "Task decomposed"
    );

    Ok::<Value, IIIError>(json!({
        "rootId": root_id,
        "taskId": task_id,
        "subtasks": created,
    }))
}

async fn get_task(iii: &III, input: Value) -> Result<Value, IIIError> {
    let raw_root_id = input
        .get("rootId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId and taskId are required".into()))?;
    let raw_task_id = input
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId and taskId are required".into()))?;
    let root_id = sanitize_id(raw_root_id).map_err(IIIError::Handler)?;
    let task_id = sanitize_id(raw_task_id).map_err(IIIError::Handler)?;

    let task = state_get(iii, &format!("tasks:{root_id}"), &task_id).await?;
    if task.is_null() {
        return Err(IIIError::Handler("Task not found".into()));
    }
    Ok(task)
}

async fn update_status(iii: &III, input: Value) -> Result<Value, IIIError> {
    let raw_root_id = input
        .get("rootId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId, taskId, and status are required".into()))?;
    let raw_task_id = input
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId, taskId, and status are required".into()))?;
    let status_str = input
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId, taskId, and status are required".into()))?;

    let root_id = sanitize_id(raw_root_id).map_err(IIIError::Handler)?;
    let task_id = sanitize_id(raw_task_id).map_err(IIIError::Handler)?;
    let status = TaskStatus::from_str(status_str)
        .ok_or_else(|| IIIError::Handler(format!("Invalid status: {status_str}")))?;

    let scope = format!("tasks:{root_id}");
    let task_val = state_get(iii, &scope, &task_id).await?;
    if task_val.is_null() {
        return Err(IIIError::Handler("Task not found".into()));
    }
    let mut task: Task = serde_json::from_value(task_val)
        .map_err(|e| IIIError::Handler(format!("invalid task record: {e}")))?;

    task.status = status;
    task.updated_at = now_ms();
    let value = serde_json::to_value(&task).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, &scope, &task_id, value).await?;

    let mut parent_id_opt = task.parent_id.clone();
    while let Some(parent_id) = parent_id_opt {
        let parent_val = state_get(iii, &scope, &parent_id).await?;
        if parent_val.is_null() {
            break;
        }
        let mut parent: Task = match serde_json::from_value(parent_val) {
            Ok(p) => p,
            Err(_) => break,
        };
        if parent.children.is_empty() {
            break;
        }

        let mut siblings: Vec<Option<Task>> = Vec::with_capacity(parent.children.len());
        for child_id in &parent.children {
            let val = state_get(iii, &scope, child_id).await?;
            if val.is_null() {
                siblings.push(None);
            } else {
                siblings.push(serde_json::from_value(val).ok());
            }
        }

        let all_complete = siblings
            .iter()
            .all(|s| matches!(s, Some(t) if t.status == TaskStatus::Complete));
        let any_failed = siblings
            .iter()
            .any(|s| matches!(s, Some(t) if t.status == TaskStatus::Failed));

        let new_parent_status = if all_complete {
            Some(TaskStatus::Complete)
        } else if any_failed {
            Some(TaskStatus::Blocked)
        } else {
            None
        };

        match new_parent_status {
            None => break,
            Some(s) if s == parent.status => break,
            Some(s) => {
                parent.status = s;
                parent.updated_at = now_ms();
                let value =
                    serde_json::to_value(&parent).map_err(|e| IIIError::Handler(e.to_string()))?;
                state_set(iii, &scope, &parent.id.clone(), value).await?;
                parent_id_opt = parent.parent_id.clone();
            }
        }
    }

    tracing::info!(root_id = %root_id, task_id = %task_id, status = ?status, "Task status updated");

    Ok::<Value, IIIError>(json!({
        "taskId": task_id,
        "status": status,
        "updatedAt": task.updated_at,
    }))
}

async fn list_tasks(iii: &III, input: Value) -> Result<Value, IIIError> {
    let raw_root_id = input
        .get("rootId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId is required".into()))?;
    let root_id = sanitize_id(raw_root_id).map_err(IIIError::Handler)?;
    let status_filter = input
        .get("status")
        .and_then(Value::as_str)
        .map(String::from);

    let entries = state_list(iii, &format!("tasks:{root_id}")).await;
    let arr = entries.as_array().cloned().unwrap_or_default();

    let mut tasks: Vec<Value> = arr
        .into_iter()
        .map(|e| e.get("value").cloned().unwrap_or(e))
        .collect();

    if let Some(status) = status_filter {
        tasks.retain(|t| {
            t.get("status")
                .and_then(Value::as_str)
                .map(|s| s == status)
                .unwrap_or(false)
        });
    }

    Ok::<Value, IIIError>(json!({
        "rootId": root_id,
        "count": tasks.len(),
        "tasks": tasks,
    }))
}

async fn spawn_workers(iii: &III, input: Value) -> Result<Value, IIIError> {
    let raw_root_id = input
        .get("rootId")
        .and_then(Value::as_str)
        .ok_or_else(|| IIIError::Handler("rootId is required".into()))?;
    let root_id = sanitize_id(raw_root_id).map_err(IIIError::Handler)?;

    let entries = state_list(iii, &format!("tasks:{root_id}")).await;
    let arr = entries.as_array().cloned().unwrap_or_default();

    let mut spawned = 0u64;
    for entry in arr {
        let task_val = entry.get("value").cloned().unwrap_or(entry);
        let status = task_val.get("status").and_then(Value::as_str).unwrap_or("");
        let children_empty = task_val
            .get("children")
            .and_then(Value::as_array)
            .map(|c| c.is_empty())
            .unwrap_or(true);
        if status != "pending" || !children_empty {
            continue;
        }
        let task_id = task_val
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let description = task_val
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let iii_clone = iii.clone();
        let payload = json!({
            "template": "task-worker",
            "message": description,
            "metadata": { "rootId": root_id.clone(), "taskId": task_id },
        });
        tokio::spawn(async move {
            let _ = iii_clone
                .trigger(TriggerRequest {
                    function_id: "tool::agent_spawn".to_string(),
                    payload,
                    action: None,
                    timeout_ms: None,
                })
                .await;
        });
        spawned += 1;
    }

    tracing::info!(root_id = %root_id, count = spawned, "Spawned task workers");

    Ok::<Value, IIIError>(json!({
        "rootId": root_id,
        "spawned": spawned,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("task::decompose", move |input: Value| {
            let iii = iii_clone.clone();
            async move { decompose_task(&iii, input).await }
        })
        .description("Recursively decompose a complex task into subtasks with hierarchical IDs"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("task::get", move |input: Value| {
            let iii = iii_clone.clone();
            async move { get_task(&iii, input).await }
        })
        .description("Get a task by rootId and taskId"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("task::update_status", move |input: Value| {
            let iii = iii_clone.clone();
            async move { update_status(&iii, input).await }
        })
        .description("Update task status and propagate to parent"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("task::list", move |input: Value| {
            let iii = iii_clone.clone();
            async move { list_tasks(&iii, input).await }
        })
        .description("List tasks by rootId with optional status filter"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("task::spawn_workers", move |input: Value| {
            let iii = iii_clone.clone();
            async move { spawn_workers(&iii, input).await }
        })
        .description("Spawn agents for pending leaf tasks"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "task::decompose".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/tasks/decompose" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "task::get".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/tasks/get" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "task::update_status".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/tasks/status" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "task::list".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/tasks/list" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "task::spawn_workers".to_string(),
        config: json!({ "http_method": "POST", "api_path": "api/tasks/spawn" }),
        metadata: None,
    })?;

    tracing::info!("task-decomposer worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_id_is_unique() {
        let a = generate_task_id();
        let b = generate_task_id();
        assert!(a.starts_with("t_"));
        assert!(b.starts_with("t_"));
        assert_ne!(a, b);
    }
}

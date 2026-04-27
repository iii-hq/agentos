use iii_sdk::{register_worker, InitOptions, III};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{
    CreateDirectiveRequest, Directive, DirectiveStatus, ListDirectivesRequest,
    UpdateDirectiveRequest,
};

fn scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:directives")
}

async fn create_directive(iii: &III, req: CreateDirectiveRequest) -> Result<Value, IIIError> {
    if let Some(ref parent_id) = req.parent_id {
        let parent = iii
            .trigger("state::get", json!({ "scope": scope(&req.realm_id), "key": parent_id }))
            .await
            .map_err(|e| IIIError::Handler(format!("parent directive not found: {e}")))?;

        if parent.is_null() {
            return Err(IIIError::Handler(format!("parent directive {parent_id} not found")));
        }
    }

    let id = format!("dir-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let directive = Directive {
        id: id.clone(),
        realm_id: req.realm_id.clone(),
        title: req.title,
        description: req.description,
        level: req.level,
        status: DirectiveStatus::Active,
        parent_id: req.parent_id,
        owner_agent_id: req.owner_agent_id,
        priority: req.priority,
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };

    let value = serde_json::to_value(&directive).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": scope(&req.realm_id),
        "key": id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "directive.lifecycle",
        "data": { "type": "created", "directiveId": directive.id, "realmId": directive.realm_id },
    }));

    Ok(serde_json::to_value(&directive).unwrap())
}

async fn get_directive(iii: &III, realm_id: &str, id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::get", json!({
        "scope": scope(realm_id),
        "key": id,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn list_directives(iii: &III, req: ListDirectivesRequest) -> Result<Value, IIIError> {
    let all = iii
        .trigger("state::list", json!({ "scope": scope(&req.realm_id) }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let directives: Vec<Directive> = if let Some(arr) = all.as_array() {
        arr.iter()
            .filter_map(|v| serde_json::from_value::<Directive>(v.clone()).ok())
            .filter(|d| {
                let level_ok = req.level.as_ref().map_or(true, |l| &d.level == l);
                let status_ok = req.status.as_ref().map_or(true, |s| &d.status == s);
                let parent_ok = req.parent_id.as_ref().map_or(true, |p| d.parent_id.as_ref() == Some(p));
                level_ok && status_ok && parent_ok
            })
            .collect()
    } else {
        vec![]
    };

    Ok(json!({
        "directives": directives,
        "count": directives.len(),
    }))
}

async fn update_directive(iii: &III, req: UpdateDirectiveRequest) -> Result<Value, IIIError> {
    let realm_id = &req.realm_id;
    let existing = iii
        .trigger("state::get", json!({ "scope": scope(realm_id), "key": &req.id }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut d: Directive = serde_json::from_value(existing)
        .map_err(|e| IIIError::Handler(format!("directive {} not found: {e}", req.id)))?;

    if let Some(title) = req.title {
        d.title = title;
    }
    if let Some(desc) = req.description {
        d.description = Some(desc);
    }
    if let Some(status) = req.status {
        d.status = status;
    }
    if let Some(priority) = req.priority {
        d.priority = Some(priority);
    }
    if let Some(owner) = req.owner_agent_id {
        d.owner_agent_id = Some(owner);
    }
    let prev_version = d.version;
    d.version = prev_version + 1;
    d.updated_at = chrono::Utc::now().to_rfc3339();

    let value = serde_json::to_value(&d).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": scope(realm_id),
        "key": d.id,
        "value": value,
        "expectedVersion": prev_version,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(serde_json::to_value(&d).unwrap())
}

async fn get_ancestry(iii: &III, realm_id: &str, id: &str) -> Result<Value, IIIError> {
    let all = iii
        .trigger("state::list", json!({ "scope": scope(realm_id) }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let directives: Vec<Directive> = all
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    let map: std::collections::HashMap<&str, &Directive> =
        directives.iter().map(|d| (d.id.as_str(), d)).collect();

    let mut chain = vec![];
    let mut current = id;
    let mut visited = std::collections::HashSet::new();

    loop {
        if !visited.insert(current) {
            break;
        }
        if let Some(d) = map.get(current) {
            chain.push(serde_json::to_value(*d).unwrap());
            match &d.parent_id {
                Some(pid) => current = pid.as_str(),
                None => break,
            }
        } else {
            break;
        }
    }

    Ok(json!({
        "ancestry": chain,
        "depth": chain.len(),
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default())?;

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "directive::create",
        "Create a strategic directive",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CreateDirectiveRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                create_directive(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "directive::get",
        "Get directive by ID",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                get_directive(&iii, realm_id, id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "directive::list",
        "List directives with filtering",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ListDirectivesRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                list_directives(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "directive::update",
        "Update directive status or details",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: UpdateDirectiveRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                update_directive(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "directive::ancestry",
        "Trace directive ancestry to root",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                get_ancestry(&iii, realm_id, id).await
            }
        },
    );

    iii.register_trigger("http", "directive::create", json!({ "method": "POST", "path": "/api/directives" }))?;
    iii.register_trigger("http", "directive::get", json!({ "method": "GET", "path": "/api/directives/:realmId/:id" }))?;
    iii.register_trigger("http", "directive::list", json!({ "method": "GET", "path": "/api/directives/:realmId" }))?;
    iii.register_trigger("http", "directive::update", json!({ "method": "PATCH", "path": "/api/directives/:realmId/:id" }))?;
    iii.register_trigger("http", "directive::ancestry", json!({ "method": "GET", "path": "/api/directives/:realmId/:id/ancestry" }))?;

    tracing::info!("directive worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

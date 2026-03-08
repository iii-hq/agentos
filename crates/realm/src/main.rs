use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{CreateRealmRequest, ExportRequest, ImportRequest, Realm, RealmStatus, UpdateRealmRequest};

async fn create_realm(iii: &III, req: CreateRealmRequest) -> Result<Value, IIIError> {
    let id = format!("realm-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let realm = Realm {
        id: id.clone(),
        name: req.name,
        description: req.description,
        status: RealmStatus::Active,
        owner: req.owner,
        default_model: req.default_model,
        max_agents: req.max_agents,
        metadata: req.metadata,
        created_at: now.clone(),
        updated_at: now,
    };

    let value = serde_json::to_value(&realm).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": "realms",
        "key": id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "realm.lifecycle",
        "data": { "type": "created", "realmId": realm.id },
    }));

    Ok(serde_json::to_value(&realm).unwrap())
}

async fn get_realm(iii: &III, id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::get", json!({
        "scope": "realms",
        "key": id,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn list_realms(iii: &III) -> Result<Value, IIIError> {
    iii.trigger("state::list", json!({ "scope": "realms" }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn update_realm(iii: &III, req: UpdateRealmRequest) -> Result<Value, IIIError> {
    let existing = get_realm(iii, &req.id).await?;
    let mut realm: Realm =
        serde_json::from_value(existing).map_err(|e| IIIError::Handler(e.to_string()))?;

    if let Some(name) = req.name {
        realm.name = name;
    }
    if let Some(desc) = req.description {
        realm.description = Some(desc);
    }
    if let Some(status) = req.status {
        realm.status = status;
    }
    if let Some(model) = req.default_model {
        realm.default_model = Some(model);
    }
    if let Some(max) = req.max_agents {
        realm.max_agents = Some(max);
    }
    if let Some(meta) = req.metadata {
        realm.metadata = Some(meta);
    }
    realm.updated_at = chrono::Utc::now().to_rfc3339();

    let value = serde_json::to_value(&realm).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": "realms",
        "key": realm.id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "realm.lifecycle",
        "data": { "type": "updated", "realmId": realm.id },
    }));

    Ok(serde_json::to_value(&realm).unwrap())
}

async fn delete_realm(iii: &III, id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::delete", json!({
        "scope": "realms",
        "key": id,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "realm.lifecycle",
        "data": { "type": "deleted", "realmId": id },
    }));

    Ok(json!({ "deleted": true }))
}

async fn export_realm(iii: &III, req: ExportRequest) -> Result<Value, IIIError> {
    let realm = get_realm(iii, &req.id).await?;
    let scrub = req.scrub_secrets.unwrap_or(true);

    let agents = iii
        .trigger("state::list", json!({ "scope": format!("realm:{}:agents", req.id) }))
        .await
        .unwrap_or(json!([]));

    let directives = iii
        .trigger("state::list", json!({ "scope": format!("realm:{}:directives", req.id) }))
        .await
        .unwrap_or(json!([]));

    let hierarchy = iii
        .trigger("state::list", json!({ "scope": format!("realm:{}:hierarchy", req.id) }))
        .await
        .unwrap_or(json!([]));

    let mut export = json!({
        "version": "1.0",
        "realm": realm,
        "agents": agents,
        "directives": directives,
        "hierarchy": hierarchy,
    });

    if scrub {
        if let Some(obj) = export.as_object_mut() {
            obj.remove("secrets");
        }
    }

    Ok(export)
}

async fn import_realm(iii: &III, req: ImportRequest) -> Result<Value, IIIError> {
    let version = req.data["version"].as_str().unwrap_or("1.0");
    if version != "1.0" {
        return Err(IIIError::Handler(format!("unsupported export version: {version}")));
    }

    let create_req = CreateRealmRequest {
        name: req.data["realm"]["name"]
            .as_str()
            .unwrap_or("Imported Realm")
            .to_string(),
        description: req.data["realm"]["description"].as_str().map(String::from),
        owner: req
            .new_owner
            .unwrap_or_else(|| req.data["realm"]["owner"].as_str().unwrap_or("system").to_string()),
        default_model: req.data["realm"]["defaultModel"].as_str().map(String::from),
        max_agents: req.data["realm"]["maxAgents"].as_u64().map(|v| v as u32),
        metadata: None,
    };

    let realm = create_realm(iii, create_req).await?;
    let realm_id = realm["id"].as_str().unwrap_or("");

    if let Some(agents) = req.data["agents"].as_array() {
        for agent in agents {
            let mut agent = agent.clone();
            agent["realmId"] = json!(realm_id);
            let _ = iii
                .trigger("state::set", json!({
                    "scope": format!("realm:{realm_id}:agents"),
                    "key": agent["id"].as_str().unwrap_or("unknown"),
                    "value": agent,
                }))
                .await;
        }
    }

    Ok(json!({
        "imported": true,
        "realmId": realm_id,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::create",
        "Create a new isolated realm",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CreateRealmRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                create_realm(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::get",
        "Get realm by ID",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                get_realm(&iii, id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::list",
        "List all realms",
        move |_: Value| {
            let iii = iii_clone.clone();
            async move { list_realms(&iii).await }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::update",
        "Update realm configuration",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: UpdateRealmRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                update_realm(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::delete",
        "Delete a realm and all its data",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                delete_realm(&iii, id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::export",
        "Export realm as portable template",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ExportRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                export_realm(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "realm::import",
        "Import realm from template",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ImportRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                import_realm(&iii, req).await
            }
        },
    );

    iii.register_trigger("http", "realm::create", json!({ "method": "POST", "path": "/api/realms" }))?;
    iii.register_trigger("http", "realm::list", json!({ "method": "GET", "path": "/api/realms" }))?;
    iii.register_trigger("http", "realm::get", json!({ "method": "GET", "path": "/api/realms/:id" }))?;
    iii.register_trigger("http", "realm::update", json!({ "method": "PATCH", "path": "/api/realms/:id" }))?;
    iii.register_trigger("http", "realm::delete", json!({ "method": "DELETE", "path": "/api/realms/:id" }))?;
    iii.register_trigger("http", "realm::export", json!({ "method": "POST", "path": "/api/realms/:id/export" }))?;
    iii.register_trigger("http", "realm::import", json!({ "method": "POST", "path": "/api/realms/import" }))?;

    tracing::info!("realm worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

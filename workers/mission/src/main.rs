use iii_sdk::{register_worker, InitOptions, III};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

mod types;

use types::{
    CheckoutRequest, Comment, CommentRequest, CreateMissionRequest, ListMissionsRequest, Mission,
    MissionPriority, MissionStatus, TransitionRequest,
};

fn scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:missions")
}

fn comments_scope(realm_id: &str, mission_id: &str) -> String {
    format!("realm:{realm_id}:missions:{mission_id}:comments")
}

async fn create_mission(iii: &III, req: CreateMissionRequest) -> Result<Value, IIIError> {
    let id = format!("msn-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let mission = Mission {
        id: id.clone(),
        realm_id: req.realm_id.clone(),
        directive_id: req.directive_id,
        parent_id: req.parent_id,
        title: req.title,
        description: req.description,
        status: MissionStatus::Backlog,
        priority: req.priority.unwrap_or(MissionPriority::Normal),
        assignee_id: None,
        created_by: req.created_by,
        billing_code: req.billing_code,
        version: 1,
        started_at: None,
        completed_at: None,
        created_at: now.clone(),
        updated_at: now,
    };

    let value = serde_json::to_value(&mission).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": scope(&req.realm_id),
        "key": id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "mission.lifecycle",
        "data": { "type": "created", "missionId": mission.id, "realmId": mission.realm_id },
    }));

    Ok(serde_json::to_value(&mission).unwrap())
}

async fn load_mission(iii: &III, realm_id: &str, id: &str) -> Result<Mission, IIIError> {
    let val = iii
        .trigger("state::get", json!({
            "scope": scope(realm_id),
            "key": id,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    serde_json::from_value(val).map_err(|e| IIIError::Handler(format!("mission {id} not found: {e}")))
}

async fn save_mission(iii: &III, mission: &Mission) -> Result<(), IIIError> {
    let value = serde_json::to_value(mission).map_err(|e| IIIError::Handler(e.to_string()))?;
    iii.trigger("state::set", json!({
        "scope": scope(&mission.realm_id),
        "key": mission.id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn checkout_mission(iii: &III, req: CheckoutRequest) -> Result<Value, IIIError> {
    let realm_id = &req.realm_id;
    let mut mission = load_mission(iii, realm_id, &req.id).await?;

    if mission.assignee_id.is_some() && mission.assignee_id.as_deref() != Some(&req.agent_id) {
        return Err(IIIError::Handler(format!(
            "mission {} already checked out by {}",
            req.id,
            mission.assignee_id.as_deref().unwrap_or("unknown")
        )));
    }

    if !matches!(mission.status, MissionStatus::Backlog | MissionStatus::Queued | MissionStatus::Blocked) {
        return Err(IIIError::Handler(format!(
            "cannot checkout mission in {:?} status",
            mission.status
        )));
    }

    let expected_version = mission.version;

    mission.assignee_id = Some(req.agent_id.clone());
    mission.status = MissionStatus::Active;
    mission.started_at = Some(chrono::Utc::now().to_rfc3339());
    mission.version = expected_version + 1;
    mission.updated_at = chrono::Utc::now().to_rfc3339();

    save_mission(iii, &mission).await?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "mission.lifecycle",
        "data": {
            "type": "checked_out",
            "missionId": mission.id,
            "agentId": req.agent_id,
        },
    }));

    Ok(serde_json::to_value(&mission).unwrap())
}

async fn release_mission(iii: &III, realm_id: &str, id: &str, agent_id: &str) -> Result<Value, IIIError> {
    let mut mission = load_mission(iii, realm_id, id).await?;

    if mission.assignee_id.as_deref() != Some(agent_id) {
        return Err(IIIError::Handler("only the assignee can release a mission".into()));
    }

    mission.assignee_id = None;
    mission.status = MissionStatus::Queued;
    mission.version += 1;
    mission.updated_at = chrono::Utc::now().to_rfc3339();

    save_mission(iii, &mission).await?;

    Ok(json!({ "released": true, "missionId": id }))
}

async fn transition_mission(iii: &III, req: TransitionRequest) -> Result<Value, IIIError> {
    let realm_id = &req.realm_id;
    let mut mission = load_mission(iii, realm_id, &req.id).await?;

    if !mission.status.can_transition_to(&req.status) {
        return Err(IIIError::Handler(format!(
            "invalid transition: {:?} -> {:?}",
            mission.status, req.status
        )));
    }

    let prev_status = mission.status;
    mission.status = req.status;
    mission.version += 1;
    mission.updated_at = chrono::Utc::now().to_rfc3339();

    if matches!(req.status, MissionStatus::Complete | MissionStatus::Cancelled) {
        mission.completed_at = Some(chrono::Utc::now().to_rfc3339());
    }

    save_mission(iii, &mission).await?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "mission.lifecycle",
        "data": {
            "type": "transitioned",
            "missionId": mission.id,
            "from": format!("{prev_status:?}").to_lowercase(),
            "to": format!("{:?}", req.status).to_lowercase(),
            "agentId": req.agent_id,
            "reason": req.reason,
        },
    }));

    Ok(serde_json::to_value(&mission).unwrap())
}

async fn add_comment(iii: &III, req: CommentRequest) -> Result<Value, IIIError> {
    let realm_id = &req.realm_id;
    let id = format!("cmt-{}", uuid::Uuid::new_v4());

    let comment = Comment {
        id: id.clone(),
        mission_id: req.mission_id.clone(),
        author_id: req.author_id,
        body: req.body,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let value = serde_json::to_value(&comment).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": comments_scope(&realm_id, &req.mission_id),
        "key": id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(serde_json::to_value(&comment).unwrap())
}

async fn list_comments(iii: &III, realm_id: &str, mission_id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::list", json!({
        "scope": comments_scope(realm_id, mission_id),
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn list_missions(iii: &III, req: ListMissionsRequest) -> Result<Value, IIIError> {
    let all = iii
        .trigger("state::list", json!({ "scope": scope(&req.realm_id) }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let missions: Vec<Mission> = all
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<Mission>(v.clone()).ok())
                .filter(|m| {
                    let status_ok = req.status.as_ref().map_or(true, |s| &m.status == s);
                    let assignee_ok = req.assignee_id.as_ref().map_or(true, |a| m.assignee_id.as_ref() == Some(a));
                    let dir_ok = req.directive_id.as_ref().map_or(true, |d| m.directive_id.as_ref() == Some(d));
                    status_ok && assignee_ok && dir_ok
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "missions": missions,
        "count": missions.len(),
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default())?;

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::create",
        "Create a new mission",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CreateMissionRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                create_mission(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::checkout",
        "Atomically claim a mission for an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CheckoutRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                checkout_mission(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::release",
        "Release a mission back to the queue",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                let agent_id = input["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                release_mission(&iii, realm_id, id, agent_id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::transition",
        "Transition mission to a new status",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: TransitionRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                transition_mission(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::list",
        "List missions with filtering",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ListMissionsRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                list_missions(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::comment",
        "Add a comment to a mission",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: CommentRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                add_comment(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "mission::comments",
        "List comments on a mission",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let mission_id = input["missionId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing missionId".into()))?;
                list_comments(&iii, realm_id, mission_id).await
            }
        },
    );

    iii.register_trigger("http", "mission::create", json!({ "method": "POST", "path": "/api/missions" }))?;
    iii.register_trigger("http", "mission::checkout", json!({ "method": "POST", "path": "/api/missions/:id/checkout" }))?;
    iii.register_trigger("http", "mission::release", json!({ "method": "POST", "path": "/api/missions/:id/release" }))?;
    iii.register_trigger("http", "mission::transition", json!({ "method": "PATCH", "path": "/api/missions/:id/status" }))?;
    iii.register_trigger("http", "mission::list", json!({ "method": "GET", "path": "/api/missions/:realmId" }))?;
    iii.register_trigger("http", "mission::comment", json!({ "method": "POST", "path": "/api/missions/:id/comments" }))?;
    iii.register_trigger("http", "mission::comments", json!({ "method": "GET", "path": "/api/missions/:realmId/:missionId/comments" }))?;

    tracing::info!("mission worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

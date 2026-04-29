use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

mod types;

use types::{
    Channel, CreateChannelRequest, PinRequest, Post, PostRequest, ReadRequest, ReplyRequest,
    sanitize_id,
};

const MAX_POSTS_PER_CHANNEL: usize = 1000;
const MAX_PINNED: usize = 25;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn fire_and_forget(iii: &III, function_id: &str, payload: Value) {
    let iii = iii.clone();
    let function_id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii
            .trigger(TriggerRequest {
                function_id,
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .filter(|v| !v.is_null())
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map(|_| ())
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn state_list(iii: &III, scope: &str) -> Vec<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

fn entry_value(entry: &Value) -> Value {
    entry.get("value").cloned().unwrap_or_else(|| entry.clone())
}

async fn create_channel(iii: &III, req: CreateChannelRequest) -> Result<Value, IIIError> {
    let name = req
        .name
        .filter(|n| !n.is_empty())
        .ok_or_else(|| IIIError::Handler("name and agentId are required".into()))?;
    let agent_id = req
        .agent_id
        .filter(|a| !a.is_empty())
        .ok_or_else(|| IIIError::Handler("name and agentId are required".into()))?;

    let safe_name = sanitize_id(&name).map_err(IIIError::Handler)?;
    let safe_agent = sanitize_id(&agent_id).map_err(IIIError::Handler)?;

    let channel_id = uuid::Uuid::new_v4().to_string();
    let channel = Channel {
        id: channel_id.clone(),
        name: safe_name.clone(),
        topic: req.topic.unwrap_or_default(),
        created_by: safe_agent,
        created_at: now_ms(),
        pinned: vec![],
    };

    let value = serde_json::to_value(&channel).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "coord_channels", &channel_id, value).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("coord:{channel_id}"),
            "data": { "type": "channel_created", "channelId": channel_id, "name": safe_name },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "channelId": channel_id,
        "name": safe_name,
    }))
}

async fn post(iii: &III, req: PostRequest) -> Result<Value, IIIError> {
    let channel_id = req
        .channel_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId, agentId, and content are required".into()))?;
    let agent_id = req
        .agent_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId, agentId, and content are required".into()))?;
    let content = req
        .content
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId, agentId, and content are required".into()))?;

    let safe_channel_id = sanitize_id(&channel_id).map_err(IIIError::Handler)?;

    if state_get(iii, "coord_channels", &safe_channel_id).await.is_none() {
        return Err(IIIError::Handler("Channel not found".into()));
    }

    let posts_scope = format!("coord_posts:{safe_channel_id}");
    let existing = state_list(iii, &posts_scope).await;
    if existing.len() >= MAX_POSTS_PER_CHANNEL {
        return Err(IIIError::Handler(
            "Channel has reached the post limit".into(),
        ));
    }

    let post_id = uuid::Uuid::new_v4().to_string();
    let safe_agent = sanitize_id(&agent_id).map_err(IIIError::Handler)?;
    let post = Post {
        id: post_id.clone(),
        channel_id: safe_channel_id.clone(),
        agent_id: safe_agent.clone(),
        content,
        parent_id: None,
        created_at: now_ms(),
        metadata: req.metadata.unwrap_or_else(|| json!({})),
    };

    let value = serde_json::to_value(&post).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, &posts_scope, &post_id, value).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("coord:{safe_channel_id}"),
            "data": { "type": "post_created", "postId": post_id, "agentId": safe_agent },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "postId": post_id,
        "channelId": safe_channel_id,
    }))
}

async fn reply(iii: &III, req: ReplyRequest) -> Result<Value, IIIError> {
    let channel_id = req.channel_id.filter(|s| !s.is_empty()).ok_or_else(|| {
        IIIError::Handler("channelId, parentId, agentId, and content are required".into())
    })?;
    let parent_id = req.parent_id.filter(|s| !s.is_empty()).ok_or_else(|| {
        IIIError::Handler("channelId, parentId, agentId, and content are required".into())
    })?;
    let agent_id = req.agent_id.filter(|s| !s.is_empty()).ok_or_else(|| {
        IIIError::Handler("channelId, parentId, agentId, and content are required".into())
    })?;
    let content = req.content.filter(|s| !s.is_empty()).ok_or_else(|| {
        IIIError::Handler("channelId, parentId, agentId, and content are required".into())
    })?;

    let safe_channel_id = sanitize_id(&channel_id).map_err(IIIError::Handler)?;
    let safe_parent_id = sanitize_id(&parent_id).map_err(IIIError::Handler)?;
    let safe_agent = sanitize_id(&agent_id).map_err(IIIError::Handler)?;

    let posts_scope = format!("coord_posts:{safe_channel_id}");
    if state_get(iii, &posts_scope, &safe_parent_id).await.is_none() {
        return Err(IIIError::Handler("Parent post not found".into()));
    }

    let post_id = uuid::Uuid::new_v4().to_string();
    let reply = Post {
        id: post_id.clone(),
        channel_id: safe_channel_id.clone(),
        agent_id: safe_agent.clone(),
        content,
        parent_id: Some(safe_parent_id.clone()),
        created_at: now_ms(),
        metadata: req.metadata.unwrap_or_else(|| json!({})),
    };

    let value = serde_json::to_value(&reply).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, &posts_scope, &post_id, value).await?;

    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": format!("coord:{safe_channel_id}"),
            "data": {
                "type": "reply_created",
                "postId": post_id,
                "parentId": safe_parent_id,
                "agentId": safe_agent,
            },
        }),
    );

    Ok::<Value, IIIError>(json!({
        "postId": post_id,
        "parentId": safe_parent_id,
        "channelId": safe_channel_id,
    }))
}

async fn list_channels(iii: &III) -> Result<Value, IIIError> {
    let raw = state_list(iii, "coord_channels").await;
    let mut channels: Vec<Value> = raw.iter().map(entry_value).collect();
    channels.sort_by(|a, b| {
        let ta = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok::<Value, IIIError>(Value::Array(channels))
}

async fn read(iii: &III, req: ReadRequest) -> Result<Value, IIIError> {
    let channel_id = req
        .channel_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId is required".into()))?;
    let safe_channel_id = sanitize_id(&channel_id).map_err(IIIError::Handler)?;

    let posts_scope = format!("coord_posts:{safe_channel_id}");
    let raw = state_list(iii, &posts_scope).await;

    let mut posts: Vec<Value> = raw.iter().map(entry_value).collect();
    posts.sort_by(|a, b| {
        let ta = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        ta.cmp(&tb)
    });

    if let Some(thread_id) = req.thread_id {
        let safe_thread = sanitize_id(&thread_id).map_err(IIIError::Handler)?;
        posts.retain(|p| {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let parent = p.get("parentId").and_then(|v| v.as_str()).unwrap_or("");
            id == safe_thread || parent == safe_thread
        });
    }

    let cap = req.limit.filter(|&n| n > 0).unwrap_or(100);
    if posts.len() > cap {
        let start = posts.len() - cap;
        posts = posts.split_off(start);
    }

    Ok::<Value, IIIError>(Value::Array(posts))
}

async fn pin(iii: &III, req: PinRequest) -> Result<Value, IIIError> {
    let channel_id = req
        .channel_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId and postId are required".into()))?;
    let post_id = req
        .post_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IIIError::Handler("channelId and postId are required".into()))?;

    let safe_channel_id = sanitize_id(&channel_id).map_err(IIIError::Handler)?;
    let safe_post_id = sanitize_id(&post_id).map_err(IIIError::Handler)?;

    let channel_val = state_get(iii, "coord_channels", &safe_channel_id)
        .await
        .ok_or_else(|| IIIError::Handler("Channel not found".into()))?;
    let mut channel: Channel =
        serde_json::from_value(channel_val).map_err(|e| IIIError::Handler(e.to_string()))?;

    let posts_scope = format!("coord_posts:{safe_channel_id}");
    if state_get(iii, &posts_scope, &safe_post_id).await.is_none() {
        return Err(IIIError::Handler("Post not found".into()));
    }

    let unpin = req.unpin.unwrap_or(false);
    if unpin {
        channel.pinned.retain(|id| id != &safe_post_id);
    } else if !channel.pinned.contains(&safe_post_id) {
        if channel.pinned.len() >= MAX_PINNED {
            return Err(IIIError::Handler(format!(
                "Maximum {MAX_PINNED} pinned posts per channel"
            )));
        }
        channel.pinned.push(safe_post_id.clone());
    } else {
        return Ok::<Value, IIIError>(json!({
            "channelId": safe_channel_id,
            "pinned": channel.pinned,
        }));
    }

    let value = serde_json::to_value(&channel).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "coord_channels", &safe_channel_id, value).await?;

    Ok::<Value, IIIError>(json!({
        "channelId": safe_channel_id,
        "pinned": channel.pinned,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::create_channel", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: CreateChannelRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                create_channel(&iii, req).await
            }
        })
        .description("Create a coordination channel for agent communication"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::post", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: PostRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                post(&iii, req).await
            }
        })
        .description("Post a message to a coordination channel"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::reply", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: ReplyRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                reply(&iii, req).await
            }
        })
        .description("Reply to a post in a coordination channel (threaded)"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::list_channels", move |_: Value| {
            let iii = iii_clone.clone();
            async move { list_channels(&iii).await }
        })
        .description("List all coordination channels"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::read", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input
                    .get("body")
                    .cloned()
                    .or_else(|| input.get("query").cloned())
                    .unwrap_or(input);
                let req: ReadRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                read(&iii, req).await
            }
        })
        .description("Read messages in a coordination channel"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("coord::pin", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input);
                let req: PinRequest =
                    serde_json::from_value(body).map_err(|e| IIIError::Handler(e.to_string()))?;
                pin(&iii, req).await
            }
        })
        .description("Pin or unpin a post in a coordination channel"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::create_channel".to_string(),
        config: json!({ "api_path": "api/coord/channel", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::post".to_string(),
        config: json!({ "api_path": "api/coord/:channelId/post", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::reply".to_string(),
        config: json!({ "api_path": "api/coord/:channelId/reply", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::list_channels".to_string(),
        config: json!({ "api_path": "api/coord/channels", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::read".to_string(),
        config: json!({ "api_path": "api/coord/:channelId", "http_method": "GET" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "coord::pin".to_string(),
        config: json!({ "api_path": "api/coord/:channelId/pin", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("coordination worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

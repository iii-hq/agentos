use iii_sdk::error::IIIError;
use iii_sdk::{
    III, InitOptions, RegisterFunction, RegisterTriggerInput, Trigger, TriggerRequest,
    register_worker,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{Mutex, RwLock};

mod types;

use types::{Hand, HandFile};

type HandRegistry = Arc<RwLock<HashMap<String, Hand>>>;

struct CronEntry {
    schedule: String,
    trigger: Trigger,
}

type CronRegistry = Arc<Mutex<HashMap<String, CronEntry>>>;

fn hands_dir() -> PathBuf {
    std::env::var("HANDS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./hands"))
}

fn load_hands_from_dir(dir: &Path) -> anyhow::Result<HashMap<String, Hand>> {
    let mut out = HashMap::new();
    if !dir.exists() {
        tracing::warn!(dir = %dir.display(), "hands directory does not exist");
        return Ok(out);
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let toml_path = path.join("HAND.toml");
        if !toml_path.is_file() {
            continue;
        }
        match std::fs::read_to_string(&toml_path) {
            Ok(raw) => match toml::from_str::<HandFile>(&raw) {
                Ok(parsed) => {
                    let id = parsed.hand.id.clone();
                    if out.contains_key(&id) {
                        return Err(anyhow::anyhow!(
                            "duplicate hand id `{}` in {}",
                            id,
                            toml_path.display()
                        ));
                    }
                    tracing::info!(id = %id, "loaded hand");
                    out.insert(id, parsed.hand);
                }
                Err(e) => {
                    tracing::error!(path = %toml_path.display(), error = %e, "failed to parse HAND.toml");
                }
            },
            Err(e) => {
                tracing::error!(path = %toml_path.display(), error = %e, "failed to read HAND.toml");
            }
        }
    }
    Ok(out)
}

fn build_kickoff_prompt(hand: &Hand) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let functions = hand.functions.allowed.join(", ");
    let settings_lines = hand
        .settings
        .iter()
        .map(|s| format!("Setting {}: {} (default {})", s.key, s.setting_type, s.default))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[{} — Autonomous Run — {}]\n\nReview your current task queue and execute pending work.\nAvailable functions: {}\n\n{}",
        hand.name, now, functions, settings_lines,
    )
}

async fn run_hand(iii: &III, hand: Hand) -> Result<Value, IIIError> {
    let started = Instant::now();
    let started_at = chrono::Utc::now().to_rfc3339();
    let kickoff = build_kickoff_prompt(&hand);
    let timeout_ms = hand.agent.max_iterations.map(|n| n.saturating_mul(5000));

    let chat_result = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": hand.id,
                "message": kickoff,
                "functions": hand.functions.allowed,
                "systemPrompt": hand.agent.system_prompt,
                "temperature": hand.agent.temperature,
                "maxIterations": hand.agent.max_iterations,
                "model": hand.agent.model,
            }),
            action: None,
            timeout_ms,
        })
        .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let (status, error, response) = match chat_result {
        Ok(v) => ("completed", None, Some(v)),
        Err(e) => ("failed", Some(e.to_string()), None),
    };

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "council::activity".to_string(),
            payload: json!({
                "realmId": "default",
                "actorKind": "system",
                "actorId": "hand-runner",
                "action": format!("hand_run_{status}"),
                "entityType": "hand",
                "entityId": hand.id,
                "details": {
                    "status": status,
                    "durationMs": duration_ms,
                    "startedAt": started_at,
                    "error": error,
                    "schedule": hand.schedule,
                },
            }),
            action: None,
            timeout_ms: None,
        })
        .await;

    Ok(json!({
        "handId": hand.id,
        "status": status,
        "durationMs": duration_ms,
        "startedAt": started_at,
        "error": error,
        "response": response,
    }))
}

fn register_hand_function(iii: &III, hand_id: String, registry: HandRegistry) {
    let iii_for_handler = iii.clone();
    iii.register_function(
        RegisterFunction::new_async(format!("hand::run::{hand_id}"), move |_input: Value| {
            let iii = iii_for_handler.clone();
            let registry = registry.clone();
            let id = hand_id.clone();
            async move {
                let hand = {
                    let guard = registry.read().await;
                    guard.get(&id).cloned()
                };
                let hand = hand
                    .ok_or_else(|| IIIError::Handler(format!("hand {id} not loaded")))?;
                run_hand(&iii, hand).await
            }
        })
        .description("Run one hand by id (cron-triggered)"),
    );
}

fn register_cron_for_hand(iii: &III, hand: &Hand) -> Result<Option<Trigger>, IIIError> {
    if hand.schedule.trim().is_empty() {
        tracing::warn!(id = %hand.id, "skipping cron registration: empty schedule");
        return Ok(None);
    }
    let trigger = iii.register_trigger(RegisterTriggerInput {
        trigger_type: "cron".into(),
        function_id: format!("hand::run::{}", hand.id),
        config: json!({ "schedule": hand.schedule }),
        metadata: None,
    })?;
    Ok(Some(trigger))
}

async fn reconcile_cron(
    iii: &III,
    crons: &CronRegistry,
    next: &HashMap<String, Hand>,
) {
    let mut guard = crons.lock().await;

    let stale: Vec<String> = guard
        .iter()
        .filter(|(id, entry)| match next.get(*id) {
            None => true,
            Some(hand) => !hand.enabled || entry.schedule != hand.schedule,
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        if let Some(entry) = guard.remove(&id) {
            entry.trigger.unregister();
            tracing::info!(id = %id, "unregistered stale cron");
        }
    }

    for (id, hand) in next.iter().filter(|(_, h)| h.enabled) {
        if guard.contains_key(id) {
            continue;
        }
        match register_cron_for_hand(iii, hand) {
            Ok(Some(trigger)) => {
                guard.insert(
                    id.clone(),
                    CronEntry {
                        schedule: hand.schedule.clone(),
                        trigger,
                    },
                );
            }
            Ok(None) => {}
            Err(e) => {
                tracing::error!(id = %id, error = %e, "failed to register cron");
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let dir = hands_dir();
    tracing::info!(dir = %dir.display(), "loading hands");
    let initial = load_hands_from_dir(&dir)?;
    let registry: HandRegistry = Arc::new(RwLock::new(initial.clone()));
    let crons: CronRegistry = Arc::new(Mutex::new(HashMap::new()));

    for (id, _) in initial.iter() {
        register_hand_function(&iii, id.clone(), registry.clone());
    }
    reconcile_cron(&iii, &crons, &initial).await;

    let registry_clone = registry.clone();
    iii.register_function(
        RegisterFunction::new_async("hand::list", move |_input: Value| {
            let registry = registry_clone.clone();
            async move {
                let guard = registry.read().await;
                let hands: Vec<&Hand> = guard.values().collect();
                serde_json::to_value(&hands).map_err(|e| IIIError::Handler(e.to_string()))
            }
        })
        .description("List all loaded hands"),
    );

    let registry_clone = registry.clone();
    iii.register_function(
        RegisterFunction::new_async("hand::get", move |input: Value| {
            let registry = registry_clone.clone();
            async move {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                let guard = registry.read().await;
                let hand = guard
                    .get(id)
                    .ok_or_else(|| IIIError::Handler(format!("hand {id} not found")))?;
                serde_json::to_value(hand).map_err(|e| IIIError::Handler(e.to_string()))
            }
        })
        .description("Get one hand by id"),
    );

    let iii_clone = iii.clone();
    let registry_clone = registry.clone();
    let crons_clone = crons.clone();
    iii.register_function(
        RegisterFunction::new_async("hand::reload", move |_input: Value| {
            let iii = iii_clone.clone();
            let registry = registry_clone.clone();
            let crons = crons_clone.clone();
            async move {
                let dir = hands_dir();
                let next = load_hands_from_dir(&dir)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                let added: Vec<String> = {
                    let guard = registry.read().await;
                    next.keys()
                        .filter(|id| !guard.contains_key(*id))
                        .cloned()
                        .collect()
                };
                {
                    let mut guard = registry.write().await;
                    *guard = next.clone();
                }
                for id in &added {
                    register_hand_function(&iii, id.clone(), registry.clone());
                }
                reconcile_cron(&iii, &crons, &next).await;
                Ok::<Value, IIIError>(json!({
                    "loaded": next.len(),
                    "addedFunctions": added,
                }))
            }
        })
        .description("Re-walk the hands directory and re-register triggers"),
    );

    let iii_clone = iii.clone();
    let registry_clone = registry.clone();
    iii.register_function(
        RegisterFunction::new_async("hand::trigger", move |input: Value| {
            let iii = iii_clone.clone();
            let registry = registry_clone.clone();
            async move {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing id".into()))?;
                let hand = {
                    let guard = registry.read().await;
                    guard.get(id).cloned()
                };
                let hand = hand
                    .ok_or_else(|| IIIError::Handler(format!("hand {id} not found")))?;
                run_hand(&iii, hand).await
            }
        })
        .description("Manually invoke a hand by id"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "hand::list".into(),
        config: json!({ "method": "GET", "path": "/api/hands" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "hand::get".into(),
        config: json!({ "method": "GET", "path": "/api/hands/:id" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "hand::reload".into(),
        config: json!({ "method": "POST", "path": "/api/hands/reload" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".into(),
        function_id: "hand::trigger".into(),
        config: json!({ "method": "POST", "path": "/api/hands/:id/trigger" }),
        metadata: None,
    })?;

    tracing::info!(count = initial.len(), "hand-runner worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_hand(dir: &Path, id: &str, raw: &str) {
        let sub = dir.join(id);
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("HAND.toml"), raw).unwrap();
    }

    #[tokio::test]
    async fn loads_multiple_hands_from_dir() {
        let tmp = tempdir();
        write_hand(
            &tmp,
            "alpha",
            r#"
[hand]
id = "alpha"
name = "Alpha"
enabled = true
schedule = "* * * * *"

[hand.functions]
allowed = ["fn::a"]

[hand.agent]
max_iterations = 5
temperature = 0.1
system_prompt = "do alpha"
"#,
        );
        write_hand(
            &tmp,
            "beta",
            r#"
[hand]
id = "beta"
name = "Beta"
enabled = false
schedule = "0 * * * *"
"#,
        );

        let loaded = load_hands_from_dir(&tmp).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains_key("alpha"));
        assert!(loaded.contains_key("beta"));
        assert!(!loaded["beta"].enabled);
    }

    #[tokio::test]
    async fn skips_dirs_without_hand_toml() {
        let tmp = tempdir();
        std::fs::create_dir_all(tmp.join("not-a-hand")).unwrap();
        write_hand(&tmp, "real", r#"
[hand]
id = "real"
name = "Real"
"#);
        let loaded = load_hands_from_dir(&tmp).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("real"));
    }

    #[tokio::test]
    async fn missing_dir_returns_empty() {
        let dir = std::env::temp_dir().join(format!("hand-runner-missing-{}", std::process::id()));
        let loaded = load_hands_from_dir(&dir).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn kickoff_prompt_contains_name_and_functions() {
        let hand = Hand {
            id: "x".into(),
            name: "Watcher".into(),
            description: String::new(),
            enabled: true,
            schedule: "* * * * *".into(),
            functions: types::HandFunctions {
                allowed: vec!["fn::shell_exec".into(), "fn::web_fetch".into()],
            },
            settings: vec![types::HandSetting {
                key: "target".into(),
                setting_type: "select".into(),
                default: "prod".into(),
                options: vec!["dev".into(), "prod".into()],
            }],
            agent: types::HandAgent::default(),
            dashboard: None,
        };
        let prompt = build_kickoff_prompt(&hand);
        assert!(prompt.contains("Watcher"));
        assert!(prompt.contains("fn::shell_exec"));
        assert!(prompt.contains("target"));
    }

    fn tempdir() -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hand-runner-test-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

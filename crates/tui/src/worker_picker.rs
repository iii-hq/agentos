use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerCard {
    pub name: String,
    pub description: String,
    pub functions: Vec<String>,
    pub installed: bool,
    pub binary_path: Option<String>,
}

#[allow(dead_code)]
pub fn parse_catalog(api_response: &Value, installed: &[String]) -> Vec<WorkerCard> {
    let arr = match api_response.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let installed_set: std::collections::HashSet<&str> =
        installed.iter().map(|s| s.as_str()).collect();
    arr.iter()
        .filter_map(|v| {
            let name = v.get("name").and_then(|s| s.as_str())?.to_string();
            let description = v
                .get("description")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let functions: Vec<String> = v
                .get("functions")
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let installed = installed_set.contains(name.as_str());
            Some(WorkerCard {
                name,
                description,
                functions,
                installed,
                binary_path: v
                    .get("binary_path")
                    .and_then(|s| s.as_str())
                    .map(String::from),
            })
        })
        .collect()
}

pub fn builtin_catalog() -> Vec<WorkerCard> {
    const ENTRIES: &[(&str, &str, &[&str])] = &[
        ("memory", "Persistent recall, durable session memory", &["memory::remember", "memory::recall", "memory::search"]),
        ("browser", "Headless browser automation", &["browser::navigate", "browser::click", "browser::read"]),
        ("llm-router", "LLM provider routing + retries", &["llm::route"]),
        ("agent-core", "Agent lifecycle + chat orchestration", &["agent::chat", "agent::create"]),
        ("approval", "Permission gating for sensitive ops", &["approval::decide", "approval::pending"]),
        ("council", "Multi-agent governance + voting", &["council::propose", "council::decide"]),
        ("realm", "Multi-tenant agent contexts", &["realm::create", "realm::list"]),
        ("evolve", "Function lineage + version evolution", &["evolve::propose", "evolve::lineage"]),
        ("workflow", "YAML-defined multi-step automations", &["workflow::run", "workflow::list"]),
        ("orchestrator", "Cross-agent task coordination", &["orchestrator::status"]),
        ("task-decomposer", "Break complex tasks into subtasks", &["task::spawn", "task::status"]),
        ("hashline", "Structured logging + audit trail", &["audit::log"]),
        ("hooks", "Pre/post tool-call hooks", &["hooks::register"]),
        ("vault", "Encrypted secret storage", &["vault::get", "vault::set"]),
        ("rate-limiter", "Per-tenant request throttling", &["rate::check"]),
        ("mcp-client", "Model Context Protocol bridge", &["mcp::list", "mcp::tools"]),
        ("skillkit-bridge", "External skill registry sync", &["skill::list", "skill::run"]),
        ("hand-runner", "Persona-bundled function dispatch", &["hand::list", "hand::run"]),
        ("a2a-cards", "Agent-to-agent capability cards", &["a2a::send", "a2a::cards"]),
        ("a2a", "Agent-to-agent transport", &["a2a::handle_task", "a2a::get_task"]),
        ("bridge", "External runtime invocation", &["bridge::invoke"]),
        ("channel-slack", "Slack channel I/O", &["channel::slack::send"]),
        ("channel-discord", "Discord channel I/O", &["channel::discord::send"]),
        ("channel-email", "Email send/receive", &["channel::email::send"]),
        ("channel-bluesky", "Bluesky channel I/O", &["channel::bluesky::send"]),
        ("channel-mastodon", "Mastodon channel I/O", &["channel::mastodon::send"]),
        ("channel-matrix", "Matrix channel I/O", &["channel::matrix::send"]),
        ("channel-reddit", "Reddit channel I/O", &["channel::reddit::send"]),
        ("channel-signal", "Signal channel I/O", &["channel::signal::send"]),
        ("channel-teams", "Teams channel I/O", &["channel::teams::send"]),
        ("channel-telegram", "Telegram channel I/O", &["channel::telegram::send"]),
        ("channel-twitch", "Twitch channel I/O", &["channel::twitch::send"]),
        ("channel-webex", "Webex channel I/O", &["channel::webex::send"]),
        ("channel-whatsapp", "WhatsApp channel I/O", &["channel::whatsapp::send"]),
        ("channel-linkedin", "LinkedIn channel I/O", &["channel::linkedin::send"]),
        ("security", "RBAC + taint tracking + signing", &["security::check"]),
        ("wasm-sandbox", "Sandboxed wasm function exec", &["wasm::run"]),
        ("ledger", "Immutable action ledger", &["ledger::record"]),
        ("session-replay", "Time-travel debugging", &["replay::load"]),
        ("session-lifecycle", "Session start/end hooks", &["lifecycle::state"]),
        ("context-manager", "Context window budget control", &["context::build", "context::trim"]),
        ("context-cache", "LLM response caching", &["context-cache::fetch"]),
        ("telemetry", "Engine + worker observability", &["metrics::summary"]),
        ("mission", "Long-running mission tracking", &["mission::list"]),
        ("directive", "Realm-level operating rules", &["directive::create"]),
        ("hierarchy", "Agent reporting structure", &["hierarchy::tree"]),
        ("loop-guard", "Detect runaway agent loops", &["loop::check"]),
        ("pulse", "Agent heartbeat + presence", &["pulse::ping"]),
        ("feedback", "User feedback collection", &["feedback::record"]),
        ("eval", "Function evaluation history", &["eval::history"]),
        ("coordination", "Channel-based coord", &["coord::post"]),
        ("swarm", "Multi-agent swarm runs", &["swarm::start"]),
        ("code-agent", "Code generation agent", &["code::run"]),
        ("lsp-tools", "Language server primitives", &["lsp::definition"]),
        ("approval-tiers", "Tiered approval policies", &["approval-tiers::policy"]),
        ("security-headers", "HTTP header policy", &["security-headers::check"]),
        ("security-map", "Capability map", &["security-map::query"]),
        ("security-zeroize", "Memory zeroization", &["security-zeroize::wipe"]),
        ("skill-security", "Skill permission gating", &["skill-security::check"]),
        ("context-monitor", "Context-window watchdog", &["context-monitor::watch"]),
        ("cron", "Scheduled triggers", &["cron::register"]),
        ("streaming", "SSE chat streaming", &["stream::chat"]),
        ("embedding", "Vector embeddings (Python)", &["embedding::embed"]),
    ];
    ENTRIES.iter().map(|(name, desc, fns)| WorkerCard {
        name: (*name).into(),
        description: (*desc).into(),
        functions: fns.iter().map(|s| (*s).into()).collect(),
        installed: false,
        binary_path: None,
    }).collect()
}

pub fn install_command(card: &WorkerCard) -> String {
    if card.installed {
        format!(
            "$ {}",
            card.binary_path.clone().unwrap_or_else(|| format!("./target/release/{}", card.name))
        )
    } else {
        format!(
            "$ cargo build --release -p {} && ./target/release/{}",
            card.name, card.name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_card() {
        let v: Value = serde_json::from_str(
            r#"[{"name":"memory","description":"persistent recall","functions":["memory::store","memory::recall"]}]"#,
        )
        .unwrap();
        let cards = parse_catalog(&v, &[]);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "memory");
        assert_eq!(cards[0].functions.len(), 2);
        assert!(!cards[0].installed);
    }

    #[test]
    fn marks_installed() {
        let v: Value = serde_json::from_str(r#"[{"name":"browser"}]"#).unwrap();
        let cards = parse_catalog(&v, &["browser".to_string()]);
        assert!(cards[0].installed);
    }

    #[test]
    fn install_cmd_for_uninstalled() {
        let card = WorkerCard {
            name: "memory".into(),
            description: "".into(),
            functions: vec![],
            installed: false,
            binary_path: None,
        };
        let cmd = install_command(&card);
        assert!(cmd.contains("cargo build"));
        assert!(cmd.contains("memory"));
    }

    #[test]
    fn install_cmd_for_installed_uses_binary() {
        let card = WorkerCard {
            name: "memory".into(),
            description: "".into(),
            functions: vec![],
            installed: true,
            binary_path: Some("/opt/memory".into()),
        };
        assert_eq!(install_command(&card), "$ /opt/memory");
    }
}

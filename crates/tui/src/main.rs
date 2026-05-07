mod first_run;
mod help_overlay;
mod markdown;
mod palette;
mod slash;
mod sse;
mod status;
mod theme;
mod worker_picker;

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    prelude::*,
    widgets::*,
};
use serde_json::Value;
use std::io::stdout;

use crate::palette::PaletteItem;

const API_BASE: &str = "http://localhost:3111";
const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS: u64 = 80;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Screen {
    Dashboard,
    Agents,
    Chat,
    Channels,
    Skills,
    Hands,
    Workflows,
    Sessions,
    Approvals,
    Logs,
    Memory,
    Audit,
    Security,
    Peers,
    Extensions,
    Triggers,
    Templates,
    Usage,
    Settings,
    Wizard,
    WorkflowBuilder,
    Lifecycle,
    Tasks,
    Recovery,
    Orchestrator,
}

impl Screen {
    fn all() -> &'static [Screen] {
        &[
            Screen::Dashboard, Screen::Agents, Screen::Chat, Screen::Channels,
            Screen::Skills, Screen::Hands, Screen::Workflows, Screen::Sessions,
            Screen::Approvals, Screen::Logs, Screen::Memory, Screen::Audit,
            Screen::Security, Screen::Peers, Screen::Extensions, Screen::Triggers,
            Screen::Templates, Screen::Usage, Screen::Settings,
            Screen::Wizard, Screen::WorkflowBuilder,
            Screen::Lifecycle, Screen::Tasks, Screen::Recovery, Screen::Orchestrator,
        ]
    }

    fn label(&self) -> &str {
        match self {
            Screen::Dashboard => "Dashboard",
            Screen::Agents => "Agents",
            Screen::Chat => "Chat",
            Screen::Channels => "Channels",
            Screen::Skills => "Skills",
            Screen::Hands => "Hands",
            Screen::Workflows => "Workflows",
            Screen::Sessions => "Sessions",
            Screen::Approvals => "Approvals",
            Screen::Logs => "Logs",
            Screen::Memory => "Memory",
            Screen::Audit => "Audit",
            Screen::Security => "Security",
            Screen::Peers => "Peers",
            Screen::Extensions => "Extensions",
            Screen::Triggers => "Triggers",
            Screen::Templates => "Templates",
            Screen::Usage => "Usage",
            Screen::Settings => "Settings",
            Screen::Wizard => "Wizard",
            Screen::WorkflowBuilder => "Wf Builder",
            Screen::Lifecycle => "Lifecycle",
            Screen::Tasks => "Tasks",
            Screen::Recovery => "Recovery",
            Screen::Orchestrator => "Orchestrator",
        }
    }

    fn key(&self) -> &str {
        match self {
            Screen::Dashboard => "1",
            Screen::Agents => "2",
            Screen::Chat => "3",
            Screen::Channels => "4",
            Screen::Skills => "5",
            Screen::Hands => "6",
            Screen::Workflows => "7",
            Screen::Sessions => "8",
            Screen::Approvals => "9",
            Screen::Logs => "0",
            Screen::Memory => "m",
            Screen::Audit => "a",
            Screen::Security => "s",
            Screen::Peers => "p",
            Screen::Extensions => "e",
            Screen::Triggers => "t",
            Screen::Templates => "T",
            Screen::Usage => "u",
            Screen::Settings => "S",
            Screen::Wizard => "w",
            Screen::WorkflowBuilder => "W",
            Screen::Lifecycle => "L",
            Screen::Tasks => "K",
            Screen::Recovery => "R",
            Screen::Orchestrator => "O",
        }
    }

    #[cfg(test)]
    fn is_text_input(&self) -> bool {
        matches!(self, Screen::Chat | Screen::Wizard)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum VimMode {
    Normal,
    Insert,
}

struct App {
    screen: Screen,
    selected: usize,
    status: String,
    healthy: bool,
    agents: Vec<Value>,
    skills: Vec<Value>,
    logs: Vec<Value>,
    chat_input: String,
    chat_agent: String,
    chat_messages: Vec<(String, String)>,
    channels: Vec<Value>,
    hands: Vec<Value>,
    workflows: Vec<Value>,
    sessions: Vec<Value>,
    approvals: Vec<Value>,
    memories: Vec<Value>,
    audit_entries: Vec<Value>,
    security_caps: Value,
    peers: Vec<Value>,
    extensions: Vec<Value>,
    triggers: Vec<Value>,
    templates: Vec<Value>,
    usage_data: Value,
    settings: Vec<(String, String)>,
    scroll_offset: u16,
    wizard_step: usize,
    wizard_values: Vec<String>,
    wf_builder_steps: Vec<String>,
    running: bool,
    last_error: Option<String>,
    dashboard_stats: Value,
    spinner_frame: usize,
    spinner_active: bool,
    spinner_verb: String,
    streaming_tokens: usize,
    streaming_start: Option<std::time::Instant>,
    chat_streaming: bool,
    vim_mode: VimMode,
    vim_command_buffer: String,
    task_tree: Vec<Value>,
    task_expanded: std::collections::HashSet<String>,
    lifecycle_states: Vec<Value>,
    recovery_report: Value,
    orchestrator_plans: Vec<Value>,
    pending_approval: Option<Value>,
    approval_mode: bool,
    pending_chord: Option<char>,
    chord_timeout: Option<std::time::Instant>,
    show_help: bool,
    show_palette: bool,
    show_worker_picker: bool,
    show_first_run: bool,
    palette_query: String,
    palette_selected: usize,
    slash_completions: Vec<(String, String)>,
    slash_selected: usize,
    registry_fns: Vec<String>,
    chat_realm: String,
    worker_count: usize,
    worker_catalog: Vec<worker_picker::WorkerCard>,
    worker_picker_selected: usize,
}

impl App {
    fn new() -> Self {
        Self {
            screen: Screen::Chat,
            selected: 0,
            status: "Connecting...".into(),
            healthy: false,
            agents: vec![],
            skills: vec![],
            logs: vec![],
            chat_input: String::new(),
            chat_agent: String::new(),
            chat_messages: vec![],
            channels: vec![],
            hands: vec![],
            workflows: vec![],
            sessions: vec![],
            approvals: vec![],
            memories: vec![],
            audit_entries: vec![],
            security_caps: Value::Null,
            peers: vec![],
            extensions: vec![],
            triggers: vec![],
            templates: vec![],
            usage_data: Value::Null,
            settings: vec![],
            scroll_offset: 0,
            wizard_step: 0,
            wizard_values: vec![String::new(); 6],
            wf_builder_steps: vec![],
            running: true,
            last_error: None,
            dashboard_stats: Value::Null,
            spinner_frame: 0,
            spinner_active: false,
            spinner_verb: String::new(),
            streaming_tokens: 0,
            streaming_start: None,
            chat_streaming: false,
            vim_mode: VimMode::Insert,
            vim_command_buffer: String::new(),
            task_tree: vec![],
            task_expanded: std::collections::HashSet::new(),
            lifecycle_states: vec![],
            recovery_report: Value::Null,
            orchestrator_plans: vec![],
            pending_approval: None,
            approval_mode: false,
            pending_chord: None,
            chord_timeout: None,
            show_help: false,
            show_palette: false,
            show_worker_picker: false,
            show_first_run: true,
            palette_query: String::new(),
            palette_selected: 0,
            slash_completions: vec![],
            slash_selected: 0,
            registry_fns: vec![],
            chat_realm: "default".into(),
            worker_count: 0,
            worker_catalog: vec![],
            worker_picker_selected: 0,
        }
    }

    fn refresh_slash_completions(&mut self) {
        if self.chat_input.starts_with('/') {
            let body = &self.chat_input[1..];
            let partial = body.split_whitespace().next().unwrap_or("");
            self.slash_completions = slash::complete(partial, &self.registry_fns);
            if self.slash_selected >= self.slash_completions.len() {
                self.slash_selected = 0;
            }
        } else {
            self.slash_completions.clear();
            self.slash_selected = 0;
        }
    }

    async fn refresh_registry(&mut self) {
        let client = Self::client();
        if let Ok(resp) = client.get(format!("{}/api/metrics/summary", API_BASE)).send().await
            && let Ok(data) = resp.json::<Value>().await
        {
            self.worker_count = data["workers"].as_u64()
                .or_else(|| data["worker_count"].as_u64())
                .unwrap_or(0) as usize;
        }
        self.registry_fns = slash::BUILTIN_REGISTRY_FNS
            .iter()
            .map(|s| s.to_string())
            .collect();
    }

    async fn refresh_worker_catalog(&mut self) {
        self.worker_catalog = worker_picker::builtin_catalog();
    }

    fn palette_items(&self) -> Vec<PaletteItem> {
        Screen::all()
            .iter()
            .map(|s| PaletteItem {
                label: s.label().to_string(),
                hint: format!("Switch to {}", s.label()),
                action_key: s.key().to_string(),
            })
            .collect()
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    }

    async fn refresh_health(&mut self) {
        let client = Self::client();
        match client.get(format!("{}/api/realms", API_BASE)).send().await {
            Ok(resp) if resp.status().is_success() => {
                self.healthy = true;
                self.last_error = None;
                self.dashboard_stats = resp.json::<Value>().await.unwrap_or(Value::Null);
                self.worker_count = self.worker_count.max(1);
                self.status = "● engine ready".into();
            }
            Ok(_) => {
                self.healthy = true;
                self.worker_count = 0;
                self.status = "◐ engine up · no workers".into();
                self.last_error = Some("Engine is reachable but realm worker is not running. Run: bash scripts/dev-up.sh".into());
            }
            Err(e) => {
                self.healthy = false;
                self.worker_count = 0;
                self.status = "○ Engine offline".into();
                self.last_error = Some(format!("Connection failed: {}", e));
            }
        }
    }

    async fn refresh_screen(&mut self) {
        let client = Self::client();
        match self.screen {
            Screen::Dashboard => self.refresh_health().await,
            Screen::Agents => {
                if let Ok(resp) = client.get(format!("{}/api/dashboard/stats", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    if let Some(arr) = data["agentList"].as_array() {
                        self.agents = arr.clone();
                    }
                }
            }
            Screen::Skills => {
                if let Ok(resp) = client.get(format!("{}/api/dashboard/stats", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    if let Some(arr) = data["skillList"].as_array() {
                        self.skills = arr.clone();
                    }
                }
            }
            Screen::Channels => {
                if let Ok(resp) = client.get(format!("{}/api/coord/channels", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.channels = data["channels"].as_array().cloned()
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            Screen::Hands => {
                if let Ok(resp) = client.get(format!("{}/api/hands", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.hands = data.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Workflows => {
                if let Ok(resp) = client.get(format!("{}/api/workflows", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.workflows = data.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Sessions => {
                if let Ok(resp) = client.get(format!("{}/api/sessions", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.sessions = data.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Approvals => {
                if let Ok(resp) = client.get(format!("{}/api/approvals/pending", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.approvals = data["pending"].as_array().cloned()
                        .or_else(|| data["approvals"].as_array().cloned())
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            Screen::Logs => {
                if let Ok(resp) = client.get(format!("{}/api/dashboard/logs", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.logs = data["logs"].as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Memory => {
                if let Ok(resp) = client.get(format!("{}/agentmemory/memories", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.memories = data["memories"].as_array().cloned()
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            Screen::Audit => {
                if let Ok(resp) = client.get(format!("{}/api/dashboard/events", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.audit_entries = data["events"].as_array().cloned()
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            Screen::Security => {
                if let Ok(resp) = client.get(format!("{}/api/security", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.security_caps = data;
                }
            }
            Screen::Peers => {
                if let Ok(resp) = client.get(format!("{}/api/a2a/peers", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.peers = data.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Extensions => {
                if let Ok(resp) = client.get(format!("{}/api/mcp/connections", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.extensions = data["connections"].as_array().cloned()
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            Screen::Triggers => {
                if let Ok(resp) = client.get(format!("{}/api/triggers", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.triggers = data.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Templates => {
                if let Ok(resp) = client.get(format!("{}/api/templates", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.templates = data.as_array().cloned().unwrap_or_default();
                } else {
                    self.templates = default_templates();
                }
            }
            Screen::Usage => {
                if let Ok(resp) = client.get(format!("{}/api/metrics/summary", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.usage_data = data;
                }
            }
            Screen::Settings => {
                if let Ok(resp) = client.get(format!("{}/api/settings", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    if let Some(obj) = data.as_object() {
                        self.settings = obj.iter()
                            .map(|(k, v)| (k.clone(), v.to_string().trim_matches('"').to_string()))
                            .collect();
                    }
                } else if let Ok(content) = std::fs::read_to_string("config.yaml") {
                    self.settings = content.lines()
                        .filter(|l| l.contains(':') && !l.trim().starts_with('#'))
                        .filter_map(|l| {
                            let parts: Vec<&str> = l.splitn(2, ':').collect();
                            if parts.len() == 2 {
                                Some((parts[0].trim().to_string(), parts[1].trim().trim_matches('"').to_string()))
                            } else {
                                None
                            }
                        })
                        .collect();
                }
            }
            Screen::Lifecycle => {
                let agent_ids: Vec<String> = self.agents.iter()
                    .filter_map(|a| a["id"].as_str().or(a["name"].as_str()).map(String::from))
                    .collect();
                let futures: Vec<_> = agent_ids.iter().map(|agent_id| {
                    let c = client.clone();
                    let id = agent_id.clone();
                    async move {
                        let resp = c.get(format!("{}/api/lifecycle/state/{}", API_BASE, id)).send().await.ok()?;
                        let mut data: Value = resp.json().await.ok()?;
                        let obj = data.as_object_mut()?;
                        if !obj.contains_key("agentId") {
                            obj.insert("agentId".into(), Value::String(id));
                        }
                        if !obj.contains_key("previous") {
                            obj.insert("previous".into(), obj.get("previousState").cloned().unwrap_or(Value::String("-".into())));
                        }
                        if !obj.contains_key("reason") {
                            obj.insert("reason".into(), Value::String("-".into()));
                        }
                        if !obj.contains_key("since") {
                            let ts = obj.get("transitionedAt").and_then(|v| v.as_u64());
                            let since_str = ts.map(|t| {
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                format!("{}s ago", now_ms.saturating_sub(t) / 1000)
                            }).unwrap_or_else(|| "-".into());
                            obj.insert("since".into(), Value::String(since_str));
                        }
                        Some(data)
                    }
                }).collect();
                self.lifecycle_states = futures_util::future::join_all(futures).await.into_iter().flatten().collect();
            }
            Screen::Tasks => {
                if let Ok(resp) = client.post(format!("{}/api/orchestrator/status", API_BASE))
                    .json(&serde_json::json!({}))
                    .send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    if let Some(plans) = data["plans"].as_array() {
                        let mut all_tasks = vec![];
                        for plan in plans {
                            if let Some(root_id) = plan["rootTaskId"].as_str().or(plan["rootId"].as_str()) {
                                if let Ok(task_resp) = client.post(format!("{}/api/tasks/list", API_BASE))
                                    .json(&serde_json::json!({ "rootId": root_id }))
                                    .send().await
                                    && let Ok(task_data) = task_resp.json::<Value>().await
                                {
                                    if let Some(tasks) = task_data["tasks"].as_array() {
                                        all_tasks.extend(tasks.clone());
                                    }
                                }
                            }
                        }
                        self.task_tree = all_tasks;
                    }
                }
            }
            Screen::Recovery => {
                if let Ok(resp) = client.post(format!("{}/api/recovery/report", API_BASE))
                    .json(&serde_json::json!({}))
                    .send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.recovery_report = data;
                }
            }
            Screen::Orchestrator => {
                if let Ok(resp) = client.post(format!("{}/api/orchestrator/status", API_BASE))
                    .json(&serde_json::json!({}))
                    .send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.orchestrator_plans = data["plans"].as_array().cloned()
                        .or_else(|| data.as_array().cloned())
                        .unwrap_or_default();
                }
            }
            _ => {}
        }
    }

    async fn handle_slash(&mut self, parsed: slash::Parsed) {
        let (name, args) = match parsed {
            slash::Parsed::Cmd { name, args } => (name, args),
            slash::Parsed::Incomplete { partial } => {
                self.chat_messages
                    .push(("system".into(), format!("Incomplete command: /{}", partial)));
                return;
            }
            slash::Parsed::Plain(_) => return,
        };
        match name.as_str() {
            "agent" => {
                if args.is_empty() {
                    self.chat_messages.push(("system".into(), format!("agent: {}", self.chat_agent)));
                } else {
                    self.chat_agent = args.clone();
                    self.chat_messages.push(("system".into(), format!("Switched to agent {}", args)));
                }
            }
            "realm" => {
                self.chat_realm = args.clone();
                self.chat_messages.push(("system".into(), format!("Realm: {}", args)));
            }
            "memory" => {
                let client = Self::client();
                let body = serde_json::json!({
                    "query": args,
                    "userId": self.chat_realm,
                    "limit": 10,
                });
                match client.post(format!("{}/agentmemory/search", API_BASE)).json(&body).send().await {
                    Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
                        Ok(v) => {
                            let display = v["memories"].as_array()
                                .or_else(|| v["results"].as_array())
                                .map(|arr| {
                                    arr.iter().take(5)
                                        .filter_map(|m| m["content"].as_str().or_else(|| m["text"].as_str()))
                                        .collect::<Vec<_>>()
                                        .join("\n  • ")
                                })
                                .filter(|s| !s.is_empty())
                                .map(|s| format!("Memories:\n  • {}", s))
                                .unwrap_or_else(|| "No memories matched.".into());
                            self.chat_messages.push(("assistant".into(), display));
                        }
                        Err(e) => self.chat_messages.push(("system".into(), format!("recall parse error: {}", e))),
                    },
                    Ok(resp) => self.chat_messages.push(("system".into(), format!("recall HTTP {}", resp.status()))),
                    Err(e) => self.chat_messages.push(("system".into(), format!("recall failed: {}. Is the memory worker running?", e))),
                }
            }
            "remember" => {
                let client = Self::client();
                let body = serde_json::json!({
                    "content": args,
                    "userId": self.chat_realm,
                    "sessionId": "tui-session",
                });
                match client.post(format!("{}/agentmemory/remember", API_BASE)).json(&body).send().await {
                    Ok(resp) if resp.status().is_success() => self.chat_messages.push(("system".into(), "stored".into())),
                    Ok(resp) => self.chat_messages.push(("system".into(), format!("store HTTP {}", resp.status()))),
                    Err(e) => self.chat_messages.push(("system".into(), format!("store failed: {}. Is the memory worker running?", e))),
                }
            }
            "hand" => {
                self.chat_messages.push(("system".into(), format!("Hand invoke not yet wired: {}", args)));
            }
            "skill" => {
                self.chat_messages.push(("system".into(), format!("Skill invoke not yet wired: {}", args)));
            }
            "worker" => {
                self.refresh_worker_catalog().await;
                self.show_worker_picker = true;
                self.worker_picker_selected = 0;
            }
            "channel" => {
                self.chat_messages.push(("system".into(), format!("Channel send not yet wired: {}", args)));
            }
            "approve" | "deny" => {
                self.chat_messages.push(("system".into(), format!("{}: {}", name, args)));
            }
            "clear" => {
                self.chat_messages.clear();
            }
            "help" => {
                self.show_help = true;
            }
            "quit" => {
                self.running = false;
            }
            other => {
                self.chat_messages
                    .push(("system".into(), format!("Unknown command: /{}", other)));
            }
        }
    }

    async fn send_chat(&mut self) {
        if self.chat_input.trim().is_empty() {
            return;
        }
        let msg = self.chat_input.clone();
        self.chat_input.clear();
        self.chat_messages.push(("user".into(), msg.clone()));

        self.chat_streaming = true;
        self.spinner_active = true;
        self.spinner_verb = "thinking".into();
        self.streaming_start = Some(std::time::Instant::now());
        self.streaming_tokens = 0;

        self.chat_messages.push(("assistant".into(), "(thinking...)".into()));

        let agent_id = if self.chat_agent.is_empty() {
            self.agents.first()
                .and_then(|a| a["id"].as_str().or(a["name"].as_str()))
                .unwrap_or("default")
                .to_string()
        } else {
            self.chat_agent.clone()
        };

        let client = Self::client();
        let body = serde_json::json!({
            "messages": [{"role": "user", "content": msg}],
            "agentId": agent_id,
            "realm": self.chat_realm,
        });

        let send_result = client.post(format!("{}/api/chat/stream", API_BASE))
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await;

        match send_result {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.unwrap_or_default();
                let content = parse_chat_response(&text);
                self.streaming_tokens = content.len() / 4;
                if let Some(last) = self.chat_messages.last_mut() {
                    *last = ("assistant".into(), content);
                }
            }
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                let hint = match status {
                    401 | 403 => "Anthropic rejected the request. Check ANTHROPIC_API_KEY in agentos/.env.",
                    404 => "Endpoint not registered. Is the streaming worker running?",
                    500..=599 => "Engine returned a server error. Check llm-router + streaming worker logs.",
                    _ => "Unexpected response.",
                };
                let snippet = body.chars().take(160).collect::<String>();
                if let Some(last) = self.chat_messages.last_mut() {
                    *last = ("system".into(), format!("HTTP {}: {} ({})", status, hint, snippet));
                }
            }
            Err(e) => {
                let hint = if e.is_connect() {
                    "Engine not reachable. Run: iii --config config.yaml"
                } else if e.is_timeout() {
                    "Request timed out. Engine or llm-router may be hung."
                } else {
                    "Network error."
                };
                if let Some(last) = self.chat_messages.last_mut() {
                    *last = ("system".into(), format!("{}: {}", hint, e));
                }
            }
        }

        self.chat_streaming = false;
        self.spinner_active = false;
    }

    async fn approve_selected(&mut self) {
        if self.selected >= self.approvals.len() { return; }
        let approval = &self.approvals[self.selected];
        let request_id = approval["id"].as_str().unwrap_or("").to_string();
        let agent_id = approval["agentId"].as_str().or(approval["agent"].as_str()).unwrap_or("").to_string();
        if request_id.is_empty() { return; }
        let client = Self::client();
        let body = serde_json::json!({
            "requestId": request_id,
            "agentId": agent_id,
            "decision": "approve",
            "decidedBy": "tui",
        });
        let _ = client.post(format!("{}/api/approvals/decide", API_BASE))
            .json(&body)
            .send().await;
        self.approval_mode = false;
        self.pending_approval = None;
        self.refresh_screen().await;
    }

    async fn deny_selected(&mut self) {
        if self.selected >= self.approvals.len() { return; }
        let approval = &self.approvals[self.selected];
        let request_id = approval["id"].as_str().unwrap_or("").to_string();
        let agent_id = approval["agentId"].as_str().or(approval["agent"].as_str()).unwrap_or("").to_string();
        if request_id.is_empty() { return; }
        let client = Self::client();
        let body = serde_json::json!({
            "requestId": request_id,
            "agentId": agent_id,
            "decision": "deny",
            "decidedBy": "tui",
        });
        let _ = client.post(format!("{}/api/approvals/decide", API_BASE))
            .json(&body)
            .send().await;
        self.approval_mode = false;
        self.pending_approval = None;
        self.refresh_screen().await;
    }

    fn max_selectable(&self) -> usize {
        match self.screen {
            Screen::Agents => self.agents.len(),
            Screen::Skills => self.skills.len(),
            Screen::Channels => self.channels.len(),
            Screen::Hands => self.hands.len(),
            Screen::Workflows => self.workflows.len(),
            Screen::Sessions => self.sessions.len(),
            Screen::Approvals => self.approvals.len(),
            Screen::Memory => self.memories.len(),
            Screen::Audit => self.audit_entries.len(),
            Screen::Peers => self.peers.len(),
            Screen::Extensions => self.extensions.len(),
            Screen::Triggers => self.triggers.len(),
            Screen::Templates => self.templates.len(),
            Screen::Settings => self.settings.len(),
            Screen::WorkflowBuilder => self.wf_builder_steps.len(),
            Screen::Tasks => self.task_tree.len(),
            Screen::Lifecycle => self.lifecycle_states.len(),
            Screen::Orchestrator => self.orchestrator_plans.len(),
            _ => 0,
        }
    }
}

fn parse_chat_response(body: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(s) = json["content"].as_str().or_else(|| json["response"].as_str()).or_else(|| json["message"].as_str()) {
            return s.to_string();
        }
    }
    let mut out = String::new();
    for line in body.split('\n') {
        if let Some(rest) = line.strip_prefix("data:") {
            let trimmed = rest.trim();
            if trimmed.is_empty() || trimmed == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    out.push_str(delta);
                } else if let Some(text) = v["text"].as_str().or_else(|| v["content"].as_str()) {
                    out.push_str(text);
                }
            } else {
                out.push_str(trimmed);
            }
        }
    }
    if out.is_empty() {
        body.chars().take(500).collect()
    } else {
        out
    }
}

fn navigate_to(app: &mut App, screen: Screen) {
    app.screen = screen;
    app.selected = 0;
    app.scroll_offset = 0;
    app.approval_mode = false;
    app.pending_approval = None;
}

#[tokio::main]
async fn main() -> Result<()> {
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut app = App::new();
    app.refresh_health().await;
    app.refresh_registry().await;
    if first_run::detect(app.healthy, app.worker_count) == first_run::HealthState::Ready {
        app.show_first_run = false;
    }

    let mut last_health = std::time::Instant::now();

    while app.running {
        terminal.draw(|f| draw(f, &app))?;

        let refresh_interval = if app.show_first_run { 2 } else { 10 };
        if last_health.elapsed() > std::time::Duration::from_secs(refresh_interval) {
            app.refresh_health().await;
            app.refresh_registry().await;
            if first_run::detect(app.healthy, app.worker_count) == first_run::HealthState::Ready {
                app.show_first_run = false;
            }
            last_health = std::time::Instant::now();
        }

        if let Some(timeout) = app.chord_timeout {
            if timeout.elapsed() > std::time::Duration::from_secs(2) {
                app.pending_chord = None;
                app.chord_timeout = None;
            }
        }

        if event::poll(std::time::Duration::from_millis(SPINNER_INTERVAL_MS))?
            && let Event::Key(key) = event::read()?
        {
            if key.kind != KeyEventKind::Press { continue; }

            let ctrl_c = key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('c'));
            if ctrl_c {
                app.running = false;
                continue;
            }

            if app.show_help {
                if matches!(key.code, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')) {
                    app.show_help = false;
                }
                continue;
            }

            if app.show_palette {
                match key.code {
                    KeyCode::Esc => {
                        app.show_palette = false;
                        app.palette_query.clear();
                        app.palette_selected = 0;
                    }
                    KeyCode::Backspace => {
                        app.palette_query.pop();
                        app.palette_selected = 0;
                    }
                    KeyCode::Up => {
                        app.palette_selected = app.palette_selected.saturating_sub(1);
                    }
                    KeyCode::Down => {
                        app.palette_selected = app.palette_selected.saturating_add(1);
                    }
                    KeyCode::Enter => {
                        let items = app.palette_items();
                        let ranked = palette::rank(&items, &app.palette_query);
                        if let Some((idx, _)) = ranked.get(app.palette_selected) {
                            let target = items[*idx].action_key.clone();
                            for s in Screen::all() {
                                if s.key() == target {
                                    navigate_to(&mut app, *s);
                                    app.refresh_screen().await;
                                    break;
                                }
                            }
                        }
                        app.show_palette = false;
                        app.palette_query.clear();
                        app.palette_selected = 0;
                    }
                    KeyCode::Char(c) => {
                        app.palette_query.push(c);
                        app.palette_selected = 0;
                    }
                    _ => {}
                }
                continue;
            }

            if app.show_worker_picker {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') => {
                        app.show_worker_picker = false;
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        app.worker_picker_selected = app.worker_picker_selected.saturating_sub(1);
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        if app.worker_picker_selected + 1 < app.worker_catalog.len() {
                            app.worker_picker_selected += 1;
                        }
                    }
                    KeyCode::Enter => {
                        if let Some(card) = app.worker_catalog.get(app.worker_picker_selected) {
                            app.status = worker_picker::install_command(card);
                        }
                    }
                    _ => {}
                }
                continue;
            }

            if app.show_first_run {
                if matches!(key.code, KeyCode::Esc) {
                    app.show_first_run = false;
                } else if matches!(key.code, KeyCode::Char('q')) {
                    app.running = false;
                }
                continue;
            }

            if matches!(key.code, KeyCode::Char('?'))
                && !matches!(app.screen, Screen::Chat)
            {
                app.show_help = true;
                continue;
            }

            let ctrl_p = key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('p'));
            if ctrl_p {
                app.show_palette = true;
                app.palette_query.clear();
                app.palette_selected = 0;
                continue;
            }

            let ctrl_w = key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('w'));
            if ctrl_w {
                app.refresh_worker_catalog().await;
                app.show_worker_picker = true;
                app.worker_picker_selected = 0;
                continue;
            }

            if app.pending_chord.is_some() {
                let is_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                if is_ctrl {
                    match key.code {
                        KeyCode::Char('k') => {
                            app.status = "Kill all agents — not implemented (confirm first)".into();
                        }
                        KeyCode::Char('r') => {
                            app.pending_chord = None;
                            app.chord_timeout = None;
                            navigate_to(&mut app, Screen::Recovery);
                            app.refresh_screen().await;
                            continue;
                        }
                        KeyCode::Char('e') => {
                            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                            let path = format!("{}/agentos-logs-export.json", home);
                            let export = serde_json::to_string_pretty(&app.logs).unwrap_or_default();
                            match std::fs::write(&path, &export) {
                                Ok(_) => app.status = format!("Logs exported to {}", path),
                                Err(e) => app.status = format!("Export failed: {}", e),
                            }
                        }
                        _ => {}
                    }
                }
                app.pending_chord = None;
                app.chord_timeout = None;
                continue;
            }

            if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('x')) {
                app.pending_chord = Some('x');
                app.chord_timeout = Some(std::time::Instant::now());
                continue;
            }

            if app.screen == Screen::Approvals && app.approval_mode {
                match key.code {
                    KeyCode::Char('a') => {
                        app.approve_selected().await;
                    }
                    KeyCode::Char('d') => {
                        app.deny_selected().await;
                    }
                    KeyCode::Esc => {
                        app.approval_mode = false;
                        app.pending_approval = None;
                    }
                    _ => {}
                }
                continue;
            }

            if app.screen == Screen::Chat {
                match app.vim_mode {
                    VimMode::Normal => {
                        match key.code {
                            KeyCode::Char('i') => {
                                app.vim_mode = VimMode::Insert;
                            }
                            KeyCode::Char('a') => {
                                app.vim_mode = VimMode::Insert;
                            }
                            KeyCode::Char('A') => {
                                app.vim_mode = VimMode::Insert;
                            }
                            KeyCode::Char('d') => {
                                if app.vim_command_buffer == "d" {
                                    app.chat_input.clear();
                                    app.vim_command_buffer.clear();
                                } else {
                                    app.vim_command_buffer = "d".into();
                                }
                            }
                            KeyCode::Char('0') => {
                                app.vim_command_buffer.clear();
                            }
                            KeyCode::Char('$') => {
                                app.vim_command_buffer.clear();
                            }
                            KeyCode::Char('h') | KeyCode::Char('l') => {
                                app.vim_command_buffer.clear();
                            }
                            KeyCode::Char('q') => {
                                app.running = false;
                            }
                            KeyCode::Esc => {
                                app.vim_command_buffer.clear();
                            }
                            KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
                                match c {
                                    '1' => navigate_to(&mut app, Screen::Dashboard),
                                    '2' => navigate_to(&mut app, Screen::Agents),
                                    '4' => navigate_to(&mut app, Screen::Channels),
                                    '5' => navigate_to(&mut app, Screen::Skills),
                                    '6' => navigate_to(&mut app, Screen::Hands),
                                    '7' => navigate_to(&mut app, Screen::Workflows),
                                    '8' => navigate_to(&mut app, Screen::Sessions),
                                    '9' => navigate_to(&mut app, Screen::Approvals),
                                    _ => {}
                                }
                            }
                            KeyCode::Tab => {
                                let screens = Screen::all();
                                let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                                navigate_to(&mut app, screens[(idx + 1) % screens.len()]);
                            }
                            _ => {
                                app.vim_command_buffer.clear();
                            }
                        }
                    }
                    VimMode::Insert => {
                        match key.code {
                            KeyCode::Esc => {
                                if app.chat_input.is_empty() {
                                    app.vim_mode = VimMode::Normal;
                                } else {
                                    app.chat_input.clear();
                                    app.slash_completions.clear();
                                }
                            }
                            KeyCode::Enter => {
                                if app.chat_input.starts_with('/') {
                                    let parsed = slash::parse(&app.chat_input);
                                    app.handle_slash(parsed).await;
                                } else {
                                    app.send_chat().await;
                                }
                                app.chat_input.clear();
                                app.slash_completions.clear();
                            }
                            KeyCode::Backspace => {
                                app.chat_input.pop();
                                app.refresh_slash_completions();
                            }
                            KeyCode::Tab => {
                                if !app.slash_completions.is_empty() {
                                    let pick = &app.slash_completions[app.slash_selected].0;
                                    app.chat_input = format!("/{} ", pick);
                                    app.refresh_slash_completions();
                                } else {
                                    let screens = Screen::all();
                                    let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                                    navigate_to(&mut app, screens[(idx + 1) % screens.len()]);
                                }
                            }
                            KeyCode::Up => {
                                if app.slash_selected > 0 {
                                    app.slash_selected -= 1;
                                }
                            }
                            KeyCode::Down => {
                                if app.slash_selected + 1 < app.slash_completions.len() {
                                    app.slash_selected += 1;
                                }
                            }
                            KeyCode::Char(c) => {
                                app.chat_input.push(c);
                                app.refresh_slash_completions();
                            }
                            _ => {}
                        }
                    }
                }
                continue;
            }

            if app.screen == Screen::Wizard {
                match key.code {
                    KeyCode::Esc => app.screen = Screen::Dashboard,
                    KeyCode::Enter => {
                        if app.wizard_step < 5 {
                            app.wizard_step += 1;
                        } else {
                            app.status = "Setup complete!".into();
                            app.screen = Screen::Dashboard;
                        }
                    }
                    KeyCode::Backspace => {
                        if app.wizard_step < app.wizard_values.len() {
                            app.wizard_values[app.wizard_step].pop();
                        }
                    }
                    KeyCode::Char(c) if c.is_ascii_digit() || c == 'q' => {
                        match c {
                            'q' => app.running = false,
                            '1' => navigate_to(&mut app, Screen::Dashboard),
                            '2' => navigate_to(&mut app, Screen::Agents),
                            '3' => navigate_to(&mut app, Screen::Chat),
                            '4' => navigate_to(&mut app, Screen::Channels),
                            '5' => navigate_to(&mut app, Screen::Skills),
                            '6' => navigate_to(&mut app, Screen::Hands),
                            '7' => navigate_to(&mut app, Screen::Workflows),
                            '8' => navigate_to(&mut app, Screen::Sessions),
                            '9' => navigate_to(&mut app, Screen::Approvals),
                            '0' => navigate_to(&mut app, Screen::Logs),
                            _ => {}
                        }
                    }
                    KeyCode::Char(c) => {
                        if app.wizard_step < app.wizard_values.len() {
                            app.wizard_values[app.wizard_step].push(c);
                        }
                    }
                    KeyCode::BackTab => {
                        if app.wizard_step > 0 { app.wizard_step -= 1; }
                    }
                    KeyCode::Tab => {
                        if app.wizard_step < 5 { app.wizard_step += 1; }
                    }
                    _ => {}
                }
                continue;
            }

            match key.code {
                KeyCode::Char('q') => app.running = false,
                KeyCode::Char('1') => navigate_to(&mut app, Screen::Dashboard),
                KeyCode::Char('2') => navigate_to(&mut app, Screen::Agents),
                KeyCode::Char('3') => navigate_to(&mut app, Screen::Chat),
                KeyCode::Char('4') => navigate_to(&mut app, Screen::Channels),
                KeyCode::Char('5') => navigate_to(&mut app, Screen::Skills),
                KeyCode::Char('6') => navigate_to(&mut app, Screen::Hands),
                KeyCode::Char('7') => navigate_to(&mut app, Screen::Workflows),
                KeyCode::Char('8') => navigate_to(&mut app, Screen::Sessions),
                KeyCode::Char('9') => navigate_to(&mut app, Screen::Approvals),
                KeyCode::Char('0') => navigate_to(&mut app, Screen::Logs),
                KeyCode::Char('m') => navigate_to(&mut app, Screen::Memory),
                KeyCode::Char('p') => navigate_to(&mut app, Screen::Peers),
                KeyCode::Char('e') => navigate_to(&mut app, Screen::Extensions),
                KeyCode::Char('t') => navigate_to(&mut app, Screen::Triggers),
                KeyCode::Char('u') => navigate_to(&mut app, Screen::Usage),
                KeyCode::Char('w') => navigate_to(&mut app, Screen::Wizard),
                KeyCode::Char('r') => app.refresh_screen().await,
                KeyCode::Char('a') if app.screen == Screen::Approvals => {
                    if app.approval_mode {
                        app.approve_selected().await;
                    } else {
                        app.approve_selected().await;
                    }
                }
                KeyCode::Char('a') => navigate_to(&mut app, Screen::Audit),
                KeyCode::Char('s') => navigate_to(&mut app, Screen::Security),
                KeyCode::Char('T') => navigate_to(&mut app, Screen::Templates),
                KeyCode::Char('S') => navigate_to(&mut app, Screen::Settings),
                KeyCode::Char('W') => navigate_to(&mut app, Screen::WorkflowBuilder),
                KeyCode::Char('L') => navigate_to(&mut app, Screen::Lifecycle),
                KeyCode::Char('K') => navigate_to(&mut app, Screen::Tasks),
                KeyCode::Char('R') => navigate_to(&mut app, Screen::Recovery),
                KeyCode::Char('O') => navigate_to(&mut app, Screen::Orchestrator),
                KeyCode::Char('d') if app.screen == Screen::Approvals => {
                    if app.approval_mode {
                        app.deny_selected().await;
                    } else {
                        app.deny_selected().await;
                    }
                }
                KeyCode::Enter if app.screen == Screen::Approvals => {
                    if app.selected < app.approvals.len() {
                        app.pending_approval = Some(app.approvals[app.selected].clone());
                        app.approval_mode = true;
                    }
                }
                KeyCode::Enter if app.screen == Screen::Tasks => {
                    if app.selected < app.task_tree.len() {
                        let task_id = app.task_tree[app.selected]["id"].as_str().unwrap_or("").to_string();
                        if !task_id.is_empty() {
                            if app.task_expanded.contains(&task_id) {
                                app.task_expanded.remove(&task_id);
                            } else {
                                app.task_expanded.insert(task_id);
                            }
                        }
                    }
                }
                KeyCode::Char('x') if app.screen == Screen::WorkflowBuilder => {
                    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                    let path = format!("{}/workflow-export.toml", home);
                    let toml = app.wf_builder_steps.iter().enumerate()
                        .map(|(i, s)| format!("[[steps]]\nname = \"step-{}\"\nfunction = \"{}\"", i + 1, s))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    match std::fs::write(&path, &toml) {
                        Ok(_) => app.status = format!("Exported to {}", path),
                        Err(e) => app.status = format!("Export failed: {}", e),
                    }
                }
                KeyCode::Char('+') if app.screen == Screen::WorkflowBuilder => {
                    app.wf_builder_steps.push("new::step".into());
                    app.selected = app.wf_builder_steps.len().saturating_sub(1);
                }
                KeyCode::Char('-') if app.screen == Screen::WorkflowBuilder => {
                    if !app.wf_builder_steps.is_empty() && app.selected < app.wf_builder_steps.len() {
                        app.wf_builder_steps.remove(app.selected);
                        if app.selected > 0 { app.selected -= 1; }
                    }
                }
                KeyCode::Up => {
                    if app.screen == Screen::Logs {
                        app.scroll_offset = app.scroll_offset.saturating_sub(1);
                    } else if app.selected > 0 {
                        app.selected -= 1;
                    }
                }
                KeyCode::Down => {
                    if app.screen == Screen::Logs {
                        let max = app.logs.len().saturating_sub(1) as u16;
                        app.scroll_offset = app.scroll_offset.saturating_add(1).min(max);
                    } else {
                        let max = app.max_selectable().saturating_sub(1);
                        if app.selected < max {
                            app.selected += 1;
                        }
                    }
                }
                KeyCode::Tab => {
                    let screens = Screen::all();
                    let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                    navigate_to(&mut app, screens[(idx + 1) % screens.len()]);
                }
                KeyCode::BackTab => {
                    let screens = Screen::all();
                    let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                    navigate_to(&mut app, screens[(idx + screens.len() - 1) % screens.len()]);
                }
                _ => {}
            }
        }

        if app.spinner_active {
            app.spinner_frame = (app.spinner_frame + 1) % SPINNER_FRAMES.len();
        }
    }

    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}

fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
        ])
        .split(f.area());

    let body_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(22), Constraint::Min(0)])
        .split(chunks[1]);

    let nav_items: Vec<ListItem> = Screen::all()
        .iter()
        .map(|s| {
            let style = if *s == app.screen {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let key = s.key();
            let display_key = if key.is_empty() { " " } else { key };
            ListItem::new(format!("{} {}", display_key, s.label()))
                .style(style)
        })
        .collect();

    let nav = List::new(nav_items)
        .block(Block::default().borders(Borders::ALL).title(" Nav "));
    f.render_widget(nav, body_chunks[0]);

    let content_block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" {} ", app.screen.label()));

    match app.screen {
        Screen::Dashboard => draw_dashboard(f, app, content_block, body_chunks[1]),
        Screen::Agents => draw_agents(f, app, content_block, body_chunks[1]),
        Screen::Chat => draw_chat(f, app, body_chunks[1]),
        Screen::Channels => draw_channels(f, app, content_block, body_chunks[1]),
        Screen::Skills => draw_skills(f, app, content_block, body_chunks[1]),
        Screen::Hands => draw_hands(f, app, content_block, body_chunks[1]),
        Screen::Workflows => draw_workflows(f, app, content_block, body_chunks[1]),
        Screen::Sessions => draw_sessions(f, app, content_block, body_chunks[1]),
        Screen::Approvals => draw_approvals(f, app, body_chunks[1]),
        Screen::Logs => draw_logs(f, app, content_block, body_chunks[1]),
        Screen::Memory => draw_memory(f, app, content_block, body_chunks[1]),
        Screen::Audit => draw_audit(f, app, content_block, body_chunks[1]),
        Screen::Security => draw_security(f, app, content_block, body_chunks[1]),
        Screen::Peers => draw_peers(f, app, content_block, body_chunks[1]),
        Screen::Extensions => draw_extensions(f, app, content_block, body_chunks[1]),
        Screen::Triggers => draw_triggers(f, app, content_block, body_chunks[1]),
        Screen::Templates => draw_templates(f, app, content_block, body_chunks[1]),
        Screen::Usage => draw_usage(f, app, content_block, body_chunks[1]),
        Screen::Settings => draw_settings(f, app, content_block, body_chunks[1]),
        Screen::Wizard => draw_wizard(f, app, body_chunks[1]),
        Screen::WorkflowBuilder => draw_workflow_builder(f, app, content_block, body_chunks[1]),
        Screen::Lifecycle => draw_lifecycle(f, app, content_block, body_chunks[1]),
        Screen::Tasks => draw_tasks(f, app, content_block, body_chunks[1]),
        Screen::Recovery => draw_recovery(f, app, content_block, body_chunks[1]),
        Screen::Orchestrator => draw_orchestrator(f, app, content_block, body_chunks[1]),
    }

    let help = match app.screen {
        Screen::Chat => {
            if app.pending_chord.is_some() {
                " Ctrl+X pressed — waiting for chord: k:Kill r:Recovery e:Export "
            } else {
                match app.vim_mode {
                    VimMode::Normal => " [NORMAL] i:Insert a:Append dd:Clear 1-9:Nav q:Quit Ctrl+X:Chord ",
                    VimMode::Insert => " [INSERT] Esc:Normal Enter:Send Tab:Autocomplete  Ctrl+P:palette  Ctrl+W:workers ",
                }
            }
        }
        Screen::Approvals if app.approval_mode => " a:Approve  d:Deny  Esc:Cancel ",
        Screen::Approvals => " Enter:Details  a:Approve  d:Deny  r:Refresh  q:Quit ",
        Screen::Logs => " Up/Down:Scroll  r:Refresh  Ctrl+X:Chord  q:Quit ",
        Screen::WorkflowBuilder => " +:Add  -:Remove  x:Export  Up/Down:Select  q:Quit ",
        Screen::Wizard => " Enter:Next  Tab:Fwd  Shift-Tab:Back  1-9:Nav  Esc:Dashboard  q:Quit ",
        Screen::Lifecycle | Screen::Tasks | Screen::Recovery | Screen::Orchestrator => " r:Refresh  Enter:Select/Expand  Up/Down:Nav  Ctrl+X:Chord  q:Quit ",
        _ => " q:Quit  Tab:Next  1-0:Screen  m/a/s/p/e/t/u:More  r:Refresh  Ctrl+X:Chord  Up/Down:Select ",
    };
    f.render_widget(
        Paragraph::new(help).style(theme::eyebrow()),
        chunks[2],
    );

    let status_input = status::StatusInput {
        engine_healthy: app.healthy,
        worker_count: app.worker_count,
        agent: if app.chat_agent.is_empty() { "default" } else { &app.chat_agent },
        realm: &app.chat_realm,
        session_active: app.chat_streaming,
        pending_approvals: app.approvals.len(),
        hint: "?:help  Ctrl+P:palette  Ctrl+W:workers",
    };
    status::draw(f, chunks[0], &status_input);

    let area = f.area();
    if app.show_first_run {
        let hs = first_run::detect(app.healthy, app.worker_count);
        match hs {
            first_run::HealthState::EngineDown => first_run::draw_engine_down(f, area),
            first_run::HealthState::EngineUpNoWorkers => first_run::draw_no_workers(f, area),
            first_run::HealthState::Ready => {}
        }
    }
    if app.show_help {
        help_overlay::draw(f, area);
    }
    if app.show_palette {
        let items = app.palette_items();
        palette::draw(f, area, &app.palette_query, &items, app.palette_selected);
    }
    if app.show_worker_picker {
        draw_worker_picker(f, app, area);
    }
    if !app.slash_completions.is_empty() && app.screen == Screen::Chat {
        draw_slash_completions(f, app, area);
    }
}

fn draw_slash_completions(f: &mut Frame, app: &App, area: Rect) {
    let h = (app.slash_completions.len() as u16 + 2).min(12);
    let popup = Rect {
        x: area.x + 4,
        y: area.bottom().saturating_sub(h + 5),
        width: area.width.saturating_sub(8),
        height: h,
    };
    f.render_widget(Clear, popup);
    let mut lines: Vec<Line> = Vec::new();
    for (i, (name, hint)) in app.slash_completions.iter().enumerate() {
        let style = if i == app.slash_selected {
            Style::default().bg(theme::EMBER).fg(theme::PAPER).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(format!("  /{:<16}", name), style),
            Span::styled(format!("  {}", hint), theme::dim()),
        ]));
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::dim())
        .title(Span::styled(" Tab to complete ", theme::eyebrow()));
    f.render_widget(Paragraph::new(lines).block(block), popup);
}

fn draw_worker_picker(f: &mut Frame, app: &App, area: Rect) {
    let popup = help_overlay::centered_rect(70, 70, area);
    f.render_widget(Clear, popup);
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled("AGENTOS · WORKER PICKER", theme::eyebrow())),
        Line::raw(""),
    ];
    if app.worker_catalog.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No catalog available. Engine must expose /api/workers/catalog.",
            theme::dim(),
        )));
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            "  Manual install: cargo build --release -p <worker-name>",
            theme::accent(),
        )));
    } else {
        for (i, card) in app.worker_catalog.iter().enumerate() {
            let style = if i == app.worker_picker_selected {
                Style::default().bg(theme::EMBER).fg(theme::PAPER).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let badge = if card.installed { "● installed" } else { "○ available" };
            let badge_style = if card.installed { theme::ok() } else { theme::dim() };
            lines.push(Line::from(vec![
                Span::styled(format!("  {:<24}", card.name), style),
                Span::styled(format!("  {}", badge), badge_style),
                Span::styled(format!("  {}", card.description), theme::dim()),
            ]));
        }
        lines.push(Line::raw(""));
        if let Some(card) = app.worker_catalog.get(app.worker_picker_selected) {
            lines.push(Line::from(Span::styled(
                format!("  Functions: {}", card.functions.join(", ")),
                theme::dim(),
            )));
            lines.push(Line::raw(""));
            lines.push(Line::from(Span::styled(
                format!("  Enter: {}", worker_picker::install_command(card)),
                theme::accent(),
            )));
        }
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Esc to close · ↑↓ to pick · Enter to copy install command",
        theme::dim(),
    )));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .title(Span::styled(" Workers ", theme::title()));
    f.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), popup);
}

fn draw_dashboard(f: &mut Frame, app: &App, block: Block, area: Rect) {
    if !app.healthy {
        let logo = vec![
            Line::from(""),
            Line::from(Span::styled(r"     _                    _    ___  ____  ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(r"    / \   __ _  ___ _ __ | |_ / _ \/ ___| ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(r"   / _ \ / _` |/ _ \ '_ \| __| | | \___ \ ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(r"  / ___ \ (_| |  __/ | | | |_| |_| |___) |", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(r" /_/   \_\__, |\___|_| |_|\__|\___/|____/ ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(r"         |___/                             ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(Span::styled("  Agent Operating System v0.1.0", Style::default().fg(Color::White).add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(Span::styled("  Engine offline — waiting for connection...", Style::default().fg(Color::Yellow))),
            Line::from(""),
            Line::from(Span::styled("  Keybindings:", Style::default().add_modifier(Modifier::BOLD))),
            Line::from(Span::styled("    1-0   Core screens (Dashboard, Agents, Chat...)", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    m     Memory          a  Audit", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    s     Security        p  Peers", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    e     Extensions      t  Triggers", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    u     Usage           T  Templates", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    S     Settings        w  Wizard", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    W     Wf Builder      L  Lifecycle", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    K     Tasks           R  Recovery", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    O     Orchestrator", Style::default().fg(Color::DarkGray))),
            Line::from(""),
            Line::from(Span::styled("    Tab / Shift-Tab to cycle screens", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    Ctrl+X then k/r/e for chords", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("    r to refresh, q to quit", Style::default().fg(Color::DarkGray))),
        ];
        f.render_widget(Paragraph::new(logo).block(block), area);
        return;
    }

    let stats = &app.dashboard_stats;
    let agents = stats["agents"].as_u64().unwrap_or(0);
    let skills = stats["skills"].as_u64().unwrap_or(0);
    let hands = stats["hands"].as_u64().unwrap_or(0);
    let workflows = stats["workflows"].as_u64().unwrap_or(0);
    let sessions = stats["sessions"].as_u64().unwrap_or(0);
    let approvals = stats["approvals"].as_u64().unwrap_or(0);
    let requests = stats["requests"].as_u64().unwrap_or(0);
    let cost = stats["cost"].as_f64().unwrap_or(0.0);
    let tokens_total = stats["tokens"]["total"].as_u64().unwrap_or(0);
    let tokens_input = stats["tokens"]["input"].as_u64().unwrap_or(0);
    let tokens_output = stats["tokens"]["output"].as_u64().unwrap_or(0);
    let uptime = stats["uptime"].as_f64().unwrap_or(0.0);

    let uptime_str = if uptime < 60.0 {
        format!("{}s", uptime as u64)
    } else if uptime < 3600.0 {
        format!("{}m {}s", (uptime / 60.0) as u64, (uptime % 60.0) as u64)
    } else {
        let h = (uptime / 3600.0) as u64;
        let m = ((uptime % 3600.0) / 60.0) as u64;
        format!("{}h {}m", h, m)
    };

    let text = vec![
        Line::from(Span::styled("Agent Operating System", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(""),
        Line::from(vec![
            Span::styled("  Status:     ", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(
                stats["status"].as_str().unwrap_or("unknown"),
                Style::default().fg(Color::Green),
            ),
        ]),
        Line::from(vec![
            Span::styled("  Uptime:     ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(uptime_str),
        ]),
        Line::from(""),
        Line::from(Span::styled("  Resources", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
        Line::from(format!("    Agents:     {}", agents)),
        Line::from(format!("    Skills:     {}", skills)),
        Line::from(format!("    Hands:      {}", hands)),
        Line::from(format!("    Workflows:  {}", workflows)),
        Line::from(format!("    Sessions:   {}", sessions)),
        Line::from(format!("    Approvals:  {} pending", approvals)),
        Line::from(""),
        Line::from(Span::styled("  Usage", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
        Line::from(format!("    Requests:   {}", requests)),
        Line::from(format!("    Tokens:     {} (in: {} / out: {})", tokens_total, tokens_input, tokens_output)),
        Line::from(format!("    Cost:       ${:.4}", cost)),
        Line::from(""),
        if let Some(ref err) = app.last_error {
            Line::from(Span::styled(format!("  Error: {}", err), Style::default().fg(Color::Red)))
        } else {
            Line::from(Span::styled("  Press r to refresh, 1-0 to navigate", Style::default().fg(Color::DarkGray)))
        },
    ];
    f.render_widget(Paragraph::new(text).block(block), area);
}

fn draw_agents(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.agents.iter().enumerate().map(|(i, a)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let id = a["id"].as_str().or(a["name"].as_str()).unwrap_or("-");
        let name = a["name"].as_str().unwrap_or("-");
        let model = a["model"].as_str().unwrap_or("-");
        let status = a["status"].as_str().unwrap_or("ready");
        Row::new(vec![
            Cell::from(truncate(id, 20)),
            Cell::from(name.to_string()),
            Cell::from(model.to_string()),
            Cell::from(status_cell(status)),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(30),
        Constraint::Percentage(25),
        Constraint::Percentage(20),
    ])
    .header(Row::new(["ID", "Name", "Model", "Status"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    let chat_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(3), Constraint::Length(1)])
        .split(area);

    let mut messages: Vec<Line> = vec![];
    for (idx, (role, msg)) in app.chat_messages.iter().enumerate() {
        let (prefix, color) = match role.as_str() {
            "user" => ("you  ", theme::EMBER),
            "assistant" => ("agent  ", theme::INK),
            _ => ("·  ", theme::MUTED),
        };

        let is_last = idx == app.chat_messages.len() - 1;
        let is_streaming_msg = is_last && app.chat_streaming && msg == "(thinking...)";

        messages.push(Line::from(Span::styled(
            prefix,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )));

        if is_streaming_msg {
            messages.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!("{} thinking...", SPINNER_FRAMES[app.spinner_frame]),
                    theme::dim(),
                ),
            ]));
        } else if role == "assistant" {
            for line in markdown::render(msg) {
                let mut spans: Vec<Span> = vec![Span::raw("  ")];
                spans.extend(line.spans);
                messages.push(Line::from(spans));
            }
        } else {
            messages.push(Line::from(vec![Span::raw("  "), Span::raw(msg.clone())]));
        }
        messages.push(Line::raw(""));
    }

    if messages.is_empty() {
        messages.push(Line::from(Span::styled(
            "AGENTOS · CHAT",
            theme::eyebrow(),
        )));
        messages.push(Line::raw(""));
        messages.push(Line::from(Span::styled(
            "  Type a message — or a slash command:",
            theme::dim(),
        )));
        messages.push(Line::raw(""));
        for spec in slash::BUILTINS.iter().take(7) {
            messages.push(Line::from(vec![
                Span::styled(format!("    /{:<10}", spec.name), theme::accent()),
                Span::styled(format!("  {}", spec.help), theme::dim()),
            ]));
        }
        messages.push(Line::raw(""));
        messages.push(Line::from(Span::styled(
            "  Press ? for full keymap, Ctrl+W to browse workers.",
            theme::dim(),
        )));
    }

    let agent_label = if app.chat_agent.is_empty() {
        app.agents.first()
            .and_then(|a| a["name"].as_str())
            .unwrap_or("default")
    } else {
        &app.chat_agent
    };

    let msg_block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::dim())
        .title(Span::styled(
            format!(" chat · {} · {} ", agent_label, app.chat_realm),
            theme::eyebrow(),
        ));
    f.render_widget(Paragraph::new(messages).block(msg_block).wrap(Wrap { trim: false }), chat_chunks[0]);

    let mode_label = match app.vim_mode {
        VimMode::Normal => Span::styled(" NORMAL ", theme::warn()),
        VimMode::Insert => Span::styled(" INSERT ", theme::accent()),
    };

    let border_color = if app.chat_input.starts_with('/') { theme::EMBER } else { theme::INK };
    let input_block = Block::default()
        .borders(Borders::ALL)
        .title(mode_label)
        .border_style(Style::default().fg(border_color));
    let cursor_char = if app.vim_mode == VimMode::Insert { "▎" } else { "█" };
    let prefix = if app.chat_input.starts_with('/') { "" } else { "> " };
    let cursor_text = format!("{}{}{}", prefix, app.chat_input, cursor_char);
    f.render_widget(Paragraph::new(cursor_text).block(input_block), chat_chunks[1]);

    let mut status_spans = vec![];
    if app.chat_streaming {
        let elapsed = app.streaming_start
            .map(|s| s.elapsed().as_secs())
            .unwrap_or(0);
        status_spans.push(Span::styled(
            format!(" {} ", SPINNER_FRAMES[app.spinner_frame]),
            Style::default().fg(Color::Cyan),
        ));
        status_spans.push(Span::raw(format!("{}s ", elapsed)));
        status_spans.push(Span::styled(
            format!("~{} tokens ", app.streaming_tokens),
            Style::default().fg(Color::DarkGray),
        ));
        let cost_est = app.streaming_tokens as f64 * 0.000003;
        status_spans.push(Span::styled(
            format!("~${:.4}", cost_est),
            Style::default().fg(Color::DarkGray),
        ));
    } else {
        status_spans.push(Span::styled(
            format!(" {} tokens total", app.streaming_tokens),
            Style::default().fg(Color::DarkGray),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(status_spans)), chat_chunks[2]);
}

fn draw_channels(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.channels.iter().enumerate().map(|(i, c)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(c["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(status_cell(c["status"].as_str().unwrap_or("unknown"))),
            Cell::from(c["type"].as_str().unwrap_or("-").to_string()),
            Cell::from(truncate(c["lastMessage"].as_str().unwrap_or("-"), 40)),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(15),
        Constraint::Percentage(15),
        Constraint::Percentage(45),
    ])
    .header(Row::new(["Name", "Status", "Type", "Last Message"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_skills(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.skills.iter().enumerate().map(|(i, s)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(s["id"].as_str().or(s["name"].as_str()).unwrap_or("-").to_string()),
            Cell::from(s["category"].as_str().unwrap_or("-").to_string()),
            Cell::from(s["name"].as_str().or(s["description"].as_str()).unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(30),
        Constraint::Percentage(20),
        Constraint::Percentage(50),
    ])
    .header(Row::new(["ID", "Category", "Name"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_hands(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.hands.iter().enumerate().map(|(i, h)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let name = h["name"].as_str().or(h["id"].as_str()).unwrap_or("-");
        let schedule = h["schedule"].as_str().unwrap_or("-");
        let enabled = h["enabled"].as_bool().unwrap_or(false);
        let status = if enabled { "active" } else { "paused" };
        Row::new(vec![
            Cell::from(name.to_string()),
            Cell::from(schedule.to_string()),
            Cell::from(status_cell(status)),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(35),
        Constraint::Percentage(35),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["Name", "Schedule", "Status"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_workflows(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.workflows.iter().enumerate().map(|(i, w)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let steps = w["steps"].as_array().map(|a| a.len()).unwrap_or(0);
        Row::new(vec![
            Cell::from(w["id"].as_str().unwrap_or("-").to_string()),
            Cell::from(w["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(format!("{}", steps)),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(30),
        Constraint::Percentage(40),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["ID", "Name", "Steps"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_sessions(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.sessions.iter().enumerate().map(|(i, s)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let id = s["id"].as_str().or(s["key"].as_str()).unwrap_or("-");
        let agent = s["agent"].as_str().or(s["agentId"].as_str()).unwrap_or("-");
        let status = s["status"].as_str().unwrap_or("active");
        let created = s["created"].as_str()
            .or(s["createdAt"].as_str())
            .or(s["timestamp"].as_str())
            .unwrap_or("-");
        Row::new(vec![
            Cell::from(truncate(id, 20)),
            Cell::from(agent.to_string()),
            Cell::from(status_cell(status)),
            Cell::from(created.to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(25),
        Constraint::Percentage(15),
        Constraint::Percentage(35),
    ])
    .header(Row::new(["ID", "Agent", "Status", "Created"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_approvals(f: &mut Frame, app: &App, area: Rect) {
    if app.approval_mode {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
            .split(area);

        let detail_block = Block::default()
            .borders(Borders::ALL)
            .title(" Approval Details ")
            .border_style(Style::default().fg(Color::Yellow));

        let mut lines = vec![];
        if let Some(ref approval) = app.pending_approval {
            lines.push(Line::from(vec![
                Span::styled("  ID:      ", Style::default().add_modifier(Modifier::BOLD)),
                Span::raw(approval["id"].as_str().unwrap_or("-")),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  Tool:    ", Style::default().add_modifier(Modifier::BOLD)),
                Span::raw(approval["toolName"].as_str().or(approval["tool"].as_str()).unwrap_or("-")),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  Agent:   ", Style::default().add_modifier(Modifier::BOLD)),
                Span::raw(approval["agentId"].as_str().or(approval["agent"].as_str()).unwrap_or("-")),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  Status:  ", Style::default().add_modifier(Modifier::BOLD)),
                Span::raw(approval["status"].as_str().unwrap_or("pending")),
            ]));
            lines.push(Line::from(""));
            let args_str = approval["args"].to_string();
            if args_str != "null" {
                lines.push(Line::from(vec![
                    Span::styled("  Args:    ", Style::default().add_modifier(Modifier::BOLD)),
                    Span::raw(truncate(&args_str, 60)),
                ]));
            }
            let reason = approval["reason"].as_str().unwrap_or("");
            if !reason.is_empty() {
                lines.push(Line::from(vec![
                    Span::styled("  Reason:  ", Style::default().add_modifier(Modifier::BOLD)),
                    Span::raw(reason),
                ]));
            }
        } else {
            lines.push(Line::from(Span::styled("  No approval selected", Style::default().fg(Color::DarkGray))));
        }

        f.render_widget(Paragraph::new(lines).block(detail_block).wrap(Wrap { trim: false }), split[0]);

        let action_block = Block::default()
            .borders(Borders::ALL)
            .title(" Action ")
            .border_style(Style::default().fg(Color::Cyan));

        let action_lines = vec![
            Line::from(""),
            Line::from(Span::styled("  Choose an action:", Style::default().add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(vec![
                Span::styled("  [a] ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                Span::raw("Approve"),
            ]),
            Line::from(vec![
                Span::styled("  [d] ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
                Span::raw("Deny"),
            ]),
            Line::from(vec![
                Span::styled("  [Esc] ", Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD)),
                Span::raw("Cancel"),
            ]),
        ];

        f.render_widget(Paragraph::new(action_lines).block(action_block), split[1]);
        return;
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Approvals ");

    let rows: Vec<Row> = app.approvals.iter().enumerate().map(|(i, a)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let status_str = a["status"].as_str().unwrap_or("pending");
        let status_span = match status_str {
            "approved" => Span::styled("approved", Style::default().fg(Color::Green)),
            "denied" => Span::styled("denied", Style::default().fg(Color::Red)),
            _ => Span::styled("pending", Style::default().fg(Color::Yellow)),
        };
        Row::new(vec![
            Cell::from(truncate(a["id"].as_str().unwrap_or("-"), 15)),
            Cell::from(a["toolName"].as_str().or(a["tool"].as_str()).or(a["toolId"].as_str()).unwrap_or("-").to_string()),
            Cell::from(a["agentId"].as_str().or(a["agent"].as_str()).unwrap_or("-").to_string()),
            Cell::from(status_span),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(30),
        Constraint::Percentage(25),
        Constraint::Percentage(25),
    ])
    .header(Row::new(["ID", "Tool", "Agent", "Status"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_logs(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let lines: Vec<Line> = app.logs.iter().map(|l| {
        let text = if let Some(s) = l.as_str() {
            s.to_string()
        } else if let Some(obj) = l.as_object() {
            let level = obj.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            let msg = obj.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let ts = obj.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
            format!("[{}] {} {}", level.to_uppercase(), ts, msg)
        } else {
            l.to_string()
        };

        let color = if text.contains("ERROR") || text.contains("error") {
            Color::Red
        } else if text.contains("WARN") || text.contains("warn") {
            Color::Yellow
        } else if text.contains("INFO") || text.contains("info") {
            Color::Green
        } else {
            Color::White
        };
        Line::from(Span::styled(text, Style::default().fg(color)))
    }).collect();

    f.render_widget(
        Paragraph::new(lines)
            .block(block)
            .scroll((app.scroll_offset, 0))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn draw_memory(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.memories.iter().enumerate().map(|(i, m)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let preview = m["content"].as_str()
            .or(m["text"].as_str())
            .unwrap_or("-");
        Row::new(vec![
            Cell::from(truncate(m["id"].as_str().unwrap_or("-"), 15)),
            Cell::from(m["type"].as_str().unwrap_or("-").to_string()),
            Cell::from(format!("{:.2}", m["score"].as_f64().unwrap_or(0.0))),
            Cell::from(truncate(preview, 40)),
            Cell::from(m["created"].as_str().or(m["createdAt"].as_str()).unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(15),
        Constraint::Percentage(10),
        Constraint::Percentage(10),
        Constraint::Percentage(40),
        Constraint::Percentage(25),
    ])
    .header(Row::new(["ID", "Type", "Score", "Preview", "Created"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_audit(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.audit_entries.iter().enumerate().map(|(i, a)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(a["action"].as_str().or(a["type"].as_str()).unwrap_or("-").to_string()),
            Cell::from(a["agent"].as_str().or(a["agentId"].as_str()).unwrap_or("-").to_string()),
            Cell::from(truncate(a["details"].as_str().or(a["message"].as_str()).unwrap_or("-"), 30)),
            Cell::from(a["timestamp"].as_str().or(a["createdAt"].as_str()).unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(20),
        Constraint::Percentage(35),
        Constraint::Percentage(25),
    ])
    .header(Row::new(["Action", "Agent", "Details", "Timestamp"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_security(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled("Security Capabilities", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(""),
    ];

    if let Some(obj) = app.security_caps.as_object() {
        for (key, val) in obj {
            lines.push(Line::from(Span::styled(
                format!("  {}", key),
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            )));
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        lines.push(Line::from(format!("    - {}", s)));
                    } else if let Some(obj) = item.as_object() {
                        for (k, v) in obj {
                            lines.push(Line::from(format!("    {} = {}", k, v)));
                        }
                    }
                }
            } else if let Some(obj) = val.as_object() {
                for (k, v) in obj {
                    lines.push(Line::from(format!("    {}: {}", k, v)));
                }
            } else {
                lines.push(Line::from(format!("    {}", val)));
            }
            lines.push(Line::from(""));
        }
    } else {
        lines.push(Line::from(Span::styled("  No data — press r to refresh", Style::default().fg(Color::DarkGray))));
    }

    f.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), area);
}

fn draw_peers(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.peers.iter().enumerate().map(|(i, p)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(p["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(truncate(p["url"].as_str().unwrap_or("-"), 30)),
            Cell::from(status_cell(p["status"].as_str().unwrap_or("unknown"))),
            Cell::from(p["lastSeen"].as_str().unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(35),
        Constraint::Percentage(15),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["Name", "URL", "Status", "Last Seen"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_extensions(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.extensions.iter().enumerate().map(|(i, e)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let tool_count = e["toolCount"].as_u64()
            .or_else(|| e["tools"].as_array().map(|a| a.len() as u64))
            .unwrap_or(0);
        Row::new(vec![
            Cell::from(e["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(e["transport"].as_str().unwrap_or("-").to_string()),
            Cell::from(format!("{}", tool_count)),
            Cell::from(status_cell(e["status"].as_str().unwrap_or("connected"))),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(30),
        Constraint::Percentage(20),
        Constraint::Percentage(15),
        Constraint::Percentage(35),
    ])
    .header(Row::new(["Name", "Transport", "Tools", "Status"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_triggers(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.triggers.iter().enumerate().map(|(i, t)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let enabled = t["enabled"].as_bool().unwrap_or(true);
        let enabled_span = if enabled {
            Span::styled("yes", Style::default().fg(Color::Green))
        } else {
            Span::styled("no", Style::default().fg(Color::Red))
        };
        Row::new(vec![
            Cell::from(t["type"].as_str().unwrap_or("-").to_string()),
            Cell::from(t["function"].as_str().or(t["function_id"].as_str()).unwrap_or("-").to_string()),
            Cell::from(truncate(&t["config"].to_string(), 30)),
            Cell::from(enabled_span),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(15),
        Constraint::Percentage(30),
        Constraint::Percentage(35),
        Constraint::Percentage(20),
    ])
    .header(Row::new(["Type", "Function", "Config", "Enabled"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_templates(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.templates.iter().enumerate().map(|(i, t)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(t["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(t["description"].as_str().unwrap_or("-").to_string()),
            Cell::from(t["model"].as_str().unwrap_or("-").to_string()),
            Cell::from(truncate(t["tools"].as_str().unwrap_or("-"), 25)),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(35),
        Constraint::Percentage(15),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["Name", "Description", "Model", "Tools"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_usage(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let inner = block.inner(area);
    f.render_widget(block, area);

    let data = &app.usage_data;
    if data.is_null() {
        f.render_widget(
            Paragraph::new("No usage data — press r to refresh")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center),
            inner,
        );
        return;
    }

    let requests = data["requests"].as_u64().unwrap_or(0);
    let tokens_in = data["tokens"]["input"].as_u64().unwrap_or(0);
    let tokens_out = data["tokens"]["output"].as_u64().unwrap_or(0);
    let tokens_total = data["tokens"]["total"].as_u64().unwrap_or(0);
    let cost = data["cost"].as_f64().unwrap_or(0.0);
    let agents = data["agents"].as_u64().unwrap_or(0);
    let sessions = data["sessions"].as_u64().unwrap_or(0);

    let metrics = [
        ("Requests", requests),
        ("Total Tokens", tokens_total),
        ("Input Tokens", tokens_in),
        ("Output Tokens", tokens_out),
        ("Agents", agents),
        ("Sessions", sessions),
    ];

    let max_val = metrics.iter().map(|(_, v)| *v).max().unwrap_or(1).max(1);
    let bar_width = inner.width.saturating_sub(25) as u64;

    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled("Usage Overview", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(format!("  Total Cost: ${:.4}", cost)),
        Line::from(""),
    ];

    for (label, val) in &metrics {
        let width = ((*val as f64 / max_val as f64) * bar_width as f64).round() as usize;
        let bar = "\u{2588}".repeat(width.max(1));
        lines.push(Line::from(vec![
            Span::styled(format!("{:>15} ", label), Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(bar, Style::default().fg(Color::Cyan)),
            Span::raw(format!(" {}", val)),
        ]));
    }

    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_settings(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.settings.iter().enumerate().map(|(i, (k, v))| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(k.as_str()),
            Cell::from(v.as_str()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(40),
        Constraint::Percentage(60),
    ])
    .header(Row::new(["Key", "Value"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_wizard(f: &mut Frame, app: &App, area: Rect) {
    let step_labels = [
        "API Key", "Model Provider", "Workspace Name",
        "Integrations", "Security Level", "Confirm",
    ];
    let step_hints = [
        "Enter your API key (e.g. sk-...)",
        "Choose provider: anthropic, openai, openrouter",
        "Name for this workspace",
        "Comma-separated: slack, github, linear",
        "Level: standard, strict, paranoid",
        "Press Enter to finalize setup",
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" Setup Wizard ({}/6) ", app.wizard_step + 1))
        .border_style(Style::default().fg(Color::Cyan));

    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled("AgentOS Setup Wizard", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(""),
    ];

    for (i, label) in step_labels.iter().enumerate() {
        let (marker, style) = if i < app.wizard_step {
            ("[x]", Style::default().fg(Color::Green))
        } else if i == app.wizard_step {
            ("[>]", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        } else {
            ("[ ]", Style::default().fg(Color::DarkGray))
        };
        let val = if i < app.wizard_values.len() && !app.wizard_values[i].is_empty() {
            if i == 0 { "****".to_string() } else { app.wizard_values[i].clone() }
        } else {
            String::new()
        };
        lines.push(Line::from(vec![
            Span::styled(format!("  {} ", marker), style),
            Span::styled(format!("{}: ", label), style),
            Span::raw(val),
        ]));
    }

    lines.push(Line::from(""));
    if app.wizard_step < step_hints.len() {
        lines.push(Line::from(Span::styled(
            format!("  Hint: {}", step_hints[app.wizard_step]),
            Style::default().fg(Color::DarkGray),
        )));

        if app.wizard_step < app.wizard_values.len() {
            lines.push(Line::from(""));
            lines.push(Line::from(format!("  > {}_", app.wizard_values[app.wizard_step])));
        }
    }

    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_workflow_builder(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let inner = block.inner(area);
    f.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(0)])
        .split(inner);

    let header = Line::from(vec![
        Span::styled("Workflow Builder", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(format!("  ({} steps)", app.wf_builder_steps.len())),
    ]);
    f.render_widget(Paragraph::new(vec![header, Line::from("")]), chunks[0]);

    if app.wf_builder_steps.is_empty() {
        f.render_widget(
            Paragraph::new("  No steps yet. Press '+' to add a step.")
                .style(Style::default().fg(Color::DarkGray)),
            chunks[1],
        );
        return;
    }

    let rows: Vec<Row> = app.wf_builder_steps.iter().enumerate().map(|(i, step)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(format!("{}", i + 1)),
            Cell::from(step.as_str()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Length(5),
        Constraint::Min(0),
    ])
    .header(Row::new(["#", "Function ID"]).style(Style::default().add_modifier(Modifier::BOLD)));

    f.render_widget(table, chunks[1]);
}

fn draw_lifecycle(f: &mut Frame, app: &App, block: Block, area: Rect) {
    if app.lifecycle_states.is_empty() {
        let inner = block.inner(area);
        f.render_widget(block, area);
        f.render_widget(
            Paragraph::new("  No lifecycle data. Press 'r' to refresh.")
                .style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    }

    let rows: Vec<Row> = app.lifecycle_states.iter().enumerate().map(|(i, s)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let agent = s["agentId"].as_str().or(s["agent"].as_str()).unwrap_or("-");
        let state = s["state"].as_str().or(s["status"].as_str()).unwrap_or("-");
        let previous = s["previous"].as_str().or(s["previousState"].as_str()).unwrap_or("-");
        let reason = s["reason"].as_str().unwrap_or("-");
        let since = s["since"].as_str().or(s["timestamp"].as_str()).or(s["updatedAt"].as_str()).unwrap_or("-");

        let state_color = match state {
            "working" => Color::Green,
            "blocked" => Color::Yellow,
            "failed" => Color::Red,
            "done" => Color::DarkGray,
            "spawning" => Color::Blue,
            "recovering" => Color::Magenta,
            _ => Color::White,
        };

        Row::new(vec![
            Cell::from(agent.to_string()),
            Cell::from(Span::styled(state.to_string(), Style::default().fg(state_color))),
            Cell::from(previous.to_string()),
            Cell::from(truncate(reason, 25)),
            Cell::from(since.to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(15),
        Constraint::Percentage(15),
        Constraint::Percentage(25),
        Constraint::Percentage(25),
    ])
    .header(Row::new(["Agent", "State", "Previous", "Reason", "Since"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_tasks(f: &mut Frame, app: &App, block: Block, area: Rect) {
    if app.task_tree.is_empty() {
        let inner = block.inner(area);
        f.render_widget(block, area);
        f.render_widget(
            Paragraph::new("  No tasks. Press 'r' to refresh.")
                .style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    }

    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = vec![];
    for (i, task) in app.task_tree.iter().enumerate() {
        let task_id = task["id"].as_str().unwrap_or("");
        let task_name = task["name"].as_str().or(task["description"].as_str()).unwrap_or("-");
        let task_status = task["status"].as_str().unwrap_or("pending");

        let depth = task_id.matches('.').count();

        if depth > 0 {
            let mut hidden = false;
            let mut ancestor = task_id.to_string();
            while let Some(pos) = ancestor.rfind('.') {
                ancestor.truncate(pos);
                if !app.task_expanded.contains(ancestor.as_str()) {
                    hidden = true;
                    break;
                }
            }
            if hidden { continue; }
        }
        let indent = "  ".repeat(depth);

        let status_icon = match task_status {
            "complete" | "completed" | "done" => "\u{2713}",
            "in_progress" | "running" | "active" => "\u{27f3}",
            "pending" | "waiting" => "\u{25cb}",
            "failed" | "error" => "\u{2717}",
            "blocked" => "\u{25aa}",
            _ => "\u{25cb}",
        };

        let status_color = match task_status {
            "complete" | "completed" | "done" => Color::Green,
            "in_progress" | "running" | "active" => Color::Cyan,
            "pending" | "waiting" => Color::White,
            "failed" | "error" => Color::Red,
            "blocked" => Color::Yellow,
            _ => Color::White,
        };

        let is_selected = i == app.selected;
        let row_style = if is_selected { Style::default().bg(Color::DarkGray) } else { Style::default() };

        let is_expanded = app.task_expanded.contains(task_id);
        let expand_marker = if depth == 0 && app.task_tree.iter().any(|t| {
            t["id"].as_str().unwrap_or("").starts_with(&format!("{}.", task_id))
        }) {
            if is_expanded { "\u{25bc} " } else { "\u{25b6} " }
        } else {
            "  "
        };

        lines.push(Line::from(vec![
            Span::raw(format!("{}{}", indent, expand_marker)),
            Span::styled(format!("{} ", status_icon), Style::default().fg(status_color)),
            Span::styled(format!("{}", task_id), Style::default().fg(Color::DarkGray)),
            Span::raw(format!(" \u{2014} {}", task_name)),
        ]).style(row_style));
    }

    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_recovery(f: &mut Frame, app: &App, block: Block, area: Rect) {
    if app.recovery_report.is_null() {
        let inner = block.inner(area);
        f.render_widget(block, area);
        f.render_widget(
            Paragraph::new("  No recovery data. Press 'r' to refresh.")
                .style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    }

    let inner = block.inner(area);
    f.render_widget(block, area);

    let agents_data = app.recovery_report["agents"].as_array()
        .or_else(|| app.recovery_report["results"].as_array())
        .cloned()
        .unwrap_or_default();

    let mut healthy_count = 0u64;
    let mut degraded_count = 0u64;
    let mut dead_count = 0u64;
    let mut unrecoverable_count = 0u64;

    for agent in &agents_data {
        match agent["classification"].as_str().or(agent["status"].as_str()).unwrap_or("") {
            "healthy" => healthy_count += 1,
            "degraded" => degraded_count += 1,
            "dead" => dead_count += 1,
            "unrecoverable" => unrecoverable_count += 1,
            _ => {}
        }
    }

    let summary_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0)])
        .split(inner);

    let summary = Line::from(vec![
        Span::styled(format!("  {} healthy", healthy_count), Style::default().fg(Color::Green)),
        Span::raw(" | "),
        Span::styled(format!("{} degraded", degraded_count), Style::default().fg(Color::Yellow)),
        Span::raw(" | "),
        Span::styled(format!("{} dead", dead_count), Style::default().fg(Color::Red)),
        Span::raw(" | "),
        Span::styled(format!("{} unrecoverable", unrecoverable_count), Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(vec![summary, Line::from("")]), summary_chunks[0]);

    let rows: Vec<Row> = agents_data.iter().map(|agent| {
        let name = agent["agent"].as_str().or(agent["agentId"].as_str()).or(agent["name"].as_str()).unwrap_or("-");
        let classification = agent["classification"].as_str().or(agent["status"].as_str()).unwrap_or("-");
        let last_activity = agent["lastActivity"].as_str().or(agent["lastSeen"].as_str()).unwrap_or("-");
        let circuit = agent["circuitBreaker"].as_str()
            .unwrap_or(if agent["circuitBreaker"].is_object() { "configured" } else { "-" });
        let memory = agent["memory"].as_str()
            .unwrap_or(if agent["memory"].is_object() { "active" } else { "-" });

        let class_color = match classification {
            "healthy" => Color::Green,
            "degraded" => Color::Yellow,
            "dead" => Color::Red,
            "unrecoverable" => Color::DarkGray,
            _ => Color::White,
        };

        Row::new(vec![
            Cell::from(name.to_string()),
            Cell::from(Span::styled(classification.to_string(), Style::default().fg(class_color))),
            Cell::from(last_activity.to_string()),
            Cell::from(circuit.to_string()),
            Cell::from(memory.to_string()),
        ])
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(18),
        Constraint::Percentage(22),
        Constraint::Percentage(20),
        Constraint::Percentage(20),
    ])
    .header(Row::new(["Agent", "Classification", "Last Activity", "Circuit Breaker", "Memory"]).style(Style::default().add_modifier(Modifier::BOLD)));

    f.render_widget(table, summary_chunks[1]);
}

fn draw_orchestrator(f: &mut Frame, app: &App, block: Block, area: Rect) {
    if app.orchestrator_plans.is_empty() {
        let inner = block.inner(area);
        f.render_widget(block, area);
        f.render_widget(
            Paragraph::new("  No orchestrator plans. Press 'r' to refresh.")
                .style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    }

    let inner = block.inner(area);
    f.render_widget(block, area);

    let has_selected = app.selected < app.orchestrator_plans.len();

    let orch_chunks = if has_selected {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(0), Constraint::Length(4)])
            .split(inner)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(0)])
            .split(inner)
    };

    let rows: Vec<Row> = app.orchestrator_plans.iter().enumerate().map(|(i, plan)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let id = plan["id"].as_str().unwrap_or("-");
        let desc = plan["description"].as_str().or(plan["name"].as_str()).unwrap_or("-");
        let status = plan["status"].as_str().unwrap_or("-");
        let workers = plan["workers"].as_u64()
            .or_else(|| plan["workers"].as_array().map(|a| a.len() as u64))
            .unwrap_or(0);
        let created = plan["created"].as_str().or(plan["createdAt"].as_str()).unwrap_or("-");

        let status_color = match status {
            "planned" => Color::Blue,
            "executing" | "running" => Color::Yellow,
            "completed" | "done" => Color::Green,
            "failed" => Color::Red,
            "paused" => Color::DarkGray,
            _ => Color::White,
        };

        Row::new(vec![
            Cell::from(truncate(id, 15)),
            Cell::from(truncate(desc, 25)),
            Cell::from(Span::styled(status.to_string(), Style::default().fg(status_color))),
            Cell::from(format!("{}", workers)),
            Cell::from(created.to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(15),
        Constraint::Percentage(30),
        Constraint::Percentage(15),
        Constraint::Percentage(10),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["ID", "Description", "Status", "Workers", "Created"]).style(Style::default().add_modifier(Modifier::BOLD)));

    f.render_widget(table, orch_chunks[0]);

    if has_selected && orch_chunks.len() > 1 {
        let plan = &app.orchestrator_plans[app.selected];
        let total = plan["totalTasks"].as_u64()
            .or_else(|| plan["tasks"].as_array().map(|a| a.len() as u64))
            .unwrap_or(0);
        let completed = plan["completedTasks"].as_u64().unwrap_or(0);
        let pct = if total > 0 { (completed as f64 / total as f64 * 100.0) as u16 } else { 0 };

        let progress_bar = format!(
            "  Progress: {}/{} tasks ({}%)",
            completed, total, pct
        );
        let bar_width = orch_chunks[1].width.saturating_sub(4) as usize;
        let filled = if total > 0 { (completed as usize * bar_width) / total as usize } else { 0 };
        let empty = bar_width.saturating_sub(filled);
        let bar_line = format!("  {}{}", "\u{2588}".repeat(filled), "\u{2591}".repeat(empty));

        let progress_lines = vec![
            Line::from(progress_bar),
            Line::from(Span::styled(bar_line, Style::default().fg(Color::Cyan))),
        ];
        f.render_widget(Paragraph::new(progress_lines), orch_chunks[1]);
    }
}

fn default_templates() -> Vec<Value> {
    vec![
        serde_json::json!({"name": "analyst", "description": "Data analysis agent", "model": "opus", "tools": "web_search, file_read"}),
        serde_json::json!({"name": "architect", "description": "System design agent", "model": "opus", "tools": "file_*, code_*"}),
        serde_json::json!({"name": "assistant", "description": "General assistant", "model": "sonnet", "tools": "web_*, memory_*"}),
        serde_json::json!({"name": "code-reviewer", "description": "Code review agent", "model": "opus", "tools": "file_read, code_*"}),
        serde_json::json!({"name": "coder", "description": "Software engineer", "model": "opus", "tools": "file_*, shell_exec, code_*"}),
        serde_json::json!({"name": "debugger", "description": "Debugging agent", "model": "opus", "tools": "file_*, shell_exec, code_*"}),
        serde_json::json!({"name": "orchestrator", "description": "Multi-agent orchestrator", "model": "opus", "tools": "agent_*, memory_*"}),
        serde_json::json!({"name": "researcher", "description": "Research agent", "model": "opus", "tools": "web_*, browser_*, memory_*"}),
        serde_json::json!({"name": "security-auditor", "description": "Security audit agent", "model": "opus", "tools": "file_*, shell_exec"}),
        serde_json::json!({"name": "writer", "description": "Content writer", "model": "sonnet", "tools": "web_search, file_*"}),
    ]
}

fn status_cell(status: &str) -> Span<'_> {
    match status {
        "active" | "connected" | "running" | "healthy" | "ready" => Span::styled(status, Style::default().fg(Color::Green)),
        "inactive" | "disconnected" | "stopped" | "paused" => Span::styled(status, Style::default().fg(Color::Red)),
        "pending" | "waiting" | "idle" => Span::styled(status, Style::default().fg(Color::Yellow)),
        _ => Span::raw(status),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let char_count = s.chars().count();
    if char_count <= max {
        return s.to_string();
    }
    if max < 3 {
        return s.chars().take(max).collect();
    }
    let take = max - 3;
    let truncated: String = s.chars().take(take).collect();
    format!("{}...", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screen_all_count() {
        assert_eq!(Screen::all().len(), 25);
    }

    #[test]
    fn test_screen_labels_unique() {
        let labels: Vec<&str> = Screen::all().iter().map(|s| s.label()).collect();
        let mut deduped = labels.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(labels.len(), deduped.len());
    }

    #[test]
    fn test_all_screens_have_keys() {
        for screen in Screen::all() {
            assert!(!screen.key().is_empty(), "Screen {:?} has no key", screen);
        }
    }

    #[test]
    fn test_screen_keys_unique() {
        let keys: Vec<&str> = Screen::all().iter().map(|s| s.key()).collect();
        let mut deduped = keys.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(keys.len(), deduped.len(), "Duplicate keys found");
    }

    #[test]
    fn test_screen_dashboard_key() {
        assert_eq!(Screen::Dashboard.key(), "1");
    }

    #[test]
    fn test_screen_memory_key() {
        assert_eq!(Screen::Memory.key(), "m");
    }

    #[test]
    fn test_screen_audit_key() {
        assert_eq!(Screen::Audit.key(), "a");
    }

    #[test]
    fn test_screen_security_key() {
        assert_eq!(Screen::Security.key(), "s");
    }

    #[test]
    fn test_truncate_short_string() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_exact_length() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_long_string() {
        assert_eq!(truncate("hello world foo", 10), "hello w...");
    }

    #[test]
    fn test_truncate_empty() {
        assert_eq!(truncate("", 10), "");
    }

    #[test]
    fn test_truncate_zero_max() {
        assert_eq!(truncate("hello", 0), "");
    }

    #[test]
    fn test_status_cell_active() {
        let span = status_cell("active");
        assert_eq!(span.content.as_ref(), "active");
    }

    #[test]
    fn test_status_cell_ready() {
        let span = status_cell("ready");
        assert_eq!(span.content.as_ref(), "ready");
    }

    #[test]
    fn test_status_cell_pending() {
        let span = status_cell("pending");
        assert_eq!(span.content.as_ref(), "pending");
    }

    #[test]
    fn test_app_new_defaults() {
        let app = App::new();
        assert_eq!(app.screen, Screen::Chat);
        assert_eq!(app.selected, 0);
        assert!(!app.healthy);
        assert!(app.agents.is_empty());
        assert!(app.running);
        assert_eq!(app.vim_mode, VimMode::Insert);
        assert!(!app.spinner_active);
        assert!(!app.chat_streaming);
        assert!(app.task_tree.is_empty());
        assert!(app.lifecycle_states.is_empty());
        assert!(app.orchestrator_plans.is_empty());
        assert!(!app.approval_mode);
        assert!(app.pending_chord.is_none());
        assert!(app.show_first_run);
        assert!(!app.show_help);
        assert!(!app.show_palette);
    }

    #[test]
    fn test_chat_realm_default() {
        let app = App::new();
        assert_eq!(app.chat_realm, "default");
    }

    #[test]
    fn test_palette_items_cover_all_screens() {
        let app = App::new();
        let items = app.palette_items();
        assert_eq!(items.len(), Screen::all().len());
    }

    #[test]
    fn test_default_templates_not_empty() {
        assert!(!default_templates().is_empty());
    }

    #[test]
    fn test_workflow_builder_label_fits_nav() {
        assert!(Screen::WorkflowBuilder.label().len() <= 16);
    }

    #[test]
    fn test_parse_chat_response_json_object() {
        let s = parse_chat_response(r#"{"content":"hello world"}"#);
        assert_eq!(s, "hello world");
    }

    #[test]
    fn test_parse_chat_response_sse_deltas() {
        let frames = "data: {\"choices\":[{\"delta\":{\"content\":\"foo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" bar\"}}]}\n\ndata: [DONE]\n\n";
        assert_eq!(parse_chat_response(frames), "foo bar");
    }

    #[test]
    fn test_parse_chat_response_falls_back_to_raw() {
        let s = parse_chat_response("plain text response");
        assert!(s.starts_with("plain text"));
    }

    #[test]
    fn test_builtin_registry_fns_includes_core_namespaces() {
        assert!(slash::BUILTIN_REGISTRY_FNS.contains(&"agent::chat"));
        assert!(slash::BUILTIN_REGISTRY_FNS.contains(&"memory::recall"));
        assert!(slash::BUILTIN_REGISTRY_FNS.contains(&"approval::decide"));
    }

    #[test]
    fn test_builtin_catalog_has_every_workspace_worker() {
        let cards = worker_picker::builtin_catalog();
        assert!(cards.len() >= 60, "catalog should cover ~64 narrow workers, got {}", cards.len());
        let names: std::collections::HashSet<_> = cards.iter().map(|c| c.name.as_str()).collect();
        for required in ["memory", "browser", "llm-router", "agent-core", "approval"] {
            assert!(names.contains(required), "missing {}", required);
        }
    }

    #[tokio::test]
    #[ignore = "requires live iii engine on :3111"]
    async fn live_refresh_health_against_engine() {
        if std::env::var("AGENTOS_LIVE_TEST").is_err() {
            return;
        }
        let mut app = App::new();
        app.refresh_health().await;
        assert!(app.healthy, "refresh_health failed: status={}, err={:?}", app.status, app.last_error);
        assert!(app.worker_count >= 1);
    }

    #[tokio::test]
    #[ignore = "requires live iii engine + memory worker"]
    async fn live_remember_then_recall() {
        if std::env::var("AGENTOS_LIVE_TEST").is_err() {
            return;
        }
        let mut app = App::new();
        app.chat_realm = format!("tui-test-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        app.handle_slash(slash::Parsed::Cmd { name: "remember".into(), args: "the sky is blue".into() }).await;
        app.handle_slash(slash::Parsed::Cmd { name: "memory".into(), args: "sky".into() }).await;
        let last = app.chat_messages.last().expect("expected at least one chat message");
        assert!(last.0 == "assistant" || last.0 == "system",
            "unexpected role {:?}, msg {:?}", last.0, last.1);
    }

    #[test]
    fn test_text_input_screens() {
        assert!(Screen::Chat.is_text_input());
        assert!(Screen::Wizard.is_text_input());
        assert!(!Screen::Dashboard.is_text_input());
    }

    #[test]
    fn test_vim_mode_default() {
        let app = App::new();
        assert_eq!(app.vim_mode, VimMode::Insert);
    }

    #[test]
    fn test_spinner_frames_not_empty() {
        assert!(!SPINNER_FRAMES.is_empty());
        assert_eq!(SPINNER_FRAMES.len(), 10);
    }

    #[test]
    fn test_spinner_interval() {
        assert_eq!(SPINNER_INTERVAL_MS, 80);
    }
}

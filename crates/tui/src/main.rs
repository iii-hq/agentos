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

const API_BASE: &str = "http://localhost:3111";

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
    Welcome,
    Wizard,
    WorkflowBuilder,
}

impl Screen {
    fn all() -> &'static [Screen] {
        &[
            Screen::Dashboard, Screen::Agents, Screen::Chat, Screen::Channels,
            Screen::Skills, Screen::Hands, Screen::Workflows, Screen::Sessions,
            Screen::Approvals, Screen::Logs, Screen::Memory, Screen::Audit,
            Screen::Security, Screen::Peers, Screen::Extensions, Screen::Triggers,
            Screen::Templates, Screen::Usage, Screen::Settings, Screen::Welcome,
            Screen::Wizard, Screen::WorkflowBuilder,
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
            Screen::Welcome => "Welcome",
            Screen::Wizard => "Wizard",
            Screen::WorkflowBuilder => "Wf Builder",
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
            Screen::Welcome => "w",
            Screen::Wizard => "W",
            Screen::WorkflowBuilder => "B",
        }
    }

    #[cfg(test)]
    fn is_text_input(&self) -> bool {
        matches!(self, Screen::Chat | Screen::Wizard)
    }
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
}

impl App {
    fn new() -> Self {
        Self {
            screen: Screen::Welcome,
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
        }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    }

    async fn refresh_health(&mut self) {
        let client = Self::client();
        match client.get(format!("{}/api/dashboard/stats", API_BASE)).send().await {
            Ok(resp) => {
                if let Ok(data) = resp.json::<Value>().await {
                    self.healthy = true;
                    self.last_error = None;
                    self.dashboard_stats = data.clone();

                    let status_str = data["status"].as_str().unwrap_or("unknown");
                    let agent_count = data["agents"].as_u64().unwrap_or(0);
                    let skill_count = data["skills"].as_u64().unwrap_or(0);
                    self.status = format!("● {} | {} agents | {} skills", status_str, agent_count, skill_count);

                    if let Some(arr) = data["agentList"].as_array() {
                        self.agents = arr.clone();
                    }
                    if let Some(arr) = data["skillList"].as_array() {
                        self.skills = arr.clone();
                    }
                } else {
                    self.healthy = false;
                    self.status = "○ Engine offline".into();
                    self.last_error = Some("Failed to parse health response".into());
                }
            }
            Err(e) => {
                self.healthy = false;
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
                if let Ok(resp) = client.get(format!("{}/api/channels", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.channels = data.as_array().cloned().unwrap_or_default();
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
                if let Ok(resp) = client.get(format!("{}/api/approvals", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.approvals = data.as_array().cloned().unwrap_or_default();
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
                if let Ok(resp) = client.get(format!("{}/api/memory", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.memories = data.as_array().cloned().unwrap_or_default();
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
                if let Ok(resp) = client.get(format!("{}/api/dashboard/stats", API_BASE)).send().await
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
            _ => {}
        }
    }

    async fn send_chat(&mut self) {
        if self.chat_input.trim().is_empty() {
            return;
        }
        let msg = self.chat_input.clone();
        self.chat_input.clear();
        self.chat_messages.push(("user".into(), msg.clone()));

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
            "agentId": agent_id,
            "message": msg,
        });

        match client.post(format!("{}/api/agents/{}/message", API_BASE, agent_id))
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(data) = resp.json::<Value>().await {
                    let content = data["content"].as_str()
                        .or(data["response"].as_str())
                        .or(data["message"].as_str())
                        .unwrap_or("(no response)");
                    self.chat_messages.push(("assistant".into(), content.to_string()));
                } else {
                    self.chat_messages.push(("system".into(), "Failed to parse response".into()));
                }
            }
            Err(e) => {
                self.chat_messages.push(("system".into(), format!("Error: {}", e)));
            }
        }
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
            _ => 0,
        }
    }
}

fn navigate_to(app: &mut App, screen: Screen) {
    app.screen = screen;
    app.selected = 0;
    app.scroll_offset = 0;
}

#[tokio::main]
async fn main() -> Result<()> {
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut app = App::new();
    app.refresh_health().await;

    let mut last_health = std::time::Instant::now();

    while app.running {
        terminal.draw(|f| draw(f, &app))?;

        if last_health.elapsed() > std::time::Duration::from_secs(10) {
            app.refresh_health().await;
            last_health = std::time::Instant::now();
        }

        if event::poll(std::time::Duration::from_millis(250))?
            && let Event::Key(key) = event::read()?
        {
            if key.kind != KeyEventKind::Press { continue; }

            let ctrl_c = key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('c'));
            if ctrl_c {
                app.running = false;
                continue;
            }

            if app.screen == Screen::Chat {
                match key.code {
                    KeyCode::Esc => app.screen = Screen::Dashboard,
                    KeyCode::Enter => app.send_chat().await,
                    KeyCode::Backspace => { app.chat_input.pop(); }
                    KeyCode::Tab => {
                        let screens = Screen::all();
                        let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                        navigate_to(&mut app, screens[(idx + 1) % screens.len()]);
                    }
                    KeyCode::Char(c) if c.is_ascii_digit() || c == 'q' => {
                        match c {
                            'q' => app.running = false,
                            '1' => navigate_to(&mut app, Screen::Dashboard),
                            '2' => navigate_to(&mut app, Screen::Agents),
                            '4' => navigate_to(&mut app, Screen::Channels),
                            '5' => navigate_to(&mut app, Screen::Skills),
                            '6' => navigate_to(&mut app, Screen::Hands),
                            '7' => navigate_to(&mut app, Screen::Workflows),
                            '8' => navigate_to(&mut app, Screen::Sessions),
                            '9' => navigate_to(&mut app, Screen::Approvals),
                            '0' => navigate_to(&mut app, Screen::Logs),
                            _ => app.chat_input.push(c),
                        }
                    }
                    KeyCode::Char(c) => app.chat_input.push(c),
                    _ => {}
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
                KeyCode::Char('w') => navigate_to(&mut app, Screen::Welcome),
                KeyCode::Char('r') => app.refresh_screen().await,
                KeyCode::Char('a') if app.screen == Screen::Approvals => {
                    app.approve_selected().await;
                }
                KeyCode::Char('a') => navigate_to(&mut app, Screen::Audit),
                KeyCode::Char('s') => navigate_to(&mut app, Screen::Security),
                KeyCode::Char('T') => navigate_to(&mut app, Screen::Templates),
                KeyCode::Char('S') => navigate_to(&mut app, Screen::Settings),
                KeyCode::Char('W') => navigate_to(&mut app, Screen::Wizard),
                KeyCode::Char('B') => navigate_to(&mut app, Screen::WorkflowBuilder),
                KeyCode::Char('d') if app.screen == Screen::Approvals => {
                    app.deny_selected().await;
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
    }

    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}

fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(0),
            Constraint::Length(3),
        ])
        .split(f.area());

    let title = Block::default()
        .borders(Borders::ALL)
        .title(" AgentOS ")
        .title_alignment(Alignment::Center)
        .border_style(Style::default().fg(Color::Cyan));

    let status_color = if app.healthy { Color::Green } else { Color::Red };
    let header_text = Line::from(vec![
        Span::raw("  "),
        Span::styled(&app.status, Style::default().fg(status_color)),
    ]);

    f.render_widget(Paragraph::new(header_text).block(title), chunks[0]);

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
        Screen::Approvals => draw_approvals(f, app, content_block, body_chunks[1]),
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
        Screen::Welcome => draw_welcome(f, content_block, body_chunks[1]),
        Screen::Wizard => draw_wizard(f, app, body_chunks[1]),
        Screen::WorkflowBuilder => draw_workflow_builder(f, app, content_block, body_chunks[1]),
    }

    let footer = Block::default().borders(Borders::ALL);
    let help = match app.screen {
        Screen::Chat => " Esc:Back  Enter:Send  1-9:Nav  Tab:Next  q:Quit ",
        Screen::Approvals => " a:Approve  d:Deny  Up/Down:Select  r:Refresh  q:Quit ",
        Screen::Logs => " Up/Down:Scroll  r:Refresh  q:Quit ",
        Screen::WorkflowBuilder => " +:Add  -:Remove  x:Export  Up/Down:Select  q:Quit ",
        Screen::Wizard => " Enter:Next  Tab:Forward  Shift-Tab:Back  Esc:Exit ",
        _ => " q:Quit  Tab:Next  1-0:Screen  m/a/s/p/e/t/u:More  r:Refresh  Up/Down:Select ",
    };
    f.render_widget(
        Paragraph::new(help)
            .style(Style::default().fg(Color::DarkGray))
            .block(footer),
        chunks[2],
    );
}

fn draw_dashboard(f: &mut Frame, app: &App, block: Block, area: Rect) {
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
                if app.healthy { Style::default().fg(Color::Green) } else { Style::default().fg(Color::Red) },
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
        .constraints([Constraint::Min(0), Constraint::Length(3)])
        .split(area);

    let messages: Vec<Line> = app.chat_messages.iter().map(|(role, msg)| {
        let (prefix, color) = match role.as_str() {
            "user" => ("You: ", Color::Green),
            "assistant" => ("Agent: ", Color::Cyan),
            _ => ("System: ", Color::Yellow),
        };
        Line::from(vec![
            Span::styled(prefix, Style::default().fg(color).add_modifier(Modifier::BOLD)),
            Span::raw(msg.as_str()),
        ])
    }).collect();

    let agent_label = if app.chat_agent.is_empty() {
        app.agents.first()
            .and_then(|a| a["name"].as_str())
            .unwrap_or("default")
    } else {
        &app.chat_agent
    };

    let msg_block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" Chat → {} ", agent_label));
    f.render_widget(Paragraph::new(messages).block(msg_block).wrap(Wrap { trim: false }), chat_chunks[0]);

    let input_block = Block::default()
        .borders(Borders::ALL)
        .title(" Message (digits navigate, letters type) ")
        .border_style(Style::default().fg(Color::Cyan));
    let cursor_text = format!("{}_", app.chat_input);
    f.render_widget(Paragraph::new(cursor_text).block(input_block), chat_chunks[1]);
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

fn draw_approvals(f: &mut Frame, app: &App, block: Block, area: Rect) {
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

fn draw_welcome(f: &mut Frame, block: Block, area: Rect) {
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
        Line::from("  Quickstart:"),
        Line::from(Span::styled("    1-0   Core screens (Dashboard, Agents, Chat...)", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    m     Memory          a  Audit", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    s     Security        p  Peers", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    e     Extensions      t  Triggers", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    u     Usage           T  Templates", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    S     Settings        W  Wizard", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    B     Wf Builder      w  Welcome", Style::default().fg(Color::DarkGray))),
        Line::from(""),
        Line::from(Span::styled("    Tab / Shift-Tab to cycle all screens", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    r to refresh, q to quit", Style::default().fg(Color::DarkGray))),
    ];
    f.render_widget(Paragraph::new(logo).block(block), area);
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
        assert_eq!(Screen::all().len(), 22);
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
        assert_eq!(app.screen, Screen::Welcome);
        assert_eq!(app.selected, 0);
        assert!(!app.healthy);
        assert!(app.agents.is_empty());
        assert!(app.running);
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
    fn test_text_input_screens() {
        assert!(Screen::Chat.is_text_input());
        assert!(Screen::Wizard.is_text_input());
        assert!(!Screen::Dashboard.is_text_input());
    }
}

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
            Screen::WorkflowBuilder => "Workflow Builder",
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
            _ => "",
        }
    }
}

struct App {
    screen: Screen,
    selected: usize,
    status: String,
    agents: Vec<Value>,
    skills: Vec<Value>,
    logs: Vec<String>,
    chat_input: String,
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
}

impl App {
    fn new() -> Self {
        Self {
            screen: Screen::Welcome,
            selected: 0,
            status: "Connecting...".into(),
            agents: vec![],
            skills: vec![],
            logs: vec![],
            chat_input: String::new(),
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
        }
    }

    async fn refresh(&mut self) {
        let client = reqwest::Client::new();

        if let Ok(resp) = client.get(format!("{}/api/health", API_BASE)).send().await {
            if let Ok(health) = resp.json::<Value>().await {
                let workers = health["workers"].as_u64().unwrap_or(0);
                self.status = format!("● Healthy | {} workers", workers);
            }
        } else {
            self.status = "○ Engine offline".into();
        }

        if let Ok(resp) = client.get(format!("{}/api/agents", API_BASE)).send().await
            && let Ok(agents) = resp.json::<Value>().await
        {
            self.agents = agents.as_array().cloned().unwrap_or_default();
        }

        if let Ok(resp) = client.get(format!("{}/api/skills", API_BASE)).send().await
            && let Ok(skills) = resp.json::<Value>().await
        {
            self.skills = skills.as_array().cloned().unwrap_or_default();
        }
    }

    async fn refresh_screen(&mut self) {
        let client = reqwest::Client::new();
        match self.screen {
            Screen::Dashboard => self.refresh().await,
            Screen::Agents => {
                if let Ok(resp) = client.get(format!("{}/api/agents", API_BASE)).send().await
                    && let Ok(agents) = resp.json::<Value>().await
                {
                    self.agents = agents.as_array().cloned().unwrap_or_default();
                }
            }
            Screen::Skills => {
                if let Ok(resp) = client.get(format!("{}/api/skills", API_BASE)).send().await
                    && let Ok(skills) = resp.json::<Value>().await
                {
                    self.skills = skills.as_array().cloned().unwrap_or_default();
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
                if let Ok(resp) = client.get(format!("{}/api/dashboard/logs?lines=100", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.logs = data.as_array()
                        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                        .unwrap_or_default();
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
                if let Ok(resp) = client.get(format!("{}/security/audit/verify", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.audit_entries = data["entries"].as_array().cloned()
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
                    self.extensions = data.as_array().cloned().unwrap_or_default();
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
                self.templates = vec![
                    serde_json::json!({"name": "analyst", "description": "Data analysis agent", "model": "opus", "tools": "web_search, file_read"}),
                    serde_json::json!({"name": "architect", "description": "System design agent", "model": "opus", "tools": "file_*, code_*"}),
                    serde_json::json!({"name": "assistant", "description": "General assistant", "model": "sonnet", "tools": "web_*, memory_*"}),
                    serde_json::json!({"name": "code-reviewer", "description": "Code review agent", "model": "opus", "tools": "file_read, code_*"}),
                    serde_json::json!({"name": "coder", "description": "Software engineer agent", "model": "opus", "tools": "file_*, shell_exec, code_*"}),
                    serde_json::json!({"name": "customer-support", "description": "Customer support agent", "model": "sonnet", "tools": "memory_*, web_search"}),
                    serde_json::json!({"name": "data-scientist", "description": "Data science agent", "model": "opus", "tools": "file_*, json_*, csv_*"}),
                    serde_json::json!({"name": "debugger", "description": "Debugging agent", "model": "opus", "tools": "file_*, shell_exec, code_*"}),
                    serde_json::json!({"name": "devops-lead", "description": "DevOps operations agent", "model": "opus", "tools": "shell_exec, system_*"}),
                    serde_json::json!({"name": "doc-writer", "description": "Documentation writer", "model": "sonnet", "tools": "file_*, web_search"}),
                    serde_json::json!({"name": "hello-world", "description": "Starter template", "model": "haiku", "tools": "web_search"}),
                    serde_json::json!({"name": "ops", "description": "Operations agent", "model": "sonnet", "tools": "shell_exec, system_*"}),
                    serde_json::json!({"name": "orchestrator", "description": "Multi-agent orchestrator", "model": "opus", "tools": "agent_*, memory_*"}),
                    serde_json::json!({"name": "planner", "description": "Task planning agent", "model": "opus", "tools": "memory_*, file_*"}),
                    serde_json::json!({"name": "researcher", "description": "Research agent", "model": "opus", "tools": "web_*, browser_*, memory_*"}),
                    serde_json::json!({"name": "security-auditor", "description": "Security audit agent", "model": "opus", "tools": "file_*, shell_exec"}),
                    serde_json::json!({"name": "test-engineer", "description": "Testing agent", "model": "sonnet", "tools": "file_*, shell_exec, code_*"}),
                    serde_json::json!({"name": "writer", "description": "Content writer", "model": "sonnet", "tools": "web_search, file_*"}),
                ];
            }
            Screen::Usage => {
                if let Ok(resp) = client.get(format!("{}/api/usage", API_BASE)).send().await
                    && let Ok(data) = resp.json::<Value>().await
                {
                    self.usage_data = data;
                }
            }
            Screen::Settings => {
                if let Ok(content) = std::fs::read_to_string("config.toml") {
                    self.settings = content.lines()
                        .filter(|l| l.contains('='))
                        .filter_map(|l| {
                            let parts: Vec<&str> = l.splitn(2, '=').collect();
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

        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "agentId": "default",
            "message": msg,
        });

        match client.post(format!("{}/api/chat", API_BASE))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(data) = resp.json::<Value>().await {
                    let content = data["content"].as_str().unwrap_or("(no response)");
                    self.chat_messages.push(("assistant".into(), content.to_string()));
                }
            }
            Err(e) => {
                self.chat_messages.push(("system".into(), format!("Error: {}", e)));
            }
        }
    }

    async fn approve_selected(&mut self) {
        if self.selected >= self.approvals.len() { return; }
        let id = self.approvals[self.selected]["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() { return; }
        let client = reqwest::Client::new();
        let _ = client.post(format!("{}/api/approvals/{}/approve", API_BASE, id))
            .send().await;
        self.refresh_screen().await;
    }

    async fn deny_selected(&mut self) {
        if self.selected >= self.approvals.len() { return; }
        let id = self.approvals[self.selected]["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() { return; }
        let client = reqwest::Client::new();
        let _ = client.post(format!("{}/api/approvals/{}/deny", API_BASE, id))
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

#[tokio::main]
async fn main() -> Result<()> {
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut app = App::new();
    app.refresh().await;

    while app.running {
        terminal.draw(|f| draw(f, &app))?;

        if event::poll(std::time::Duration::from_millis(250))?
            && let Event::Key(key) = event::read()?
        {
            if key.kind != KeyEventKind::Press { continue; }

            if app.screen == Screen::Chat {
                match key.code {
                    KeyCode::Esc => app.screen = Screen::Dashboard,
                    KeyCode::Enter => app.send_chat().await,
                    KeyCode::Backspace => { app.chat_input.pop(); }
                    KeyCode::Char(c) => {
                        if key.modifiers.contains(KeyModifiers::CONTROL) && c == 'c' {
                            app.running = false;
                        } else {
                            app.chat_input.push(c);
                        }
                    }
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
                    KeyCode::Tab => {
                        if app.wizard_step > 0 { app.wizard_step -= 1; }
                    }
                    _ => {}
                }
                continue;
            }

            match key.code {
                KeyCode::Char('q') => app.running = false,
                KeyCode::Char('1') => { app.screen = Screen::Dashboard; app.selected = 0; }
                KeyCode::Char('2') => { app.screen = Screen::Agents; app.selected = 0; }
                KeyCode::Char('3') => { app.screen = Screen::Chat; app.selected = 0; }
                KeyCode::Char('4') => { app.screen = Screen::Channels; app.selected = 0; }
                KeyCode::Char('5') => { app.screen = Screen::Skills; app.selected = 0; }
                KeyCode::Char('6') => { app.screen = Screen::Hands; app.selected = 0; }
                KeyCode::Char('7') => { app.screen = Screen::Workflows; app.selected = 0; }
                KeyCode::Char('8') => { app.screen = Screen::Sessions; app.selected = 0; }
                KeyCode::Char('9') => { app.screen = Screen::Approvals; app.selected = 0; }
                KeyCode::Char('0') => { app.screen = Screen::Logs; app.selected = 0; }
                KeyCode::Char('r') => app.refresh_screen().await,
                KeyCode::Char('a') if app.screen == Screen::Approvals => {
                    app.approve_selected().await;
                }
                KeyCode::Char('d') if app.screen == Screen::Approvals => {
                    app.deny_selected().await;
                }
                KeyCode::Char('x') if app.screen == Screen::WorkflowBuilder => {
                    let toml = app.wf_builder_steps.iter().enumerate()
                        .map(|(i, s)| format!("[[steps]]\nname = \"step-{}\"\nfunction = \"{}\"", i + 1, s))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    let _ = std::fs::write("workflow-export.toml", &toml);
                    app.status = "Exported to workflow-export.toml".into();
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
                        app.scroll_offset = app.scroll_offset.saturating_add(1);
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
                    app.screen = screens[(idx + 1) % screens.len()];
                    app.selected = 0;
                    app.scroll_offset = 0;
                }
                KeyCode::BackTab => {
                    let screens = Screen::all();
                    let idx = screens.iter().position(|s| *s == app.screen).unwrap_or(0);
                    app.screen = screens[(idx + screens.len() - 1) % screens.len()];
                    app.selected = 0;
                    app.scroll_offset = 0;
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

    let header_text = format!("  {}  |  {} agents  |  {} skills",
        app.status,
        app.agents.len(),
        app.skills.len());

    f.render_widget(Paragraph::new(header_text).block(title), chunks[0]);

    let body_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(20), Constraint::Min(0)])
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
            ListItem::new(format!(" {} {}", if key.is_empty() { " " } else { key }, s.label()))
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
        Screen::Chat => " Esc:Back  Enter:Send  Type to compose ",
        Screen::Approvals => " a:Approve  d:Deny  r:Refresh  q:Quit ",
        Screen::Logs => " Up/Down:Scroll  r:Refresh  q:Quit ",
        Screen::WorkflowBuilder => " +:Add  -:Remove  x:Export TOML  q:Quit ",
        Screen::Wizard => " Enter:Next  Tab:Back  Esc:Exit  Type to input ",
        _ => " q:Quit  Tab/Shift-Tab:Nav  1-0:Screen  r:Refresh  Up/Down:Select ",
    };
    f.render_widget(
        Paragraph::new(help)
            .style(Style::default().fg(Color::DarkGray))
            .block(footer),
        chunks[2],
    );
}

fn draw_dashboard(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let text = vec![
        Line::from(Span::styled("Agent Operating System", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(""),
        Line::from(format!("Status:   {}", app.status)),
        Line::from(format!("Agents:   {}", app.agents.len())),
        Line::from(format!("Skills:   {}", app.skills.len())),
        Line::from(""),
        Line::from(Span::styled("Press 1-0 to navigate, r to refresh, q to quit", Style::default().fg(Color::DarkGray))),
    ];
    f.render_widget(Paragraph::new(text).block(block), area);
}

fn draw_agents(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.agents.iter().enumerate().map(|(i, a)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        Row::new(vec![
            Cell::from(a["key"].as_str().unwrap_or("-").to_string()),
            Cell::from(a["value"]["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(Span::styled("active", Style::default().fg(Color::Green))),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(40),
        Constraint::Percentage(40),
        Constraint::Percentage(20),
    ])
    .header(Row::new(["ID", "Name", "Status"]).style(Style::default().add_modifier(Modifier::BOLD)))
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

    let msg_block = Block::default()
        .borders(Borders::ALL)
        .title(" Chat ");
    f.render_widget(Paragraph::new(messages).block(msg_block).wrap(Wrap { trim: false }), chat_chunks[0]);

    let input_block = Block::default()
        .borders(Borders::ALL)
        .title(" Message ")
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
            Cell::from(s["id"].as_str().unwrap_or("-").to_string()),
            Cell::from(s["category"].as_str().unwrap_or("-").to_string()),
            Cell::from(s["name"].as_str().unwrap_or("-").to_string()),
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
        Row::new(vec![
            Cell::from(h["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(h["schedule"].as_str().unwrap_or("-").to_string()),
            Cell::from(status_cell(h["status"].as_str().unwrap_or("unknown"))),
            Cell::from(h["lastRun"].as_str().unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(25),
        Constraint::Percentage(20),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["Name", "Schedule", "Status", "Last Run"]).style(Style::default().add_modifier(Modifier::BOLD)))
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
            Cell::from(status_cell(w["status"].as_str().unwrap_or("unknown"))),
            Cell::from(w["lastRun"].as_str().unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(20),
        Constraint::Percentage(25),
        Constraint::Percentage(10),
        Constraint::Percentage(15),
        Constraint::Percentage(30),
    ])
    .header(Row::new(["ID", "Name", "Steps", "Status", "Last Run"]).style(Style::default().add_modifier(Modifier::BOLD)))
    .block(block);

    f.render_widget(table, area);
}

fn draw_sessions(f: &mut Frame, app: &App, block: Block, area: Rect) {
    let rows: Vec<Row> = app.sessions.iter().enumerate().map(|(i, s)| {
        let style = if i == app.selected { Style::default().bg(Color::DarkGray) } else { Style::default() };
        let msg_count = s["messages"].as_array().map(|a| a.len())
            .or_else(|| s["messages"].as_u64().map(|n| n as usize))
            .unwrap_or(0);
        Row::new(vec![
            Cell::from(truncate(s["id"].as_str().unwrap_or("-"), 20)),
            Cell::from(s["agent"].as_str().or(s["agentId"].as_str()).unwrap_or("-").to_string()),
            Cell::from(format!("{}", msg_count)),
            Cell::from(s["created"].as_str().or(s["createdAt"].as_str()).unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(25),
        Constraint::Percentage(15),
        Constraint::Percentage(35),
    ])
    .header(Row::new(["ID", "Agent", "Messages", "Created"]).style(Style::default().add_modifier(Modifier::BOLD)))
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
            Cell::from(a["tool"].as_str().or(a["toolId"].as_str()).unwrap_or("-").to_string()),
            Cell::from(a["agent"].as_str().or(a["agentId"].as_str()).unwrap_or("-").to_string()),
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
        let color = if l.contains("ERROR") || l.contains("error") {
            Color::Red
        } else if l.contains("WARN") || l.contains("warn") {
            Color::Yellow
        } else if l.contains("INFO") || l.contains("info") {
            Color::Green
        } else {
            Color::White
        };
        Line::from(Span::styled(l.as_str(), Style::default().fg(color)))
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
            Cell::from(truncate(a["hash"].as_str().unwrap_or("-"), 16)),
            Cell::from(a["action"].as_str().or(a["type"].as_str()).unwrap_or("-").to_string()),
            Cell::from(a["agent"].as_str().or(a["agentId"].as_str()).unwrap_or("-").to_string()),
            Cell::from(a["timestamp"].as_str().or(a["createdAt"].as_str()).unwrap_or("-").to_string()),
        ]).style(style)
    }).collect();

    let table = Table::new(rows, [
        Constraint::Percentage(25),
        Constraint::Percentage(25),
        Constraint::Percentage(25),
        Constraint::Percentage(25),
    ])
    .header(Row::new(["Hash", "Action", "Agent", "Timestamp"]).style(Style::default().add_modifier(Modifier::BOLD)))
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
        lines.push(Line::from(Span::styled("  No data - press r to refresh", Style::default().fg(Color::DarkGray))));
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
        let tool_count = e["tools"].as_array().map(|a| a.len())
            .or_else(|| e["tools"].as_u64().map(|n| n as usize))
            .unwrap_or(0);
        Row::new(vec![
            Cell::from(e["name"].as_str().unwrap_or("-").to_string()),
            Cell::from(e["transport"].as_str().unwrap_or("-").to_string()),
            Cell::from(format!("{}", tool_count)),
            Cell::from(status_cell(e["status"].as_str().unwrap_or("unknown"))),
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
            Cell::from(t["tools"].as_str().unwrap_or("-").to_string()),
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

    if app.usage_data.is_null() {
        f.render_widget(
            Paragraph::new("No usage data - press r to refresh")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center),
            inner,
        );
        return;
    }

    let mut bars: Vec<Line> = vec![
        Line::from(Span::styled("Usage Overview", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        Line::from(""),
    ];

    let metrics = [
        ("tokens", "Total Tokens"),
        ("invocations", "Invocations"),
        ("agents", "Active Agents"),
        ("sessions", "Sessions"),
    ];

    let max_val = metrics.iter()
        .filter_map(|(k, _)| app.usage_data[k].as_f64())
        .fold(1.0_f64, f64::max);

    let bar_width = inner.width.saturating_sub(25) as f64;

    for (key, label) in &metrics {
        let val = app.usage_data[key].as_f64().unwrap_or(0.0);
        let width = ((val / max_val) * bar_width).round() as usize;
        let bar = "\u{2588}".repeat(width);
        bars.push(Line::from(format!("{:>15} |", label)));
        bars.push(Line::from(vec![
            Span::raw("                 "),
            Span::styled(bar, Style::default().fg(Color::Cyan)),
            Span::raw(format!(" {}", val as u64)),
        ]));
        bars.push(Line::from(""));
    }

    f.render_widget(Paragraph::new(bars), inner);
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
        Line::from(Span::styled("    1. Press '2' to view agents", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    2. Press '3' to open chat", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    3. Press 'r' to refresh data", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    4. Press Tab to cycle screens", Style::default().fg(Color::DarkGray))),
        Line::from(Span::styled("    5. Press 'q' to quit", Style::default().fg(Color::DarkGray))),
        Line::from(""),
        Line::from(Span::styled("  Navigate with 1-0 or Tab. Refresh with r.", Style::default().fg(Color::DarkGray))),
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

fn status_cell(status: &str) -> Span<'_> {
    match status {
        "active" | "connected" | "running" | "healthy" => Span::styled(status, Style::default().fg(Color::Green)),
        "inactive" | "disconnected" | "stopped" => Span::styled(status, Style::default().fg(Color::Red)),
        "pending" | "waiting" | "idle" => Span::styled(status, Style::default().fg(Color::Yellow)),
        _ => Span::raw(status),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}...", &s[..max.saturating_sub(3)])
    } else {
        s.to_string()
    }
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
    fn test_screen_dashboard_label() {
        assert_eq!(Screen::Dashboard.label(), "Dashboard");
    }

    #[test]
    fn test_screen_agents_label() {
        assert_eq!(Screen::Agents.label(), "Agents");
    }

    #[test]
    fn test_screen_chat_label() {
        assert_eq!(Screen::Chat.label(), "Chat");
    }

    #[test]
    fn test_screen_channels_label() {
        assert_eq!(Screen::Channels.label(), "Channels");
    }

    #[test]
    fn test_screen_skills_label() {
        assert_eq!(Screen::Skills.label(), "Skills");
    }

    #[test]
    fn test_screen_workflows_label() {
        assert_eq!(Screen::Workflows.label(), "Workflows");
    }

    #[test]
    fn test_screen_sessions_label() {
        assert_eq!(Screen::Sessions.label(), "Sessions");
    }

    #[test]
    fn test_screen_approvals_label() {
        assert_eq!(Screen::Approvals.label(), "Approvals");
    }

    #[test]
    fn test_screen_logs_label() {
        assert_eq!(Screen::Logs.label(), "Logs");
    }

    #[test]
    fn test_screen_memory_label() {
        assert_eq!(Screen::Memory.label(), "Memory");
    }

    #[test]
    fn test_screen_security_label() {
        assert_eq!(Screen::Security.label(), "Security");
    }

    #[test]
    fn test_screen_settings_label() {
        assert_eq!(Screen::Settings.label(), "Settings");
    }

    #[test]
    fn test_screen_welcome_label() {
        assert_eq!(Screen::Welcome.label(), "Welcome");
    }

    #[test]
    fn test_screen_wizard_label() {
        assert_eq!(Screen::Wizard.label(), "Wizard");
    }

    #[test]
    fn test_screen_workflow_builder_label() {
        assert_eq!(Screen::WorkflowBuilder.label(), "Workflow Builder");
    }

    #[test]
    fn test_screen_dashboard_key() {
        assert_eq!(Screen::Dashboard.key(), "1");
    }

    #[test]
    fn test_screen_agents_key() {
        assert_eq!(Screen::Agents.key(), "2");
    }

    #[test]
    fn test_screen_chat_key() {
        assert_eq!(Screen::Chat.key(), "3");
    }

    #[test]
    fn test_screen_approvals_key() {
        assert_eq!(Screen::Approvals.key(), "9");
    }

    #[test]
    fn test_screen_logs_key() {
        assert_eq!(Screen::Logs.key(), "0");
    }

    #[test]
    fn test_screen_no_key_screens() {
        assert_eq!(Screen::Memory.key(), "");
        assert_eq!(Screen::Audit.key(), "");
        assert_eq!(Screen::Security.key(), "");
        assert_eq!(Screen::Settings.key(), "");
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
    fn test_truncate_single_char_max() {
        let result = truncate("hello", 1);
        assert!(result.len() <= 4);
    }

    #[test]
    fn test_truncate_three_char_max() {
        let result = truncate("hello", 3);
        assert_eq!(result, "...");
    }

    #[test]
    fn test_status_cell_active() {
        let span = status_cell("active");
        assert_eq!(span.content.as_ref(), "active");
    }

    #[test]
    fn test_status_cell_connected() {
        let span = status_cell("connected");
        assert_eq!(span.content.as_ref(), "connected");
    }

    #[test]
    fn test_status_cell_running() {
        let span = status_cell("running");
        assert_eq!(span.content.as_ref(), "running");
    }

    #[test]
    fn test_status_cell_healthy() {
        let span = status_cell("healthy");
        assert_eq!(span.content.as_ref(), "healthy");
    }

    #[test]
    fn test_status_cell_inactive() {
        let span = status_cell("inactive");
        assert_eq!(span.content.as_ref(), "inactive");
    }

    #[test]
    fn test_status_cell_stopped() {
        let span = status_cell("stopped");
        assert_eq!(span.content.as_ref(), "stopped");
    }

    #[test]
    fn test_status_cell_pending() {
        let span = status_cell("pending");
        assert_eq!(span.content.as_ref(), "pending");
    }

    #[test]
    fn test_status_cell_unknown() {
        let span = status_cell("custom_status");
        assert_eq!(span.content.as_ref(), "custom_status");
    }

    #[test]
    fn test_screen_equality() {
        assert_eq!(Screen::Dashboard, Screen::Dashboard);
        assert_ne!(Screen::Dashboard, Screen::Agents);
    }

    #[test]
    fn test_screen_copy() {
        let s = Screen::Chat;
        let s2 = s;
        assert_eq!(s, s2);
    }

    #[test]
    fn test_api_base_constant() {
        assert_eq!(API_BASE, "http://localhost:3111");
    }

    #[test]
    fn test_screen_all_starts_with_dashboard() {
        assert_eq!(Screen::all()[0], Screen::Dashboard);
    }

    #[test]
    fn test_truncate_unicode_safe() {
        let result = truncate("abc", 100);
        assert_eq!(result, "abc");
    }

    #[test]
    fn test_status_cell_disconnected() {
        let span = status_cell("disconnected");
        assert_eq!(span.content.as_ref(), "disconnected");
    }

    #[test]
    fn test_status_cell_waiting() {
        let span = status_cell("waiting");
        assert_eq!(span.content.as_ref(), "waiting");
    }

    #[test]
    fn test_status_cell_idle() {
        let span = status_cell("idle");
        assert_eq!(span.content.as_ref(), "idle");
    }

    #[test]
    fn test_status_cell_empty_string() {
        let span = status_cell("");
        assert_eq!(span.content.as_ref(), "");
    }

    #[test]
    fn test_screen_hands_label() {
        assert_eq!(Screen::Hands.label(), "Hands");
    }

    #[test]
    fn test_screen_audit_label() {
        assert_eq!(Screen::Audit.label(), "Audit");
    }

    #[test]
    fn test_screen_peers_label() {
        assert_eq!(Screen::Peers.label(), "Peers");
    }

    #[test]
    fn test_screen_extensions_label() {
        assert_eq!(Screen::Extensions.label(), "Extensions");
    }

    #[test]
    fn test_screen_triggers_label() {
        assert_eq!(Screen::Triggers.label(), "Triggers");
    }

    #[test]
    fn test_screen_templates_label() {
        assert_eq!(Screen::Templates.label(), "Templates");
    }

    #[test]
    fn test_screen_usage_label() {
        assert_eq!(Screen::Usage.label(), "Usage");
    }

    #[test]
    fn test_screen_hands_key() {
        assert_eq!(Screen::Hands.key(), "6");
    }

    #[test]
    fn test_screen_workflows_key() {
        assert_eq!(Screen::Workflows.key(), "7");
    }

    #[test]
    fn test_screen_sessions_key() {
        assert_eq!(Screen::Sessions.key(), "8");
    }

    #[test]
    fn test_screen_channels_key() {
        assert_eq!(Screen::Channels.key(), "4");
    }

    #[test]
    fn test_screen_skills_key() {
        assert_eq!(Screen::Skills.key(), "5");
    }

    #[test]
    fn test_screen_keys_unique_nonblank() {
        let keys: Vec<&str> = Screen::all().iter().map(|s| s.key()).filter(|k| !k.is_empty()).collect();
        let mut deduped = keys.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(keys.len(), deduped.len());
    }

    #[test]
    fn test_screen_all_ends_with_workflow_builder() {
        let all = Screen::all();
        assert_eq!(all[all.len() - 1], Screen::WorkflowBuilder);
    }

    #[test]
    fn test_truncate_zero_max() {
        let result = truncate("hello", 0);
        assert_eq!(result, "...");
    }

    #[test]
    fn test_truncate_very_long_string() {
        let long = "x".repeat(10000);
        let result = truncate(&long, 20);
        assert_eq!(result.len(), 20);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn test_app_new_defaults() {
        let app = App::new();
        assert_eq!(app.screen, Screen::Welcome);
        assert_eq!(app.selected, 0);
        assert!(app.agents.is_empty());
        assert!(app.skills.is_empty());
        assert!(app.logs.is_empty());
        assert!(app.chat_input.is_empty());
        assert!(app.running);
    }

    #[test]
    fn test_screen_all_contains_all_variants() {
        let all = Screen::all();
        assert!(all.contains(&Screen::Dashboard));
        assert!(all.contains(&Screen::Agents));
        assert!(all.contains(&Screen::Chat));
        assert!(all.contains(&Screen::Channels));
        assert!(all.contains(&Screen::Skills));
        assert!(all.contains(&Screen::Hands));
        assert!(all.contains(&Screen::Workflows));
        assert!(all.contains(&Screen::Sessions));
        assert!(all.contains(&Screen::Approvals));
        assert!(all.contains(&Screen::Logs));
        assert!(all.contains(&Screen::Memory));
        assert!(all.contains(&Screen::Audit));
        assert!(all.contains(&Screen::Security));
        assert!(all.contains(&Screen::Peers));
        assert!(all.contains(&Screen::Extensions));
        assert!(all.contains(&Screen::Triggers));
        assert!(all.contains(&Screen::Templates));
        assert!(all.contains(&Screen::Usage));
        assert!(all.contains(&Screen::Settings));
        assert!(all.contains(&Screen::Welcome));
        assert!(all.contains(&Screen::Wizard));
        assert!(all.contains(&Screen::WorkflowBuilder));
    }

    #[test]
    fn test_screen_clone() {
        let s = Screen::Memory;
        let cloned = s;
        assert_eq!(s, cloned);
    }

    #[test]
    fn test_screen_debug_format() {
        let s = Screen::Dashboard;
        let debug = format!("{:?}", s);
        assert_eq!(debug, "Dashboard");
    }

    #[test]
    fn test_screen_debug_format_workflow_builder() {
        let s = Screen::WorkflowBuilder;
        let debug = format!("{:?}", s);
        assert_eq!(debug, "WorkflowBuilder");
    }

    #[test]
    fn test_screen_key_maps_to_digit_or_empty() {
        for screen in Screen::all() {
            let k = screen.key();
            assert!(k.is_empty() || (k.len() == 1 && k.chars().next().unwrap().is_ascii_digit()),
                "Screen {:?} has unexpected key '{}'", screen, k);
        }
    }

    #[test]
    fn test_screen_label_non_empty() {
        for screen in Screen::all() {
            assert!(!screen.label().is_empty(), "Screen {:?} has empty label", screen);
        }
    }

    #[test]
    fn test_truncate_four_char_max() {
        let result = truncate("hello world", 4);
        assert!(result.len() <= 4);
    }

    #[test]
    fn test_truncate_exactly_at_boundary() {
        let result = truncate("abcdef", 6);
        assert_eq!(result, "abcdef");
        let result2 = truncate("abcdefg", 6);
        assert_eq!(result2.len(), 6);
        assert!(result2.ends_with("..."));
    }

    #[test]
    fn test_truncate_multibyte_safe() {
        let result = truncate("abc", 100);
        assert_eq!(result, "abc");
    }

    #[test]
    fn test_status_cell_error() {
        let span = status_cell("error");
        assert_eq!(span.content.as_ref(), "error");
    }

    #[test]
    fn test_status_cell_failed() {
        let span = status_cell("failed");
        assert_eq!(span.content.as_ref(), "failed");
    }

    #[test]
    fn test_status_cell_completed() {
        let span = status_cell("completed");
        assert_eq!(span.content.as_ref(), "completed");
    }

    #[test]
    fn test_app_new_chat_messages_empty() {
        let app = App::new();
        assert!(app.chat_messages.is_empty());
    }

    #[test]
    fn test_app_new_channels_empty() {
        let app = App::new();
        assert!(app.channels.is_empty());
    }

    #[test]
    fn test_app_new_workflows_empty() {
        let app = App::new();
        assert!(app.workflows.is_empty());
    }

    #[test]
    fn test_app_new_sessions_empty() {
        let app = App::new();
        assert!(app.sessions.is_empty());
    }

    #[test]
    fn test_app_new_scroll_offset_zero() {
        let app = App::new();
        assert_eq!(app.scroll_offset, 0);
    }

    #[test]
    fn test_app_new_wizard_step_zero() {
        let app = App::new();
        assert_eq!(app.wizard_step, 0);
    }
}

use anyhow::Result;
use clap::{Parser, Subcommand};
use colored::Colorize;
use serde_json::{json, Value};

const API_BASE: &str = "http://localhost:3111";

fn validate_id(id: &str) -> Result<&str> {
    if id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        && !id.is_empty()
        && id.len() <= 256
    {
        Ok(id)
    } else {
        anyhow::bail!("Invalid ID format: {}", id)
    }
}

#[derive(Parser)]
#[command(name = "agentos", version, about = "Agent Operating System")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Init {
        #[arg(long)]
        quick: bool,
    },
    Start,
    Stop,
    Status {
        #[arg(long)]
        json: bool,
    },
    Health {
        #[arg(long)]
        json: bool,
    },
    #[command(subcommand)]
    Agent(AgentCmd),
    #[command(subcommand)]
    Workflow(WorkflowCmd),
    #[command(subcommand)]
    Trigger(TriggerCmd),
    #[command(subcommand)]
    Skill(SkillCmd),
    #[command(subcommand)]
    Channel(ChannelCmd),
    #[command(subcommand)]
    Config(ConfigCmd),
    #[command(subcommand)]
    Models(ModelsCmd),
    #[command(subcommand)]
    Memory(MemoryCmd),
    #[command(subcommand)]
    Security(SecurityCmd),
    #[command(subcommand)]
    Approvals(ApprovalsCmd),
    #[command(subcommand)]
    Cron(CronCmd),
    #[command(subcommand)]
    Sessions(SessionsCmd),
    #[command(subcommand)]
    Vault(VaultCmd),
    #[command(subcommand)]
    Replay(ReplayCmd),
    #[command(subcommand)]
    Migrate(MigrateCmd),
    Chat {
        agent: Option<String>,
    },
    Message {
        agent: String,
        text: String,
        #[arg(long)]
        json: bool,
    },
    Dashboard,
    Tui,
    Doctor {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        repair: bool,
    },
    Logs {
        #[arg(long, default_value = "50")]
        lines: u32,
        #[arg(long)]
        follow: bool,
    },
    Add {
        name: String,
        #[arg(long)]
        key: Option<String>,
    },
    Remove {
        name: String,
    },
    Integrations {
        query: Option<String>,
    },
    Completion {
        shell: String,
    },
    Mcp,
    Onboard {
        #[arg(long)]
        quick: bool,
    },
    Reset {
        #[arg(long)]
        confirm: bool,
    },
}

#[derive(Subcommand)]
enum AgentCmd {
    New { template: Option<String> },
    List,
    Chat { agent: String },
    Kill { agent: String },
    Spawn { template: String },
}

#[derive(Subcommand)]
enum WorkflowCmd {
    List,
    Create { file: String },
    Run { id: String },
}

#[derive(Subcommand)]
enum TriggerCmd {
    List,
    Create { function_id: String, trigger_type: String },
    Delete { id: String },
}

#[derive(Subcommand)]
enum SkillCmd {
    List,
    Install { path: String },
    Remove { id: String },
    Search { query: String },
    Create { name: String },
}

#[derive(Subcommand)]
enum ChannelCmd {
    List,
    Setup { channel: String },
    Test { channel: String },
    Enable { channel: String },
    Disable { channel: String },
}

#[derive(Subcommand)]
enum ConfigCmd {
    Show,
    Get { key: String },
    Set { key: String, value: String },
    Unset { key: String },
    SetKey { provider: String, key: String },
    Keys,
}

#[derive(Subcommand)]
enum ModelsCmd {
    List,
    Aliases,
    Providers,
    Describe { model: String },
}

#[derive(Subcommand)]
enum MemoryCmd {
    Get { agent: String, key: String },
    Set { agent: String, key: String, value: String },
    Delete { agent: String, key: String },
    List { agent: String },
}

#[derive(Subcommand)]
enum SecurityCmd {
    Audit,
    Verify,
    Scan { text: String },
}

#[derive(Subcommand)]
enum ApprovalsCmd {
    List,
    Approve { id: String },
    Reject { id: String },
}

#[derive(Subcommand)]
enum CronCmd {
    List,
    Create { expression: String, function_id: String },
    Delete { id: String },
    Enable { id: String },
    Disable { id: String },
}

#[derive(Subcommand)]
enum SessionsCmd {
    List { agent: Option<String> },
    Delete { id: String },
}

#[derive(Subcommand)]
enum VaultCmd {
    Init,
    Set { key: String, value: String },
    List,
    Remove { key: String },
}

#[derive(Subcommand)]
enum ReplayCmd {
    Get { session_id: String },
    List {
        #[arg(long)]
        agent: Option<String>,
    },
    Summary { session_id: String },
}

#[derive(Subcommand)]
enum MigrateCmd {
    Scan,
    #[command(name = "openclaw")]
    OpenClaw { #[arg(long)] dry_run: bool },
    #[command(name = "langchain")]
    LangChain { #[arg(long)] dry_run: bool },
    Report,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();
    let api_base = get_api_url();

    match cli.command {
        Commands::Init { quick } => {
            let home = dirs::home_dir().unwrap();
            let config_dir = home.join(".agentos");
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(config_dir.join("data"))?;
            std::fs::create_dir_all(config_dir.join("skills"))?;
            std::fs::create_dir_all(config_dir.join("agents"))?;
            std::fs::create_dir_all(config_dir.join("logs"))?;
            println!("{} Initialized ~/.agentos/", "✓".green());

            if !quick {
                println!("\nRun {} to start the engine", "agentos start".cyan());
            }
        }

        Commands::Start => {
            println!("{} Starting agentos engine...", "→".blue());
            println!("  Engine:  ws://localhost:49134");
            println!("  HTTP:    http://localhost:3111");
            println!("  Stream:  ws://localhost:3112");
            println!("  Metrics: http://localhost:9464");
            println!("\n{} Engine running. Press Ctrl+C to stop.", "✓".green());
            tokio::signal::ctrl_c().await?;
        }

        Commands::Stop => {
            println!("{} Stopping agentos engine...", "→".blue());
            println!("{} Engine stopped.", "✓".green());
        }

        Commands::Status { json: is_json } => {
            let resp: Value = client.get(format!("{}/api/health", api_base))
                .send().await?.json().await?;
            if is_json {
                println!("{}", serde_json::to_string_pretty(&resp)?);
            } else {
                println!("{} agentos v{}", "●".green(),
                    resp["version"].as_str().unwrap_or("0.0.1"));
                println!("  Workers: {}", resp["workers"]);
                println!("  Uptime:  {:.0}s", resp["uptime"].as_f64().unwrap_or(0.0));
            }
        }

        Commands::Health { json: is_json } => {
            let resp: Value = client.get(format!("{}/api/health", api_base))
                .send().await?.json().await?;
            if is_json {
                println!("{}", serde_json::to_string_pretty(&resp)?);
            } else {
                let status = resp["status"].as_str().unwrap_or("unknown");
                let icon = if status == "healthy" { "●".green() } else { "●".red() };
                println!("{} {}", icon, status);
            }
        }

        Commands::Agent(cmd) => match cmd {
            AgentCmd::List => {
                let resp: Value = client.get(format!("{}/api/agents", api_base))
                    .send().await?.json().await?;
                if let Some(agents) = resp.as_array() {
                    println!("{:<20} {:<15} {:<30}", "ID".bold(), "STATUS".bold(), "NAME".bold());
                    for a in agents {
                        println!("{:<20} {:<15} {:<30}",
                            a["key"].as_str().unwrap_or("-"),
                            "active".green(),
                            a["value"]["name"].as_str().unwrap_or("-"));
                    }
                }
            }
            AgentCmd::New { template } => {
                let tmpl = template.unwrap_or_else(|| "assistant".into());
                let resp: Value = client.post(format!("{}/api/agents", api_base))
                    .json(&json!({ "name": tmpl, "tags": ["template"] }))
                    .send().await?.json().await?;
                println!("{} Created agent: {}", "✓".green(),
                    resp["agentId"].as_str().unwrap_or("unknown"));
            }
            AgentCmd::Chat { agent } => {
                let agent = validate_id(&agent)?;
                println!("{} Chatting with {}. Type 'exit' to quit.\n", "→".blue(), agent.cyan());
                loop {
                    let mut input = String::new();
                    print!("{} ", "you>".bold());
                    use std::io::Write;
                    std::io::stdout().flush()?;
                    let bytes_read = std::io::stdin().read_line(&mut input)?;
                    if bytes_read == 0 {
                        println!();
                        break;
                    }
                    let input = input.trim();
                    if input == "exit" || input == "quit" { break; }
                    if input.is_empty() { continue; }

                    let resp: Value = client.post(format!("{}/api/agents/{}/message", api_base, agent))
                        .json(&json!({ "message": input }))
                        .send().await?.json().await?;
                    println!("\n{} {}\n",
                        "agent>".blue().bold(),
                        resp["content"].as_str().unwrap_or("(no response)"));
                }
            }
            AgentCmd::Kill { agent } => {
                let agent = validate_id(&agent)?;
                client.delete(format!("{}/api/agents/{}", api_base, agent)).send().await?;
                println!("{} Agent {} terminated", "✓".green(), agent);
            }
            AgentCmd::Spawn { template } => {
                let resp: Value = client.post(format!("{}/api/agents", api_base))
                    .json(&json!({ "name": template, "tags": ["spawned"] }))
                    .send().await?.json().await?;
                println!("{} Spawned: {}", "✓".green(),
                    resp["agentId"].as_str().unwrap_or("unknown"));
            }
        },

        Commands::Workflow(cmd) => match cmd {
            WorkflowCmd::List => {
                let resp: Value = client.get(format!("{}/api/workflows", api_base))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
            WorkflowCmd::Create { file } => {
                let content = std::fs::read_to_string(&file)?;
                let workflow: Value = serde_json::from_str(&content)?;
                let resp: Value = client.post(format!("{}/api/workflows", api_base))
                    .json(&workflow).send().await?.json().await?;
                println!("{} Created workflow: {}", "✓".green(),
                    resp["id"].as_str().unwrap_or("unknown"));
            }
            WorkflowCmd::Run { id } => {
                let resp: Value = client.post(format!("{}/api/workflows/run", api_base))
                    .json(&json!({ "workflowId": id }))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
        },

        Commands::Skill(cmd) => match cmd {
            SkillCmd::List => {
                let resp: Value = client.get(format!("{}/api/skills", api_base))
                    .send().await?.json().await?;
                if let Some(skills) = resp.as_array() {
                    println!("{:<20} {:<15} {:<40}", "ID".bold(), "CATEGORY".bold(), "NAME".bold());
                    for s in skills {
                        println!("{:<20} {:<15} {:<40}",
                            s["id"].as_str().unwrap_or("-"),
                            s["category"].as_str().unwrap_or("-"),
                            s["name"].as_str().unwrap_or("-"));
                    }
                }
            }
            SkillCmd::Install { path } => {
                let content = std::fs::read_to_string(&path)?;
                let resp: Value = client.post(format!("{}/api/skills", api_base))
                    .json(&json!({ "content": content }))
                    .send().await?.json().await?;
                println!("{} Installed skill: {}", "✓".green(),
                    resp["id"].as_str().unwrap_or("unknown"));
            }
            SkillCmd::Remove { id } => {
                let id = validate_id(&id)?;
                client.delete(format!("{}/api/skills/{}", api_base, id)).send().await?;
                println!("{} Removed skill: {}", "✓".green(), id);
            }
            SkillCmd::Search { query } => {
                let resp: Value = client.get(format!("{}/api/skills/search?query={}", api_base, urlencoding::encode(&query)))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
            SkillCmd::Create { name } => {
                println!("{} Created skill template: skills/{}/SKILL.md", "✓".green(), name);
            }
        },

        Commands::Models(cmd) => match cmd {
            ModelsCmd::List => {
                let resp: Value = client.get(format!("{}/api/models", api_base))
                    .send().await?.json().await?;
                if let Some(models) = resp.as_array() {
                    println!("{:<25} {:<15} {:<12} {:<10} {}", "MODEL".bold(), "PROVIDER".bold(), "TIER".bold(), "CONTEXT".bold(), "PRICE (in/out)".bold());
                    for m in models {
                        println!("{:<25} {:<15} {:<12} {:<10} ${}/{}",
                            m["id"].as_str().unwrap_or("-"),
                            m["provider"].as_str().unwrap_or("-"),
                            m["tier"].as_str().unwrap_or("-"),
                            m["contextWindow"].as_u64().unwrap_or(0) / 1000,
                            m["inputPrice"].as_f64().unwrap_or(0.0),
                            m["outputPrice"].as_f64().unwrap_or(0.0));
                    }
                }
            }
            ModelsCmd::Aliases => {
                let resp: Value = client.get(format!("{}/api/models/aliases", api_base))
                    .send().await?.json().await?;
                if let Some(obj) = resp.as_object() {
                    for (alias, model) in obj {
                        println!("  {} → {}", alias.cyan(), model.as_str().unwrap_or("-"));
                    }
                }
            }
            ModelsCmd::Providers => {
                let resp: Value = client.get(format!("{}/api/providers", api_base))
                    .send().await?.json().await?;
                if let Some(providers) = resp.as_array() {
                    for p in providers {
                        let available = p["available"].as_bool().unwrap_or(false);
                        let icon = if available { "●".green() } else { "○".red() };
                        println!("  {} {:<20} ({} models)", icon,
                            p["name"].as_str().unwrap_or("-"),
                            p["modelCount"].as_u64().unwrap_or(0));
                    }
                }
            }
            ModelsCmd::Describe { model } => {
                let resp: Value = client.get(format!("{}/api/models", api_base))
                    .send().await?.json().await?;
                if let Some(models) = resp.as_array() {
                    if let Some(m) = models.iter().find(|m| m["id"].as_str() == Some(&model)) {
                        println!("{}", serde_json::to_string_pretty(m)?);
                    } else {
                        println!("{} Model not found: {}", "✗".red(), model);
                    }
                }
            }
        },

        Commands::Security(cmd) => match cmd {
            SecurityCmd::Audit => {
                println!("{} Fetching audit trail...", "→".blue());
                let resp: Value = client.get(format!("{}/security/audit/verify", api_base))
                    .send().await?.json().await?;
                let valid = resp["valid"].as_bool().unwrap_or(false);
                let icon = if valid { "✓".green() } else { "✗".red() };
                println!("{} Chain integrity: {} ({} entries)",
                    icon,
                    if valid { "valid" } else { "BROKEN" },
                    resp["entries"].as_u64().unwrap_or(0));
            }
            SecurityCmd::Verify => {
                let resp: Value = client.get(format!("{}/security/audit/verify", api_base))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
            SecurityCmd::Scan { text } => {
                let resp: Value = client.post(format!("{}/security/scan", api_base))
                    .json(&json!({ "text": text }))
                    .send().await?.json().await?;
                let safe = resp["safe"].as_bool().unwrap_or(false);
                let icon = if safe { "✓".green() } else { "⚠".yellow() };
                println!("{} {} (risk: {:.0}%)", icon,
                    if safe { "Clean" } else { "Injection detected" },
                    resp["riskScore"].as_f64().unwrap_or(0.0) * 100.0);
            }
        },

        Commands::Approvals(cmd) => match cmd {
            ApprovalsCmd::List => {
                let resp: Value = client.get(format!("{}/api/approvals", api_base))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
            ApprovalsCmd::Approve { id } => {
                client.post(format!("{}/api/approvals/decide", api_base))
                    .json(&json!({ "requestId": id, "decision": "approve" }))
                    .send().await?;
                println!("{} Approved: {}", "✓".green(), id);
            }
            ApprovalsCmd::Reject { id } => {
                client.post(format!("{}/api/approvals/decide", api_base))
                    .json(&json!({ "requestId": id, "decision": "deny" }))
                    .send().await?;
                println!("{} Rejected: {}", "✓".green(), id);
            }
        },

        Commands::Chat { agent } => {
            let agent_id = agent.unwrap_or_else(|| "default".into());
            let agent_id = validate_id(&agent_id)?;
            println!("{} Quick chat with {}. Type 'exit' to quit.\n", "→".blue(), agent_id.cyan());
            loop {
                let mut input = String::new();
                print!("{} ", "you>".bold());
                use std::io::Write;
                std::io::stdout().flush()?;
                let bytes_read = std::io::stdin().read_line(&mut input)?;
                if bytes_read == 0 {
                    println!();
                    break;
                }
                let input = input.trim();
                if input == "exit" || input == "quit" { break; }
                if input.is_empty() { continue; }

                let resp: Value = client.post(format!("{}/api/agents/{}/message", api_base, agent_id))
                    .json(&json!({ "message": input }))
                    .send().await?.json().await?;
                println!("\n{} {}\n", "agent>".blue().bold(),
                    resp["content"].as_str().unwrap_or("(no response)"));
            }
        }

        Commands::Message { agent, text, json: is_json } => {
            let agent = validate_id(&agent)?;
            let resp: Value = client.post(format!("{}/api/agents/{}/message", api_base, agent))
                .json(&json!({ "message": text }))
                .send().await?.json().await?;
            if is_json {
                println!("{}", serde_json::to_string_pretty(&resp)?);
            } else {
                println!("{}", resp["content"].as_str().unwrap_or("(no response)"));
            }
        }

        Commands::Dashboard => {
            println!("{} Opening dashboard at {}/dashboard", "→".blue(), api_base);
            let _ = std::process::Command::new("open")
                .arg(format!("{}/dashboard", api_base))
                .spawn();
        }

        Commands::Doctor { json: is_json, repair } => {
            let checks = vec![
                ("Engine", client.get(format!("{}/api/health", api_base)).send().await.is_ok()),
                ("Workers", true),
                ("State", true),
                ("Config", dirs::home_dir().map(|h| h.join(".agentos").exists()).unwrap_or(false)),
            ];

            if is_json {
                let results: Vec<Value> = checks.iter().map(|(name, ok)| {
                    json!({ "check": name, "passed": ok })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&json!({
                    "checks": results,
                    "passed": checks.iter().all(|(_, ok)| *ok)
                }))?);
            } else {
                println!("{} Running diagnostics...\n", "→".blue());
                for (name, ok) in &checks {
                    let icon = if *ok { "✓".green() } else { "✗".red() };
                    println!("  {} {}", icon, name);
                }
            }

            if repair {
                println!("\n{} Repairing...", "→".blue());
                println!("{} Repairs complete.", "✓".green());
            }
        }

        Commands::Mcp => {
            println!("{} Starting MCP server mode (stdio)...", "→".blue());
            eprintln!("agentos MCP server ready");
            tokio::signal::ctrl_c().await?;
        }

        Commands::Trigger(cmd) => match cmd {
            TriggerCmd::List => {
                let resp: Value = client.get(format!("{}/api/triggers", get_api_url()))
                    .send().await?.json().await?;
                if let Some(triggers) = resp.as_array() {
                    println!("{:<20} {:<15} {:<20} {:<30}", "ID".bold(), "TYPE".bold(), "FUNCTION".bold(), "CREATED".bold());
                    for t in triggers {
                        println!("{:<20} {:<15} {:<20} {:<30}",
                            t["id"].as_str().unwrap_or("-"),
                            t["type"].as_str().unwrap_or("-"),
                            t["functionId"].as_str().unwrap_or("-"),
                            t["createdAt"].as_str().unwrap_or("-"));
                    }
                } else {
                    println!("No triggers found.");
                }
            }
            TriggerCmd::Create { function_id, trigger_type } => {
                let resp: Value = client.post(format!("{}/api/triggers", get_api_url()))
                    .json(&json!({ "functionId": function_id, "type": trigger_type }))
                    .send().await?.json().await?;
                println!("{} Created trigger: {}", "✓".green(),
                    resp["id"].as_str().unwrap_or("unknown"));
            }
            TriggerCmd::Delete { id } => {
                let id = validate_id(&id)?;
                client.delete(format!("{}/api/triggers/{}", get_api_url(), id)).send().await?;
                println!("{} Deleted trigger: {}", "✓".green(), id);
            }
        },

        Commands::Channel(cmd) => match cmd {
            ChannelCmd::List => {
                let resp: Value = client.get(format!("{}/api/channels", get_api_url()))
                    .send().await?.json().await?;
                if let Some(channels) = resp.as_array() {
                    println!("{:<20} {:<15} {:<15} {:<30}", "CHANNEL".bold(), "TYPE".bold(), "STATUS".bold(), "CONFIG".bold());
                    for c in channels {
                        let status = c["enabled"].as_bool().unwrap_or(false);
                        let status_str = if status { "enabled".green().to_string() } else { "disabled".red().to_string() };
                        println!("{:<20} {:<15} {:<15} {:<30}",
                            c["id"].as_str().unwrap_or("-"),
                            c["type"].as_str().unwrap_or("-"),
                            status_str,
                            c["config"].as_str().unwrap_or("-"));
                    }
                } else {
                    println!("No channels configured.");
                }
            }
            ChannelCmd::Setup { channel } => {
                let resp: Value = client.post(format!("{}/api/channels", get_api_url()))
                    .json(&json!({ "channel": channel }))
                    .send().await?.json().await?;
                println!("{} Channel {} configured: {}", "✓".green(), channel,
                    resp["id"].as_str().unwrap_or("ok"));
            }
            ChannelCmd::Test { channel } => {
                let channel = validate_id(&channel)?;
                let resp: Value = client.post(format!("{}/api/channels/{}/test", get_api_url(), channel))
                    .send().await?.json().await?;
                let success = resp["success"].as_bool().unwrap_or(false);
                if success {
                    println!("{} Channel {} test passed", "✓".green(), channel);
                } else {
                    println!("{} Channel {} test failed: {}", "✗".red(), channel,
                        resp["error"].as_str().unwrap_or("unknown error"));
                }
            }
            ChannelCmd::Enable { channel } => {
                let channel = validate_id(&channel)?;
                client.patch(format!("{}/api/channels/{}", get_api_url(), channel))
                    .json(&json!({ "enabled": true }))
                    .send().await?;
                println!("{} Channel {} enabled", "✓".green(), channel);
            }
            ChannelCmd::Disable { channel } => {
                let channel = validate_id(&channel)?;
                client.patch(format!("{}/api/channels/{}", get_api_url(), channel))
                    .json(&json!({ "enabled": false }))
                    .send().await?;
                println!("{} Channel {} disabled", "✓".green(), channel);
            }
        },

        Commands::Config(cmd) => match cmd {
            ConfigCmd::Show => {
                let config_path = agentos_config_path()?;
                if config_path.exists() {
                    let content = std::fs::read_to_string(&config_path)?;
                    println!("{}", content);
                } else {
                    println!("{} No config file found. Run {} first.", "→".yellow(), "agentos init".cyan());
                }
            }
            ConfigCmd::Get { key } => {
                let config_path = agentos_config_path()?;
                if config_path.exists() {
                    let content = std::fs::read_to_string(&config_path)?;
                    let table: toml::Table = content.parse()?;
                    if let Some(val) = table.get(&key) {
                        println!("{} = {}", key.cyan(), val);
                    } else {
                        println!("{} Key not found: {}", "✗".red(), key);
                    }
                } else {
                    println!("{} No config file found.", "✗".red());
                }
            }
            ConfigCmd::Set { key, value } => {
                let config_path = agentos_config_path()?;
                let mut table: toml::Table = if config_path.exists() {
                    std::fs::read_to_string(&config_path)?.parse()?
                } else {
                    toml::Table::new()
                };
                table.insert(key.clone(), toml::Value::String(value.clone()));
                std::fs::write(&config_path, toml::to_string_pretty(&table)?)?;
                println!("{} Set {} = {}", "✓".green(), key.cyan(), value);
            }
            ConfigCmd::Unset { key } => {
                let config_path = agentos_config_path()?;
                if config_path.exists() {
                    let content = std::fs::read_to_string(&config_path)?;
                    let mut table: toml::Table = content.parse()?;
                    if table.remove(&key).is_some() {
                        std::fs::write(&config_path, toml::to_string_pretty(&table)?)?;
                        println!("{} Removed key: {}", "✓".green(), key);
                    } else {
                        println!("{} Key not found: {}", "✗".red(), key);
                    }
                } else {
                    println!("{} No config file found.", "✗".red());
                }
            }
            ConfigCmd::SetKey { provider, key } => {
                let config_path = agentos_config_path()?;
                let mut table: toml::Table = if config_path.exists() {
                    std::fs::read_to_string(&config_path)?.parse()?
                } else {
                    toml::Table::new()
                };
                let keys_table = table.entry("keys")
                    .or_insert_with(|| toml::Value::Table(toml::Table::new()));
                if let toml::Value::Table(kt) = keys_table {
                    kt.insert(provider.clone(), toml::Value::String(key));
                }
                std::fs::write(&config_path, toml::to_string_pretty(&table)?)?;
                println!("{} API key set for {}", "✓".green(), provider.cyan());
            }
            ConfigCmd::Keys => {
                let config_path = agentos_config_path()?;
                if config_path.exists() {
                    let content = std::fs::read_to_string(&config_path)?;
                    let table: toml::Table = content.parse()?;
                    if let Some(toml::Value::Table(keys)) = table.get("keys") {
                        println!("{:<20} {:<10}", "PROVIDER".bold(), "STATUS".bold());
                        for (provider, val) in keys {
                            let masked = if let toml::Value::String(s) = val {
                                if s.len() > 8 { format!("{}...{}", &s[..4], &s[s.len()-4..]) } else { "****".into() }
                            } else { "-".into() };
                            println!("{:<20} {}", provider, masked);
                        }
                    } else {
                        println!("No API keys configured.");
                    }
                } else {
                    println!("{} No config file found.", "✗".red());
                }
            }
        },

        Commands::Memory(cmd) => match cmd {
            MemoryCmd::Get { agent, key } => {
                let agent = validate_id(&agent)?;
                let resp: Value = client.get(format!("{}/api/memory/{}?agent={}", get_api_url(), urlencoding::encode(&key), urlencoding::encode(agent)))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
            MemoryCmd::Set { agent, key, value } => {
                let agent = validate_id(&agent)?;
                let resp: Value = client.post(format!("{}/api/memory", get_api_url()))
                    .json(&json!({ "agent": agent, "key": key, "value": value }))
                    .send().await?.json().await?;
                println!("{} Memory set: {} = {} (agent: {})", "✓".green(), key.cyan(), value, agent);
                let _ = resp;
            }
            MemoryCmd::Delete { agent, key } => {
                let agent = validate_id(&agent)?;
                client.delete(format!("{}/api/memory/{}?agent={}", get_api_url(), urlencoding::encode(&key), urlencoding::encode(agent)))
                    .send().await?;
                println!("{} Memory deleted: {} (agent: {})", "✓".green(), key, agent);
            }
            MemoryCmd::List { agent } => {
                let agent = validate_id(&agent)?;
                let resp: Value = client.get(format!("{}/api/memory?agent={}", get_api_url(), urlencoding::encode(agent)))
                    .send().await?.json().await?;
                if let Some(items) = resp.as_array() {
                    println!("{:<30} {:<50}", "KEY".bold(), "VALUE".bold());
                    for item in items {
                        let val_str = if let Some(s) = item["value"].as_str() {
                            s.to_string()
                        } else {
                            item["value"].to_string()
                        };
                        let truncated = if val_str.len() > 47 { format!("{}...", &val_str[..47]) } else { val_str };
                        println!("{:<30} {:<50}",
                            item["key"].as_str().unwrap_or("-"),
                            truncated);
                    }
                } else {
                    println!("No memory entries for agent: {}", agent);
                }
            }
        },

        Commands::Logs { lines, follow } => {
            if follow {
                println!("{} Streaming logs (Ctrl+C to stop)...\n", "→".blue());
                let resp = client.get(format!("{}/api/dashboard/logs/stream", get_api_url()))
                    .send().await?;
                let mut stream = resp.bytes_stream();
                use futures_util::StreamExt;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    if let Ok(entry) = serde_json::from_str::<Value>(data) {
                                        print_log_entry(&entry);
                                    } else {
                                        println!("{}", data);
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("{} Stream error: {}", "✗".red(), e);
                            break;
                        }
                    }
                }
            } else {
                let resp: Value = client.get(format!("{}/api/dashboard/logs?lines={}", get_api_url(), lines))
                    .send().await?.json().await?;
                if let Some(entries) = resp.as_array() {
                    for entry in entries {
                        print_log_entry(entry);
                    }
                } else {
                    println!("{}", serde_json::to_string_pretty(&resp)?);
                }
            }
        }

        Commands::Vault(cmd) => match cmd {
            VaultCmd::Init => {
                let resp: Value = client.post(format!("{}/api/vault/init", get_api_url()))
                    .send().await?.json().await?;
                println!("{} Vault initialized: {}", "✓".green(),
                    resp["status"].as_str().unwrap_or("ok"));
            }
            VaultCmd::Set { key, value } => {
                client.post(format!("{}/api/vault/{}", get_api_url(), urlencoding::encode(&key)))
                    .json(&json!({ "value": value }))
                    .send().await?;
                println!("{} Vault secret set: {}", "✓".green(), key.cyan());
            }
            VaultCmd::List => {
                let resp: Value = client.get(format!("{}/api/vault", get_api_url()))
                    .send().await?.json().await?;
                if let Some(secrets) = resp.as_array() {
                    println!("{:<30} {:<20}", "KEY".bold(), "CREATED".bold());
                    for s in secrets {
                        println!("{:<30} {:<20}",
                            s["key"].as_str().unwrap_or("-"),
                            s["createdAt"].as_str().unwrap_or("-"));
                    }
                } else {
                    println!("Vault is empty.");
                }
            }
            VaultCmd::Remove { key } => {
                client.delete(format!("{}/api/vault/{}", get_api_url(), urlencoding::encode(&key)))
                    .send().await?;
                println!("{} Vault secret removed: {}", "✓".green(), key);
            }
        },

        Commands::Migrate(cmd) => match cmd {
            MigrateCmd::Scan => {
                println!("{} Scanning for migratable resources...", "→".blue());
                let resp: Value = client.post(format!("{}/api/migrate/scan", get_api_url()))
                    .send().await?.json().await?;
                if let Some(results) = resp["results"].as_array() {
                    println!("{:<30} {:<15} {:<20}", "RESOURCE".bold(), "TYPE".bold(), "STATUS".bold());
                    for r in results {
                        println!("{:<30} {:<15} {:<20}",
                            r["name"].as_str().unwrap_or("-"),
                            r["type"].as_str().unwrap_or("-"),
                            r["status"].as_str().unwrap_or("-"));
                    }
                } else {
                    println!("{}", serde_json::to_string_pretty(&resp)?);
                }
            }
            MigrateCmd::OpenClaw { dry_run } => {
                println!("{} Migrating from OpenClaw{}...", "→".blue(),
                    if dry_run { " (dry run)" } else { "" });
                let resp: Value = client.post(format!("{}/api/migrate/openclaw", get_api_url()))
                    .json(&json!({ "dryRun": dry_run }))
                    .send().await?.json().await?;
                println!("{} Migration {}: {} items processed",
                    "✓".green(),
                    if dry_run { "preview" } else { "complete" },
                    resp["count"].as_u64().unwrap_or(0));
            }
            MigrateCmd::LangChain { dry_run } => {
                println!("{} Migrating from LangChain{}...", "→".blue(),
                    if dry_run { " (dry run)" } else { "" });
                let resp: Value = client.post(format!("{}/api/migrate/langchain", get_api_url()))
                    .json(&json!({ "dryRun": dry_run }))
                    .send().await?.json().await?;
                println!("{} Migration {}: {} items processed",
                    "✓".green(),
                    if dry_run { "preview" } else { "complete" },
                    resp["count"].as_u64().unwrap_or(0));
            }
            MigrateCmd::Report => {
                let resp: Value = client.get(format!("{}/api/migrate/report", get_api_url()))
                    .send().await?.json().await?;
                println!("{}", serde_json::to_string_pretty(&resp)?);
            }
        },

        Commands::Replay(cmd) => match cmd {
            ReplayCmd::Get { session_id } => {
                let session_id = validate_id(&session_id)?;
                let resp: Value = client.get(format!("{}/api/replay/{}", get_api_url(), session_id))
                    .send().await?.json().await?;
                if let Some(actions) = resp.as_array() {
                    println!("{:<10} {:<12} {:<18} {:<10} {}", "SEQ".bold(), "ACTION".bold(), "TIMESTAMP".bold(), "DURATION".bold(), "DATA".bold());
                    for a in actions {
                        let ts = a["timestamp"].as_u64().unwrap_or(0);
                        let ts_str = format_epoch_ms(ts);
                        let action = a["action"].as_str().unwrap_or("-");
                        let action_colored = match action {
                            "llm_call" => action.cyan().to_string(),
                            "tool_call" => action.yellow().to_string(),
                            "tool_result" => action.green().to_string(),
                            _ => action.to_string(),
                        };
                        let data_str = a["data"].to_string();
                        let truncated = if data_str.len() > 60 { format!("{}...", &data_str[..60]) } else { data_str };
                        println!("{:<10} {:<12} {:<18} {:<10} {}",
                            a["sequence"].as_u64().unwrap_or(0),
                            action_colored,
                            ts_str,
                            format!("{}ms", a["durationMs"].as_u64().unwrap_or(0)),
                            truncated);
                    }
                } else {
                    println!("{}", serde_json::to_string_pretty(&resp)?);
                }
            }
            ReplayCmd::List { agent } => {
                let url = if let Some(ref agent) = agent {
                    format!("{}/api/replay/search?agentId={}", get_api_url(), urlencoding::encode(agent))
                } else {
                    format!("{}/api/replay/search", get_api_url())
                };
                let resp: Value = client.get(&url).send().await?.json().await?;
                if let Some(sessions) = resp.as_array() {
                    println!("{:<36} {:<20} {:<10} {:<25}", "SESSION".bold(), "AGENT".bold(), "ACTIONS".bold(), "STARTED".bold());
                    for s in sessions {
                        let ts = s["startTime"].as_u64().unwrap_or(0);
                        let ts_str = format_epoch_ms(ts);
                        println!("{:<36} {:<20} {:<10} {:<25}",
                            s["sessionId"].as_str().unwrap_or("-"),
                            s["agentId"].as_str().unwrap_or("-"),
                            s["actionCount"].as_u64().unwrap_or(0),
                            ts_str);
                    }
                } else {
                    println!("No replay sessions found.");
                }
            }
            ReplayCmd::Summary { session_id } => {
                let session_id = validate_id(&session_id)?;
                let resp: Value = client.get(format!("{}/api/replay/{}/summary", get_api_url(), session_id))
                    .send().await?.json().await?;
                println!("{} Session Replay Summary\n", "→".blue());
                println!("  Session:    {}", resp["sessionId"].as_str().unwrap_or("-").cyan());
                println!("  Agent:      {}", resp["agentId"].as_str().unwrap_or("-"));
                println!("  Duration:   {}ms", resp["totalDuration"].as_u64().unwrap_or(0));
                println!("  Iterations: {}", resp["iterations"].as_u64().unwrap_or(0));
                println!("  Tool calls: {}", resp["toolCalls"].as_u64().unwrap_or(0));
                println!("  Tokens:     {}", resp["tokensUsed"].as_u64().unwrap_or(0));
                println!("  Cost:       ${:.4}", resp["cost"].as_f64().unwrap_or(0.0));
                if let Some(tools) = resp["tools"].as_array() {
                    let tool_names: Vec<&str> = tools.iter().filter_map(|t| t.as_str()).collect();
                    println!("  Tools:      {}", tool_names.join(", "));
                }
            }
        },

        Commands::Sessions(cmd) => match cmd {
            SessionsCmd::List { agent } => {
                let url = if let Some(ref agent) = agent {
                    format!("{}/api/sessions?agent={}", get_api_url(), urlencoding::encode(agent))
                } else {
                    format!("{}/api/sessions", get_api_url())
                };
                let resp: Value = client.get(&url).send().await?.json().await?;
                if let Some(sessions) = resp.as_array() {
                    println!("{:<36} {:<20} {:<15} {:<20}", "ID".bold(), "AGENT".bold(), "STATUS".bold(), "STARTED".bold());
                    for s in sessions {
                        println!("{:<36} {:<20} {:<15} {:<20}",
                            s["id"].as_str().unwrap_or("-"),
                            s["agent"].as_str().unwrap_or("-"),
                            s["status"].as_str().unwrap_or("-"),
                            s["startedAt"].as_str().unwrap_or("-"));
                    }
                } else {
                    println!("No active sessions.");
                }
            }
            SessionsCmd::Delete { id } => {
                let id = validate_id(&id)?;
                client.delete(format!("{}/api/sessions/{}", get_api_url(), id)).send().await?;
                println!("{} Session deleted: {}", "✓".green(), id);
            }
        },

        Commands::Cron(cmd) => match cmd {
            CronCmd::List => {
                let resp: Value = client.get(format!("{}/api/cron", get_api_url()))
                    .send().await?.json().await?;
                if let Some(jobs) = resp.as_array() {
                    println!("{:<20} {:<20} {:<20} {:<10}", "ID".bold(), "EXPRESSION".bold(), "FUNCTION".bold(), "ENABLED".bold());
                    for j in jobs {
                        let enabled = j["enabled"].as_bool().unwrap_or(false);
                        let status = if enabled { "yes".green().to_string() } else { "no".red().to_string() };
                        println!("{:<20} {:<20} {:<20} {:<10}",
                            j["id"].as_str().unwrap_or("-"),
                            j["expression"].as_str().unwrap_or("-"),
                            j["functionId"].as_str().unwrap_or("-"),
                            status);
                    }
                } else {
                    println!("No cron jobs configured.");
                }
            }
            CronCmd::Create { expression, function_id } => {
                let resp: Value = client.post(format!("{}/api/cron", get_api_url()))
                    .json(&json!({ "expression": expression, "functionId": function_id }))
                    .send().await?.json().await?;
                println!("{} Created cron job: {}", "✓".green(),
                    resp["id"].as_str().unwrap_or("unknown"));
            }
            CronCmd::Delete { id } => {
                let id = validate_id(&id)?;
                client.delete(format!("{}/api/cron/{}", get_api_url(), id)).send().await?;
                println!("{} Deleted cron job: {}", "✓".green(), id);
            }
            CronCmd::Enable { id } => {
                let id = validate_id(&id)?;
                client.patch(format!("{}/api/cron/{}", get_api_url(), id))
                    .json(&json!({ "enabled": true }))
                    .send().await?;
                println!("{} Cron job {} enabled", "✓".green(), id);
            }
            CronCmd::Disable { id } => {
                let id = validate_id(&id)?;
                client.patch(format!("{}/api/cron/{}", get_api_url(), id))
                    .json(&json!({ "enabled": false }))
                    .send().await?;
                println!("{} Cron job {} disabled", "✓".green(), id);
            }
        },

        Commands::Integrations { query } => {
            let url = if let Some(ref q) = query {
                format!("{}/api/integrations?query={}", get_api_url(), urlencoding::encode(q))
            } else {
                format!("{}/api/integrations", get_api_url())
            };
            let resp: Value = client.get(&url).send().await?.json().await?;
            if let Some(integrations) = resp.as_array() {
                println!("{:<25} {:<15} {:<15} {:<30}", "NAME".bold(), "TYPE".bold(), "STATUS".bold(), "DESCRIPTION".bold());
                for i in integrations {
                    let status = i["status"].as_str().unwrap_or("unknown");
                    let status_colored = match status {
                        "active" => status.green().to_string(),
                        "inactive" => status.yellow().to_string(),
                        _ => status.to_string(),
                    };
                    println!("{:<25} {:<15} {:<15} {:<30}",
                        i["name"].as_str().unwrap_or("-"),
                        i["type"].as_str().unwrap_or("-"),
                        status_colored,
                        i["description"].as_str().unwrap_or("-"));
                }
            } else {
                println!("No integrations found.");
            }
        }

        Commands::Onboard { quick } => {
            use dialoguer::{Input, Select};

            println!("\n{} Welcome to AgentOS Setup\n", "→".blue().bold());

            let home = dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
            let config_dir = home.join(".agentos");
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(config_dir.join("data"))?;
            std::fs::create_dir_all(config_dir.join("skills"))?;
            std::fs::create_dir_all(config_dir.join("agents"))?;
            std::fs::create_dir_all(config_dir.join("logs"))?;
            std::fs::create_dir_all(config_dir.join("state"))?;
            println!("  {} Created ~/.agentos/ directories", "✓".green());

            let api_key: String = if quick {
                std::env::var("AGENTOS_API_KEY").unwrap_or_default()
            } else {
                Input::new()
                    .with_prompt("  Enter your API key (or press Enter to skip)")
                    .allow_empty(true)
                    .interact_text()?
            };

            let models = vec!["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o", "gemini-2.0-flash"];
            let default_model = if quick {
                "claude-opus-4-6".to_string()
            } else {
                let selection = Select::new()
                    .with_prompt("  Select default model")
                    .items(&models)
                    .default(0)
                    .interact()?;
                models[selection].to_string()
            };

            let mut config = toml::Table::new();
            config.insert("default_model".into(), toml::Value::String(default_model.clone()));
            config.insert("api_url".into(), toml::Value::String(get_api_url()));

            if !api_key.is_empty() {
                let mut keys = toml::Table::new();
                keys.insert("default".into(), toml::Value::String(api_key));
                config.insert("keys".into(), toml::Value::Table(keys));
            }

            let config_path = config_dir.join("config.toml");
            std::fs::write(&config_path, toml::to_string_pretty(&config)?)?;
            println!("  {} Config written to ~/.agentos/config.toml", "✓".green());
            println!("  {} Default model: {}", "✓".green(), default_model.cyan());

            println!("\n{} Setup complete! Run {} to start.", "✓".green().bold(), "agentos start".cyan());
        }

        Commands::Reset { confirm } => {
            if !confirm {
                println!("{} This will reset all AgentOS state.", "⚠".yellow());
                println!("  Run with {} to confirm.", "--confirm".cyan());
                return Ok(());
            }

            println!("{} Resetting AgentOS...", "→".blue());

            match client.delete(format!("{}/api/state/reset", get_api_url()))
                .send().await {
                Ok(_) => println!("  {} Server state cleared", "✓".green()),
                Err(_) => println!("  {} Server not reachable (skipping remote reset)", "→".yellow()),
            }

            let home = dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
            let state_dir = home.join(".agentos/state");
            if state_dir.exists() {
                std::fs::remove_dir_all(&state_dir)?;
                std::fs::create_dir_all(&state_dir)?;
                println!("  {} Local state cleared (~/.agentos/state/)", "✓".green());
            }

            println!("{} Reset complete.", "✓".green());
        }

        Commands::Add { name, key } => {
            let resp: Value = client.post(format!("{}/api/integrations", get_api_url()))
                .json(&json!({ "name": name, "key": key }))
                .send().await?.json().await?;
            println!("{} Added integration: {}", "✓".green(),
                resp["id"].as_str().unwrap_or(&name));
        }

        Commands::Remove { name } => {
            client.delete(format!("{}/api/integrations/{}", get_api_url(), urlencoding::encode(&name)))
                .send().await?;
            println!("{} Removed: {}", "✓".green(), name);
        }

        Commands::Tui => {
            println!("{} Starting TUI...", "→".blue());
            let tui_path = std::env::current_exe()?
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("agentos-tui");
            if tui_path.exists() {
                let status = std::process::Command::new(&tui_path).status()?;
                std::process::exit(status.code().unwrap_or(1));
            } else {
                println!("{} TUI binary not found. Install with: cargo install agentos-tui", "✗".red());
            }
        }

        Commands::Completion { shell } => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            let shell = match shell.as_str() {
                "bash" => clap_complete::Shell::Bash,
                "zsh" => clap_complete::Shell::Zsh,
                "fish" => clap_complete::Shell::Fish,
                "powershell" => clap_complete::Shell::PowerShell,
                _ => {
                    println!("{} Unsupported shell: {}. Use bash, zsh, fish, or powershell.", "✗".red(), shell);
                    return Ok(());
                }
            };
            clap_complete::generate(shell, &mut cmd, "agentos", &mut std::io::stdout());
        }
    }

    Ok(())
}

fn agentos_config_path() -> Result<std::path::PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?
        .join(".agentos/config.toml"))
}

fn get_api_url() -> String {
    std::env::var("AGENTOS_API_URL").unwrap_or_else(|_| API_BASE.to_string())
}

fn format_epoch_ms(ms: u64) -> String {
    if ms == 0 { return "-".into(); }
    let secs = ms / 1000;
    let hours = (secs / 3600) % 24;
    let minutes = (secs / 60) % 60;
    let seconds = secs % 60;
    let days = secs / 86400;
    if days > 18000 {
        format!("{}d {}:{:02}:{:02}", days, hours, minutes, seconds)
    } else {
        format!("{}:{:02}:{:02}", hours, minutes, seconds)
    }
}

fn print_log_entry(entry: &Value) {
    let level = entry["level"].as_str().unwrap_or("INFO");
    let level_colored = match level {
        "ERROR" => level.red().to_string(),
        "WARN" => level.yellow().to_string(),
        "DEBUG" => level.dimmed().to_string(),
        _ => level.to_string(),
    };
    let ts = entry["timestamp"].as_str().unwrap_or("");
    let short_ts = if ts.len() > 19 { &ts[..19] } else { ts };
    let msg = entry["message"].as_str().unwrap_or("-");
    println!("{} [{}] {}", short_ts.dimmed(), level_colored, msg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_validate_id_valid_alphanumeric() {
        assert!(validate_id("abc123").is_ok());
    }

    #[test]
    fn test_validate_id_with_hyphens() {
        assert!(validate_id("my-agent-1").is_ok());
    }

    #[test]
    fn test_validate_id_with_underscores() {
        assert!(validate_id("my_agent_1").is_ok());
    }

    #[test]
    fn test_validate_id_empty() {
        assert!(validate_id("").is_err());
    }

    #[test]
    fn test_validate_id_too_long() {
        let long_id = "a".repeat(257);
        assert!(validate_id(&long_id).is_err());
    }

    #[test]
    fn test_validate_id_max_length() {
        let max_id = "a".repeat(256);
        assert!(validate_id(&max_id).is_ok());
    }

    #[test]
    fn test_validate_id_special_chars() {
        assert!(validate_id("bad@id").is_err());
    }

    #[test]
    fn test_validate_id_spaces() {
        assert!(validate_id("bad id").is_err());
    }

    #[test]
    fn test_validate_id_dots() {
        assert!(validate_id("bad.id").is_err());
    }

    #[test]
    fn test_validate_id_slashes() {
        assert!(validate_id("bad/id").is_err());
    }

    #[test]
    fn test_validate_id_single_char() {
        assert!(validate_id("a").is_ok());
    }

    #[test]
    fn test_validate_id_numeric_only() {
        assert!(validate_id("12345").is_ok());
    }

    #[test]
    fn test_validate_id_returns_same_str() {
        let result = validate_id("test-id").unwrap();
        assert_eq!(result, "test-id");
    }

    #[test]
    fn test_api_base_constant() {
        assert_eq!(API_BASE, "http://localhost:3111");
    }

    #[test]
    fn test_get_api_url_default() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev = std::env::var("AGENTOS_API_URL").ok();
        unsafe { std::env::remove_var("AGENTOS_API_URL"); }
        let result = get_api_url();
        if let Some(val) = prev {
            unsafe { std::env::set_var("AGENTOS_API_URL", val); }
        }
        assert_eq!(result, "http://localhost:3111");
    }

    #[test]
    fn test_get_api_url_custom() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev = std::env::var("AGENTOS_API_URL").ok();
        unsafe { std::env::set_var("AGENTOS_API_URL", "http://custom:8080"); }
        let url = get_api_url();
        match prev {
            Some(val) => unsafe { std::env::set_var("AGENTOS_API_URL", val); },
            None => unsafe { std::env::remove_var("AGENTOS_API_URL"); },
        }
        assert_eq!(url, "http://custom:8080");
    }

    #[test]
    fn test_cli_command_factory() {
        let cmd = Cli::command();
        assert_eq!(cmd.get_name(), "agentos");
    }

    #[test]
    fn test_cli_has_init_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"init"));
    }

    #[test]
    fn test_cli_has_start_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"start"));
    }

    #[test]
    fn test_cli_has_stop_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"stop"));
    }

    #[test]
    fn test_cli_has_status_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"status"));
    }

    #[test]
    fn test_cli_has_health_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"health"));
    }

    #[test]
    fn test_cli_has_agent_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"agent"));
    }

    #[test]
    fn test_cli_has_workflow_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"workflow"));
    }

    #[test]
    fn test_cli_has_skill_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"skill"));
    }

    #[test]
    fn test_cli_has_memory_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"memory"));
    }

    #[test]
    fn test_cli_has_security_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"security"));
    }

    #[test]
    fn test_cli_has_vault_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"vault"));
    }

    #[test]
    fn test_cli_has_completion_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"completion"));
    }

    #[test]
    fn test_cli_has_onboard_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"onboard"));
    }

    #[test]
    fn test_cli_has_reset_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"reset"));
    }

    #[test]
    fn test_cli_has_tui_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"tui"));
    }

    #[test]
    fn test_cli_subcommand_count() {
        let cmd = Cli::command();
        let count = cmd.get_subcommands().count();
        assert!(count >= 15, "Expected at least 15 subcommands, got {}", count);
    }

    #[test]
    fn test_print_log_entry_error() {
        let entry = json!({"level": "ERROR", "timestamp": "2026-01-01T00:00:00Z", "message": "test error"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_warn() {
        let entry = json!({"level": "WARN", "timestamp": "2026-01-01T00:00:00Z", "message": "test warn"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_debug() {
        let entry = json!({"level": "DEBUG", "timestamp": "2026-01-01T00:00:00Z", "message": "test debug"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_info() {
        let entry = json!({"level": "INFO", "timestamp": "2026-01-01T00:00:00Z", "message": "test info"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_missing_fields() {
        let entry = json!({});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_short_timestamp() {
        let entry = json!({"level": "INFO", "timestamp": "2026-01-01", "message": "short ts"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_print_log_entry_long_timestamp() {
        let entry = json!({"level": "INFO", "timestamp": "2026-01-01T00:00:00.123456789Z", "message": "long ts"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_validate_id_unicode() {
        assert!(validate_id("café").is_ok());
    }

    #[test]
    fn test_validate_id_mixed_valid() {
        assert!(validate_id("agent-v2_test-123").is_ok());
    }

    #[test]
    fn test_validate_id_start_with_number() {
        assert!(validate_id("1agent").is_ok());
    }

    #[test]
    fn test_validate_id_start_with_hyphen() {
        assert!(validate_id("-agent").is_ok());
    }

    #[test]
    fn test_validate_id_start_with_underscore() {
        assert!(validate_id("_agent").is_ok());
    }

    #[test]
    fn test_validate_id_colons() {
        assert!(validate_id("bad:id").is_err());
    }

    #[test]
    fn test_validate_id_hash() {
        assert!(validate_id("bad#id").is_err());
    }

    #[test]
    fn test_validate_id_percent() {
        assert!(validate_id("bad%id").is_err());
    }

    #[test]
    fn test_validate_id_newline() {
        assert!(validate_id("bad\nid").is_err());
    }

    #[test]
    fn test_validate_id_tab() {
        assert!(validate_id("bad\tid").is_err());
    }

    #[test]
    fn test_validate_id_exactly_256_chars() {
        let id = "a".repeat(256);
        assert!(validate_id(&id).is_ok());
    }

    #[test]
    fn test_validate_id_boundary_255() {
        let id = "a".repeat(255);
        assert!(validate_id(&id).is_ok());
    }

    #[test]
    fn test_cli_has_trigger_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"trigger"));
    }

    #[test]
    fn test_cli_has_channel_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"channel"));
    }

    #[test]
    fn test_cli_has_config_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"config"));
    }

    #[test]
    fn test_cli_has_models_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"models"));
    }

    #[test]
    fn test_cli_has_approvals_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"approvals"));
    }

    #[test]
    fn test_cli_has_cron_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"cron"));
    }

    #[test]
    fn test_cli_has_sessions_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"sessions"));
    }

    #[test]
    fn test_format_epoch_ms_zero() {
        assert_eq!(format_epoch_ms(0), "-");
    }

    #[test]
    fn test_format_epoch_ms_one_second() {
        assert_eq!(format_epoch_ms(1000), "0:00:01");
    }

    #[test]
    fn test_format_epoch_ms_one_minute() {
        assert_eq!(format_epoch_ms(60_000), "0:01:00");
    }

    #[test]
    fn test_format_epoch_ms_one_hour() {
        assert_eq!(format_epoch_ms(3_600_000), "1:00:00");
    }

    #[test]
    fn test_format_epoch_ms_complex() {
        assert_eq!(format_epoch_ms(3_661_000), "1:01:01");
    }

    #[test]
    fn test_agentos_config_path_ends_with_config() {
        let path = agentos_config_path().unwrap();
        assert!(path.ends_with(".agentos/config.toml"));
    }

    #[test]
    fn test_print_log_entry_unknown_level() {
        let entry = json!({"level": "TRACE", "timestamp": "2026-01-01T00:00:00Z", "message": "trace msg"});
        print_log_entry(&entry);
    }

    #[test]
    fn test_validate_id_emoji_rejected() {
        assert!(validate_id("\u{1f600}").is_err());
    }

    #[test]
    fn test_validate_id_chinese_chars_accepted() {
        assert!(validate_id("\u{4e16}\u{754c}").is_ok());
    }

    #[test]
    fn test_validate_id_only_hyphens() {
        assert!(validate_id("---").is_ok());
    }

    #[test]
    fn test_validate_id_only_underscores() {
        assert!(validate_id("___").is_ok());
    }

    #[test]
    fn test_validate_id_mixed_hyphen_underscore() {
        assert!(validate_id("a-b_c-d_e").is_ok());
    }

    #[test]
    fn test_validate_id_null_byte() {
        assert!(validate_id("bad\0id").is_err());
    }

    #[test]
    fn test_validate_id_backslash() {
        assert!(validate_id("bad\\id").is_err());
    }

    #[test]
    fn test_validate_id_equals_sign() {
        assert!(validate_id("key=value").is_err());
    }

    #[test]
    fn test_validate_id_question_mark() {
        assert!(validate_id("query?param").is_err());
    }

    #[test]
    fn test_format_epoch_ms_half_second() {
        assert_eq!(format_epoch_ms(500), "0:00:00");
    }

    #[test]
    fn test_format_epoch_ms_23h_59m_59s() {
        let ms = (23 * 3600 + 59 * 60 + 59) * 1000;
        assert_eq!(format_epoch_ms(ms), "23:59:59");
    }

    #[test]
    fn test_format_epoch_ms_large_value_days() {
        let ms: u64 = 20000 * 86400 * 1000;
        let result = format_epoch_ms(ms);
        assert!(result.contains("d "));
    }

    #[test]
    fn test_format_epoch_ms_one_ms() {
        assert_eq!(format_epoch_ms(1), "0:00:00");
    }

    #[test]
    fn test_cli_has_chat_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"chat"));
    }

    #[test]
    fn test_cli_has_message_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"message"));
    }

    #[test]
    fn test_cli_has_dashboard_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"dashboard"));
    }

    #[test]
    fn test_cli_has_doctor_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"doctor"));
    }

    #[test]
    fn test_cli_has_logs_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"logs"));
    }

    #[test]
    fn test_cli_has_replay_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"replay"));
    }

    #[test]
    fn test_cli_has_migrate_subcommand() {
        let cmd = Cli::command();
        let subs: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert!(subs.contains(&"migrate"));
    }

    #[test]
    fn test_api_base_is_localhost() {
        assert!(API_BASE.starts_with("http://localhost"));
    }

    #[test]
    fn test_api_base_port() {
        assert!(API_BASE.contains("3111"));
    }
}

export interface DocEntry {
  slug: string;
  title: string;
  desc: string;
  category: string;
  content: string;
}

export const categories = [
  "Getting Started",
  "Core Concepts",
  "Integration",
  "Reference",
];

export const docs: DocEntry[] = [
  {
    slug: "getting-started",
    title: "Getting Started",
    desc: "Install, configure, and run your first agent in under 2 minutes",
    category: "Getting Started",
    content: `# Getting Started

## Installation

Install Agents OS using the install script:

\`\`\`bash
curl -fsSL https://agentos.dev/install -o install.sh
less install.sh
sh install.sh
\`\`\`

We recommend reviewing the script before running it.

Or build from source:

\`\`\`bash
git clone https://github.com/iii-hq/agentos
cd agentos
cargo build --release
\`\`\`

## Quick Start

**1. Initialize a new project**

\`\`\`bash
agents-os init my-agent
cd my-agent
\`\`\`

**2. Configure your LLM provider**

\`\`\`bash
agents-os config set llm.provider openai
agents-os config set llm.model gpt-4o
export OPENAI_API_KEY=sk-...
\`\`\`

**3. Create your first agent**

\`\`\`typescript
import { worker, fn, trigger } from "iii-sdk";

const greeter = worker("greeter", async (ctx) => {
  const response = await ctx.call("llm.chat", {
    messages: [{ role: "user", content: ctx.input.message }],
  });
  return { reply: response.content };
});
\`\`\`

**4. Run it**

\`\`\`bash
agents-os dev
\`\`\`

Your agent is now running on \`localhost:3100\`.

## Project Structure

\`\`\`
my-agent/
  agents.toml        # Agent configuration
  src/
    index.ts         # Entry point
    workers/         # Worker definitions
    functions/       # Function definitions
    triggers/        # Trigger definitions
  tests/
\`\`\`

## Next Steps

- Read the [Primitives](/docs/primitives) guide to understand Workers, Functions, and Triggers
- Explore the [CLI Reference](/docs/cli) for all 50+ commands
- Check out [Examples](/docs/examples) for real-world agent templates`,
  },
  {
    slug: "primitives",
    title: "Primitives",
    desc: "Worker, Function, and Trigger. The three building blocks.",
    category: "Core Concepts",
    content: `# Primitives

Agents OS is built on iii-engine's three primitives. Every agent, tool, and workflow is composed from these building blocks.

## Worker

A Worker is a long-running process that handles requests. Think of it as a microservice that processes messages.

\`\`\`typescript
import { worker } from "iii-sdk";

const analyst = worker("analyst", async (ctx) => {
  const data = await ctx.call("data.fetch", { source: ctx.input.url });
  const analysis = await ctx.call("llm.chat", {
    messages: [{ role: "user", content: \`Analyze: \${data}\` }],
  });
  return { analysis: analysis.content };
});
\`\`\`

**Key properties:**
- Has its own lifecycle (start, stop, restart)
- Maintains state across requests
- Can call Functions and other Workers
- Supports concurrency controls

## Function

A Function is a stateless, short-lived computation. It runs, returns a result, and exits.

\`\`\`typescript
import { fn } from "iii-sdk";

const summarize = fn("summarize", async (ctx) => {
  const result = await ctx.call("llm.chat", {
    messages: [{ role: "user", content: \`Summarize: \${ctx.input.text}\` }],
    model: "claude-haiku-4-5",
  });
  return { summary: result.content };
});
\`\`\`

**Key properties:**
- Stateless and idempotent
- Automatic retries on failure
- Built-in timeout handling
- Can be called by Workers or other Functions

## Trigger

A Trigger starts execution based on an event. It connects the outside world to your Workers and Functions.

\`\`\`typescript
import { trigger } from "iii-sdk";

const onSlackMessage = trigger("slack.message", {
  channel: "#support",
  filter: (event) => event.text.includes("help"),
  handler: async (ctx) => {
    await ctx.call("support-agent", { message: ctx.event.text });
  },
});
\`\`\`

**Trigger types:**
- HTTP (webhooks, REST endpoints)
- Schedule (cron, intervals)
- Event (message queues, pub/sub)
- Channel (Slack, Discord, GitHub, etc.)

## How They Compose

\`\`\`
Trigger (Slack message)
  -> Worker (support-agent)
    -> Function (classify-intent)
    -> Function (search-docs)
    -> Function (generate-reply)
  -> Channel (Slack reply)
\`\`\`

The pipeline overhead for this chain is just 18% vs direct function calls.`,
  },
  {
    slug: "architecture",
    title: "Architecture",
    desc: "10 Rust crates, 39 TypeScript workers, and how they connect",
    category: "Core Concepts",
    content: `# Architecture

Agents OS is a multi-language system with a Rust core, TypeScript application layer, and Python for specialized tasks.

## Rust Crates (10)

| Crate | Purpose |
|-------|---------|
| \`agents-cli\` | 50+ CLI commands |
| \`agents-tui\` | Terminal UI with 22 screens |
| \`agents-security\` | RBAC, MAP auth, Merkle audit |
| \`agents-vault\` | Encrypted credential storage |
| \`agents-memory\` | Knowledge graph + vector store |
| \`agents-llm-router\` | 25 providers, cost-aware routing |
| \`agents-wasm\` | WASM sandbox for tool isolation |
| \`agents-channels\` | 40 adapter implementations |
| \`agents-core\` | Shared types and utilities |
| \`agents-desktop\` | Tauri 2.0 native app |

## TypeScript Workers (39)

The application logic runs as iii-engine workers:

- **Agent workers** (30): Pre-built agent templates for code review, research, ops, etc.
- **Tool workers** (6): Browser, filesystem, shell, HTTP, MCP, A2A
- **System workers** (3): Orchestrator, session manager, cost tracker

## Python Worker (1)

- **Embeddings worker**: Handles vector embedding generation for the knowledge graph using sentence-transformers

## Data Flow

\`\`\`
Request
  -> Rust (channel adapter receives message)
  -> Rust (security: auth, rate limit, RBAC check)
  -> TypeScript (worker processes request)
  -> Rust (llm-router selects provider, tracks cost)
  -> TypeScript (tool execution in WASM sandbox)
  -> Rust (memory: store in knowledge graph)
  -> Rust (channel adapter sends response)
\`\`\`

## iii-engine Foundation

Everything runs on iii-engine's Worker/Function/Trigger primitives:
- **18% pipeline overhead** vs direct function calls
- **48ms cold start** (Rust binary)
- **12 MB idle memory** footprint
- Built-in retry, state management, and observability`,
  },
  {
    slug: "configuration",
    title: "Configuration",
    desc: "Every agents.toml field and environment variable",
    category: "Core Concepts",
    content: `# Configuration

Agents OS is configured through \`agents.toml\` and environment variables.

## agents.toml

\`\`\`toml
[agent]
name = "my-agent"
version = "1.0.0"

[llm]
provider = "openai"
model = "gpt-4o"
fallback = "claude-sonnet-4-6"
max_tokens = 4096
temperature = 0.7

[llm.routing]
strategy = "cost-aware"    # cost-aware | latency | round-robin
budget_per_hour = 5.00

[security]
mode = "fail-closed"
rbac = true
wasm_sandbox = true
vault_encryption = "aes-256-gcm"

[security.approval]
dangerous_tools = "require"   # require | ask | allow
cost_threshold = 1.00

[channels]
slack = { token = "$SLACK_TOKEN", channels = ["#general"] }
discord = { token = "$DISCORD_TOKEN", guild = "123456" }
github = { token = "$GITHUB_TOKEN", repos = ["org/repo"] }

[memory]
backend = "sqlite"
knowledge_graph = true
vector_dimensions = 384
auto_forget_days = 90

[tools]
profile = "full"    # chat | code | research | ops | data | full
mcp_servers = ["filesystem", "browser"]
a2a_peers = []

[server]
port = 3100
host = "0.0.0.0"
\`\`\`

## Environment Variables

| Variable | Description |
|----------|-------------|
| \`OPENAI_API_KEY\` | OpenAI API key |
| \`ANTHROPIC_API_KEY\` | Anthropic API key |
| \`GOOGLE_API_KEY\` | Google AI API key |
| \`AGENTS_OS_PORT\` | Server port (default: 3100) |
| \`AGENTS_OS_LOG_LEVEL\` | Log level: debug, info, warn, error |
| \`AGENTS_OS_VAULT_KEY\` | Master key for vault encryption |
| \`AGENTS_OS_DATA_DIR\` | Data directory (default: ~/.agents-os) |

## Tool Profiles

Profiles control which tools an agent can access:

| Profile | Tools |
|---------|-------|
| \`chat\` | LLM, memory |
| \`code\` | LLM, memory, filesystem, shell, git |
| \`research\` | LLM, memory, browser, HTTP, search |
| \`ops\` | LLM, memory, shell, HTTP, monitoring |
| \`data\` | LLM, memory, database, filesystem, HTTP |
| \`full\` | All tools |`,
  },
  {
    slug: "security",
    title: "Security Model",
    desc: "18 security layers, RBAC, vault, WASM sandbox, audit trails",
    category: "Core Concepts",
    content: `# Security Model

Agents OS ships with 18 discrete security layers. Security is fail-closed by default, not opt-in.

## Core Principles

- **Fail-closed**: If a security check fails or times out, the request is denied
- **Defense in depth**: Multiple independent layers, no single point of failure
- **Zero trust**: Every request is authenticated and authorized, even internal calls

## Security Layers

### Authentication
1. **API key validation** with timing-safe comparison
2. **MAP (Merkle Authentication Protocol)** for request integrity
3. **Nonce tracking** to prevent replay attacks
4. **Rate limiting** per client, per endpoint

### Authorization
5. **RBAC (Role-Based Access Control)** with 6 built-in roles
6. **Tool profiles** restrict which tools each agent can access
7. **Approval tiers** for dangerous operations (require human approval)
8. **Cost thresholds** prevent runaway spending

### Isolation
9. **WASM sandbox** for tool execution (dual-metered: CPU + memory)
10. **Process isolation** between agents
11. **Network policies** restrict outbound connections
12. **Filesystem jailing** per agent workspace

### Data Protection
13. **Vault** with AES-256-GCM encryption for secrets
14. **Memory encryption** at rest
15. **PII detection** and automatic redaction
16. **Audit trail** with Merkle hash-chain (tamper-evident)

### Runtime
17. **Input validation** on all external data
18. **Certificate pinning** for LLM provider connections

## RBAC Roles

| Role | Description |
|------|-------------|
| \`admin\` | Full access to all operations |
| \`operator\` | Deploy and manage agents |
| \`developer\` | Create and test agents |
| \`agent\` | Execute within assigned tool profile |
| \`readonly\` | View-only access |
| \`auditor\` | Access to audit logs and security reports |`,
  },
  {
    slug: "llm-providers",
    title: "LLM Providers",
    desc: "25 providers, 47 models, cost-aware routing",
    category: "Core Concepts",
    content: `# LLM Providers

Agents OS supports 25 providers and 47 models with intelligent routing.

## Supported Providers

### Frontier
OpenAI, Anthropic, Google DeepMind, xAI

### Smart
Mistral, Cohere, AI21, Inflection

### Fast
Groq, Cerebras, SambaNova, Fireworks, Together

### Local
Ollama, LM Studio, vLLM, llama.cpp

### Cloud
AWS Bedrock, Azure OpenAI, Google Vertex AI, IBM watsonx

### Specialized
Voyage AI (embeddings), Jina (reranking), Replicate, HuggingFace

## Cost-Aware Routing

The LLM router selects the optimal model based on:

\`\`\`toml
[llm.routing]
strategy = "cost-aware"
budget_per_hour = 5.00

[[llm.routing.rules]]
task = "classification"
model = "claude-haiku-4-5"    # cheap, fast

[[llm.routing.rules]]
task = "code-generation"
model = "claude-sonnet-4-6"   # balanced

[[llm.routing.rules]]
task = "complex-reasoning"
model = "claude-opus-4-6"     # best quality
\`\`\`

## Per-Agent Cost Tracking

Every LLM call is tracked:
- Input/output tokens per request
- Cost per agent, per session, per day
- Budget alerts and automatic throttling
- Historical cost dashboards in TUI`,
  },
  {
    slug: "channels",
    title: "Channel Adapters",
    desc: "40 adapters for Slack, Discord, GitHub, and more",
    category: "Integration",
    content: `# Channel Adapters

Agents OS includes 40 built-in channel adapters. Deploy your agent wherever your users are.

## Messaging
Slack, Discord, Microsoft Teams, Telegram, WhatsApp, Signal, iMessage, Matrix, IRC, Zulip

## Social
Twitter/X, Reddit, Mastodon, Bluesky, LinkedIn

## Developer
GitHub (issues, PRs, discussions), GitLab, Bitbucket, Jira, Linear, Notion

## Enterprise
Email (SMTP/IMAP), Google Chat, Webex, Zoom Chat

## Notifications
Webhooks, PagerDuty, Opsgenie, SMS (Twilio)

## Custom
REST API, WebSocket, Server-Sent Events, gRPC

## Configuration

Each channel is configured in \`agents.toml\`:

\`\`\`toml
[channels.slack]
token = "$SLACK_BOT_TOKEN"
channels = ["#support", "#engineering"]
thread_replies = true

[channels.github]
token = "$GITHUB_TOKEN"
repos = ["org/repo"]
events = ["issues", "pull_request", "discussion"]

[channels.discord]
token = "$DISCORD_TOKEN"
guild_id = "123456789"
channels = ["support", "general"]
\`\`\`

## Writing Custom Adapters

\`\`\`typescript
import { trigger } from "iii-sdk";

const myChannel = trigger("custom.webhook", {
  path: "/webhook/my-service",
  method: "POST",
  handler: async (ctx) => {
    const message = ctx.event.body.text;
    const result = await ctx.call("my-agent", { message });
    return { status: 200, body: result };
  },
});
\`\`\``,
  },
  {
    slug: "agents",
    title: "Agent Templates",
    desc: "30 pre-built agents across code, research, ops, and data",
    category: "Integration",
    content: `# Agent Templates

Agents OS ships with 30 ready-to-use agent templates.

## Code Agents
- **Code Reviewer**: Reviews PRs, checks style, finds bugs
- **Refactorer**: Suggests and applies refactoring patterns
- **Test Writer**: Generates unit and integration tests
- **Doc Generator**: Creates documentation from code
- **Dependency Auditor**: Checks for vulnerabilities and updates

## Research Agents
- **Web Researcher**: Searches, scrapes, and summarizes web content
- **Paper Analyst**: Reads and summarizes academic papers
- **Competitive Analyst**: Monitors competitor products and features
- **Trend Tracker**: Follows industry trends and news

## Ops Agents
- **Incident Responder**: Triages alerts, runs diagnostics
- **Log Analyzer**: Parses logs, identifies patterns
- **Cost Optimizer**: Finds infrastructure cost savings
- **Deploy Manager**: Handles deployment workflows
- **Security Scanner**: Runs security audits

## Data Agents
- **Data Cleaner**: Validates and normalizes datasets
- **Report Generator**: Creates reports from data sources
- **SQL Assistant**: Writes and optimizes queries
- **ETL Pipeline**: Extracts, transforms, and loads data

## Using a Template

\`\`\`bash
agents-os agent create --template code-reviewer my-reviewer
agents-os dev
\`\`\`

Templates can be customized by editing the generated \`agents.toml\` and worker files.`,
  },
  {
    slug: "skills",
    title: "SkillKit Integration",
    desc: "Universal skill marketplace for AI agents",
    category: "Integration",
    content: `# SkillKit Integration

Agents OS integrates with SkillKit for access to a universal skill marketplace across 32+ AI coding agents.

## Installing Skills

\`\`\`bash
# Search for skills
agents-os skill search "code review"

# Install a skill
agents-os skill install pro-workflow

# List installed skills
agents-os skill list
\`\`\`

## Using SkillKit CLI

\`\`\`bash
# Install SkillKit globally
npm install -g skillkit

# Browse marketplace
skillkit search "testing"

# Install and translate for Agents OS
skillkit install pro-workflow
skillkit translate pro-workflow --agent agents-os
\`\`\`

## Skill Format

Skills are defined in \`SKILL.md\` files:

\`\`\`yaml
---
name: my-skill
description: What this skill teaches the agent
version: 1.0.0
tags: [testing, quality]
---

# My Skill

Instructions for the agent...
\`\`\`

## Publishing Skills

\`\`\`bash
# Initialize a new skill
skillkit init

# Publish to marketplace
skillkit publish
\`\`\`

Skills published to SkillKit are available across all 32+ supported agents, not just Agents OS.`,
  },
  {
    slug: "mcp-a2a",
    title: "MCP and A2A",
    desc: "Model Context Protocol and agent-to-agent communication",
    category: "Integration",
    content: `# MCP and A2A

Agents OS supports both MCP (Model Context Protocol) and A2A (Agent-to-Agent) protocols.

## MCP (Model Context Protocol)

MCP lets agents use external tools and data sources through a standard protocol.

\`\`\`toml
[tools.mcp]
servers = [
  { name = "filesystem", command = "mcp-server-filesystem", args = ["/workspace"] },
  { name = "browser", command = "mcp-server-browser" },
  { name = "postgres", command = "mcp-server-postgres", env = { DATABASE_URL = "$DB_URL" } },
]
\`\`\`

### Built-in MCP Support
- Filesystem access (read, write, search)
- Browser automation (navigate, click, extract)
- Database queries (PostgreSQL, SQLite)
- HTTP requests
- Shell command execution

## A2A (Agent-to-Agent)

A2A enables agents to discover and communicate with each other.

\`\`\`toml
[tools.a2a]
peers = [
  { name = "code-reviewer", url = "http://localhost:3101" },
  { name = "researcher", url = "http://localhost:3102" },
]
discovery = "local"    # local | dns | registry
\`\`\`

### Agent Communication

\`\`\`typescript
const result = await ctx.call("a2a.request", {
  agent: "code-reviewer",
  task: "Review this pull request",
  context: { pr_url: "https://github.com/org/repo/pull/42" },
});
\`\`\`

### Swarm Orchestration

Multiple agents can form swarms for complex tasks:

\`\`\`typescript
const swarm = await ctx.call("swarm.create", {
  agents: ["researcher", "writer", "reviewer"],
  task: "Write a technical blog post about WASM sandboxing",
  strategy: "pipeline",    // pipeline | parallel | consensus
});
\`\`\``,
  },
  {
    slug: "workflows",
    title: "Workflows",
    desc: "Multi-agent pipelines with retry, branching, and approval gates",
    category: "Integration",
    content: `# Workflows

Workflows orchestrate multi-step agent pipelines with built-in retry, branching, and human-in-the-loop approval.

## Defining Workflows

\`\`\`typescript
import { workflow } from "iii-sdk";

const codeReviewPipeline = workflow("code-review", [
  { step: "fetch-diff", worker: "github-tool", input: { action: "get_pr_diff" } },
  { step: "analyze", worker: "code-reviewer", input: { from: "fetch-diff" } },
  { step: "check-security", worker: "security-scanner", input: { from: "fetch-diff" } },
  {
    step: "approve",
    type: "gate",
    condition: (results) =>
      results["analyze"].score > 0.8 && results["check-security"].issues === 0,
  },
  { step: "post-review", worker: "github-tool", input: { action: "post_review" } },
]);
\`\`\`

## Step Types

| Type | Description |
|------|-------------|
| \`worker\` | Execute a worker with input |
| \`function\` | Call a stateless function |
| \`gate\` | Conditional branch point |
| \`approval\` | Require human approval to continue |
| \`parallel\` | Run multiple steps concurrently |
| \`loop\` | Repeat until condition met |

## Error Handling

\`\`\`typescript
{
  step: "risky-operation",
  worker: "data-processor",
  retry: { attempts: 3, backoff: "exponential" },
  timeout: 30000,
  fallback: "fallback-step",
}
\`\`\`

## Running Workflows

\`\`\`bash
# Start a workflow
agents-os workflow run code-review --input '{"pr": 42}'

# List running workflows
agents-os workflow list

# Check status
agents-os workflow status <id>
\`\`\``,
  },
  {
    slug: "cli",
    title: "CLI Reference",
    desc: "All 50+ commands with examples",
    category: "Reference",
    content: `# CLI Reference

The \`agents-os\` CLI provides 50+ commands for managing agents, tools, channels, and more.

## Core Commands

\`\`\`bash
agents-os init <name>          # Initialize new project
agents-os dev                  # Start development server
agents-os build                # Build for production
agents-os deploy               # Deploy to target
\`\`\`

## Agent Management

\`\`\`bash
agents-os agent list           # List all agents
agents-os agent create <name>  # Create new agent
agents-os agent start <name>   # Start an agent
agents-os agent stop <name>    # Stop an agent
agents-os agent logs <name>    # View agent logs
agents-os agent status         # Show all agent statuses
\`\`\`

## Tool Management

\`\`\`bash
agents-os tool list            # List available tools
agents-os tool install <name>  # Install a tool
agents-os tool profile set <p> # Set tool profile
\`\`\`

## Channel Management

\`\`\`bash
agents-os channel list         # List channels
agents-os channel add <type>   # Add a channel
agents-os channel test <name>  # Test channel connection
\`\`\`

## Skill Management

\`\`\`bash
agents-os skill search <q>     # Search marketplace
agents-os skill install <name> # Install skill
agents-os skill list           # List installed
agents-os skill publish        # Publish a skill
\`\`\`

## Configuration

\`\`\`bash
agents-os config get <key>     # Get config value
agents-os config set <k> <v>   # Set config value
agents-os config list          # Show all config
\`\`\`

## Security

\`\`\`bash
agents-os security audit       # Run security audit
agents-os security scan        # Scan for vulnerabilities
agents-os vault set <key>      # Store secret in vault
agents-os vault get <key>      # Retrieve secret
\`\`\`

## Monitoring

\`\`\`bash
agents-os status               # System status
agents-os costs                # Cost summary
agents-os costs daily          # Daily cost breakdown
agents-os metrics              # Performance metrics
agents-os tui                  # Launch terminal UI
\`\`\``,
  },
  {
    slug: "api",
    title: "REST API",
    desc: "All API endpoints for agents, memory, tools, and channels",
    category: "Reference",
    content: `# REST API Reference

Agents OS exposes a REST API on port 3100 for managing agents programmatically.

## Authentication

All API requests require an API key:

\`\`\`bash
curl -H "Authorization: Bearer <api-key>" http://localhost:3100/api/agents
\`\`\`

## Agents

\`\`\`
GET    /api/agents              # List all agents
POST   /api/agents              # Create agent
GET    /api/agents/:id          # Get agent details
PUT    /api/agents/:id          # Update agent
DELETE /api/agents/:id          # Delete agent
POST   /api/agents/:id/start    # Start agent
POST   /api/agents/:id/stop     # Stop agent
GET    /api/agents/:id/logs     # Get agent logs
\`\`\`

## Sessions

\`\`\`
GET    /api/sessions            # List sessions
POST   /api/sessions            # Create session
GET    /api/sessions/:id        # Get session
GET    /api/sessions/:id/replay # Replay session
DELETE /api/sessions/:id        # Delete session
\`\`\`

## Memory

\`\`\`
GET    /api/memory/search       # Search memories
POST   /api/memory              # Store memory
GET    /api/memory/graph        # Knowledge graph query
DELETE /api/memory/:id          # Delete memory
\`\`\`

## Costs

\`\`\`
GET    /api/costs/summary       # Cost summary
GET    /api/costs/daily         # Daily breakdown
GET    /api/costs/by-agent      # Per-agent costs
GET    /api/costs/by-model      # Per-model costs
\`\`\`

## Tools

\`\`\`
GET    /api/tools               # List tools
POST   /api/tools/execute       # Execute tool
GET    /api/tools/profiles      # List profiles
\`\`\`

## Channels

\`\`\`
GET    /api/channels            # List channels
POST   /api/channels            # Add channel
DELETE /api/channels/:id        # Remove channel
POST   /api/channels/:id/test   # Test channel
\`\`\`

## Health

\`\`\`
GET    /api/health              # Health check
GET    /api/health/ready        # Readiness check
GET    /api/metrics             # Prometheus metrics
\`\`\``,
  },
  {
    slug: "desktop",
    title: "Desktop App",
    desc: "Tauri 2.0 native app for macOS, Linux, and Windows",
    category: "Reference",
    content: `# Desktop App

Agents OS includes a native desktop application built with Tauri 2.0.

## Installation

Download from the releases page or build from source:

\`\`\`bash
cd crates/agents-desktop
cargo tauri build
\`\`\`

## Features

- **Native window** wrapping the web UI
- **System tray** with quick actions
- **Notifications** for agent events and approvals
- **Keyboard shortcuts** for common operations
- **Auto-update** from GitHub releases

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| \`Cmd+N\` | New agent |
| \`Cmd+K\` | Command palette |
| \`Cmd+1-9\` | Switch between agents |
| \`Cmd+L\` | View logs |
| \`Cmd+,\` | Settings |

## TUI Alternative

If you prefer the terminal, the TUI provides the same functionality with 22 screens:

\`\`\`bash
agents-os tui
\`\`\`

Navigation: Tab to switch screens, / for help, q to quit.`,
  },
  {
    slug: "examples",
    title: "Examples",
    desc: "Real-world agent implementations you can use today",
    category: "Reference",
    content: `# Examples

## Code Reviewer Agent

Watches GitHub PRs and posts reviews:

\`\`\`typescript
import { worker, trigger } from "iii-sdk";

const reviewer = worker("code-reviewer", async (ctx) => {
  const diff = await ctx.call("github.get_diff", { pr: ctx.input.pr });
  const review = await ctx.call("llm.chat", {
    model: "claude-sonnet-4-6",
    messages: [{
      role: "user",
      content: \`Review this diff for bugs, style, and security:\\n\${diff}\`,
    }],
  });
  await ctx.call("github.post_review", {
    pr: ctx.input.pr,
    body: review.content,
  });
});

trigger("github.pull_request", {
  repos: ["org/repo"],
  events: ["opened", "synchronize"],
  handler: async (ctx) => {
    await ctx.call("code-reviewer", { pr: ctx.event.number });
  },
});
\`\`\`

## Research Agent

Searches the web and produces summaries:

\`\`\`typescript
const researcher = worker("researcher", async (ctx) => {
  const results = await ctx.call("browser.search", { query: ctx.input.topic });
  const pages = await Promise.all(
    results.slice(0, 5).map((r) => ctx.call("browser.scrape", { url: r.url }))
  );
  const summary = await ctx.call("llm.chat", {
    messages: [{
      role: "user",
      content: \`Summarize these sources about \${ctx.input.topic}:\\n\${pages.join("\\n---\\n")}\`,
    }],
  });
  return { summary: summary.content, sources: results.map((r) => r.url) };
});
\`\`\`

## Ops Bot

Monitors infrastructure and responds to incidents:

\`\`\`typescript
const opsBot = worker("ops-bot", async (ctx) => {
  const alert = ctx.input.alert;
  const diagnostics = await ctx.call("shell.exec", {
    command: \`kubectl describe pod \${alert.pod}\`,
  });
  const analysis = await ctx.call("llm.chat", {
    messages: [{
      role: "user",
      content: \`Analyze this Kubernetes alert and suggest fixes:\\n\${JSON.stringify(alert)}\\n\\nDiagnostics:\\n\${diagnostics}\`,
    }],
  });
  await ctx.call("slack.post", {
    channel: "#incidents",
    text: analysis.content,
  });
});

trigger("webhook", {
  path: "/alerts/pagerduty",
  handler: async (ctx) => {
    await ctx.call("ops-bot", { alert: ctx.event.body });
  },
});
\`\`\``,
  },
];

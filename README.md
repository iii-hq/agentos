# AgentOS

Agent Operating System built on three primitives: **Worker**, **Function**, **Trigger**.

**60+ tools** · **2,419 tests** · **25 LLM providers** · **47 models** · **40 channels** · **28K LOC**

Every capability — agents, memory, security, LLM routing, workflows, tools, swarms, knowledge graphs, session replay, vault — is a plain function registered on an [iii-engine](https://iii.dev) bus. No frameworks, no vendor lock-in, no magic.

```
┌──────────────────────────────────────────────────────────────┐
│                        iii-engine                            │
│              Worker · Function · Trigger                     │
├─────────┬───────────┬───────────┬───────────┬────────────────┤
│ agent   │ security  │    llm    │  memory   │     wasm       │
│ core    │  rbac     │  router   │  store    │    sandbox     │
│ workflow│  audit    │ 25 LLMs   │  session  │   (wasmtime)   │
│ api     │  taint    │  catalog  │  recall   │    (Rust)      │
│ hand    │  sign     │   (Rust)  │  (Rust)   │                │
│ (Rust)  │  (Rust)   │           │           │                │
├─────────┴───────────┴───────────┴───────────┴────────────────┤
│  api · workflows · tools(60+) · skills · channels · hooks    │
│  approval · streaming · mcp · a2a · vault · browser · swarm  │
│  knowledge-graph · session-replay · skillkit · tool-profiles │
│                      (TypeScript)                            │
├──────────────────────────────────────────────────────────────┤
│                    embedding (Python)                        │
├──────────────────────────────────────────────────────────────┤
│     CLI (Rust)              TUI (Rust/ratatui)               │
├──────────────────────────────────────────────────────────────┤
│ 45 agents · 7 hands · 25 integrations · 40 channels          │
│ 8 tool profiles · 47 models · 22 TUI screens                 │
└──────────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
# 1. Start the engine
iii --config config.yaml

# 2. Start Rust workers (hot path)
cargo run --release -p agentos-core &
cargo run --release -p agentos-security &
cargo run --release -p agentos-memory &
cargo run --release -p agentos-llm-router &
cargo run --release -p agentos-wasm-sandbox &

# 3. Start TypeScript workers
npx tsx src/api.ts &
npx tsx src/agent-core.ts &
npx tsx src/tools.ts &
npx tsx src/workflow.ts &

# 4. Start Python embedding worker
python workers/embedding/main.py &

# 5. Chat with an agent
cargo run -p agentos-cli -- chat default
```

Or use the CLI:

```bash
cargo run -p agentos-cli -- init --quick
cargo run -p agentos-cli -- start
cargo run -p agentos-cli -- message default "What can you do?"
```

## Architecture

**Polyglot by design** — Rust for hot path, TypeScript for iteration speed, Python for ML.

Every component connects to the iii-engine over WebSocket and registers functions. Functions call other functions via `trigger()`. That's it.

### Rust Crates (10)

| Crate | Purpose | LOC |
|-------|---------|-----|
| `agent-core` | ReAct agent loop — orchestrates LLM calls, tool execution, memory | ~320 |
| `security` | RBAC, Merkle audit chain, taint tracking, Ed25519 signing, tool policy, Docker sandbox | ~700 |
| `memory` | Session/episodic memory, recall, consolidation, eviction | ~840 |
| `llm-router` | Routes to 25 LLM providers with complexity-based model selection | ~320 |
| `wasm-sandbox` | Executes untrusted code in WASM via wasmtime | ~180 |
| `cli` | 50+ commands across 15 subcommand groups | ~700 |
| `tui` | 22-screen terminal dashboard (ratatui) | ~330 |
| `api` | Rust HTTP API layer | ~200 |
| `hand-runner` | Autonomous hand execution engine | ~150 |
| `workflow` | Rust workflow step execution | ~200 |

### TypeScript Workers (39)

| Worker | Purpose |
|--------|---------|
| `api.ts` | OpenAI-compatible REST API |
| `agent-core.ts` | Agent loop with fail-closed security gates |
| `workflow.ts` | Multi-step workflow engine (5 step modes) |
| `tools.ts` | Built-in tool registry (22 tools) |
| `tools-extended.ts` | Extended tools (38 tools: scheduling, media, data, system, code) |
| `security.ts` | Prompt injection scanning, content filtering |
| `security-map.ts` | Mutual Authentication Protocol (MAP) with timing-safe HMAC |
| `security-headers.ts` | HTTP security headers |
| `security-zeroize.ts` | Sensitive data auto-zeroing |
| `skills.ts` | Skill discovery and execution |
| `skill-security.ts` | Skill manifest validation and sandboxing |
| `skillkit-bridge.ts` | SkillKit marketplace integration (15K+ skills) |
| `streaming.ts` | SSE streaming for chat responses |
| `approval.ts` | Human-in-the-loop approval gates |
| `approval-tiers.ts` | Auto/async/sync approval tier classification |
| `memory.ts` | TypeScript memory layer |
| `llm-router.ts` | 25-provider LLM routing with complexity scoring |
| `model-catalog.ts` | 47 models with pricing and capability metadata |
| `mcp-client.ts` | Model Context Protocol client |
| `a2a.ts` | Agent-to-Agent protocol (JSON-RPC 2.0) |
| `a2a-cards.ts` | A2A agent card discovery |
| `vault.ts` | AES-256-GCM encrypted vault with PBKDF2 key derivation |
| `browser.ts` | Headless browser automation with SSRF protection |
| `context-manager.ts` | Context window budget management |
| `context-monitor.ts` | Token usage monitoring |
| `cost-tracker.ts` | Per-agent cost tracking |
| `hooks.ts` | Lifecycle hook execution (8 hook types) |
| `rate-limiter.ts` | GCRA rate limiting |
| `loop-guard.ts` | Infinite loop detection with circuit breaker |
| `swarm.ts` | Multi-agent swarm coordination |
| `knowledge-graph.ts` | Entity-relation knowledge graph |
| `session-replay.ts` | Session action recording and playback |
| `tool-profiles.ts` | Tool filtering profiles (8 profiles) |
| `hand-runner.ts` | Autonomous hand execution |
| `migration.ts` | Framework migration utilities |
| `dashboard.ts` | Dashboard data aggregation |
| `telemetry.ts` | OpenTelemetry metrics |
| `code-agent.ts` | Specialized coding agent |
| `channels/*.ts` | 40 channel adapters |

### Python Workers (1)

| Worker | Purpose |
|--------|---------|
| `embedding/main.py` | Text embeddings via SentenceTransformers (fallback: hash-based) |

## Tools (60+)

Tools are organized into categories and filtered by profile to optimize token usage:

| Category | Count | Examples |
|----------|-------|---------|
| File Operations | 6 | read, write, list, search, apply_patch, watch |
| Web | 4 | search, fetch, screenshot, browser actions |
| Code | 5 | analyze, format, lint, test, explain |
| Shell | 2 | exec, spawn |
| Data | 8 | json_parse/stringify/query/transform, csv_parse/stringify, yaml_parse/stringify |
| Memory | 3 | store, recall, search |
| Scheduling | 4 | schedule_reminder, cron_create/list/delete |
| Collaboration | 4 | todo_create/list/update/delete |
| Media | 5 | image_analyze, audio_transcribe, tts_speak, media_download, image_generate_prompt |
| Knowledge Graph | 3 | kg_add, kg_query, kg_visualize |
| Inter-Agent | 3 | agent_list, agent_delegate, channel_send |
| System | 5 | env_get, system_info, process_list, disk_usage, network_check |
| Utility | 4 | uuid_generate, hash_compute, regex_match/replace |
| Database | 4 | db_query, db_insert, db_update, db_delete |

### Tool Profiles

Profiles filter tools per agent to reduce token overhead:

| Profile | Tools Included |
|---------|---------------|
| `chat` | web_search, web_fetch, memory_recall, memory_store |
| `code` | file_*, shell_exec, code_*, apply_patch |
| `research` | web_*, browser_*, memory_* |
| `ops` | shell_exec, system_*, process_*, disk_*, network_* |
| `data` | json_*, csv_*, yaml_*, regex_*, file_* |
| `full` | All tools |

## Swarms

Multi-agent swarm coordination for complex tasks:

```typescript
trigger("swarm::create", {
  goal: "Research and write a technical blog post",
  agents: ["researcher", "writer", "editor"],
  strategy: "sequential"
})
```

Strategies: `parallel`, `sequential`, `consensus`, `hierarchical`.

## Knowledge Graph

Entity-relation graph for structured knowledge:

```typescript
trigger("kg::add_entity", { type: "project", name: "agentos", properties: { ... } })
trigger("kg::add_relation", { from: "agentos", to: "iii-engine", type: "built_on" })
trigger("kg::query", { entity: "agentos", depth: 2 })
```

## Session Replay

Record and replay full agent sessions for debugging:

```typescript
trigger("replay::record", { sessionId, agentId, action: "tool_call", data: { toolId, args } })
trigger("replay::get", { sessionId })
trigger("replay::summary", { sessionId })
```

## CLI Commands

```
agentos init [--quick]          Initialize project
agentos start                   Start all workers
agentos stop                    Stop all workers
agentos status [--json]         Show system status
agentos health [--json]         Health check
agentos doctor [--json] [--repair]  Diagnose issues

agentos agent new [template]    Create agent from template
agentos agent list              List all agents
agentos agent chat <id>         Interactive chat
agentos agent kill <id>         Stop an agent
agentos agent spawn <template>  Spawn from template

agentos chat [agent]            Quick chat
agentos message <agent> <text>  Send single message

agentos workflow list           List workflows
agentos workflow create <file>  Create workflow
agentos workflow run <id>       Execute workflow

agentos trigger list            List triggers
agentos trigger create <fn> <type>  Create trigger
agentos trigger delete <id>     Delete trigger

agentos skill list              List skills
agentos skill install <path>    Install skill
agentos skill remove <id>       Remove skill
agentos skill search <query>    Search skills
agentos skill create <name>     Scaffold new skill

agentos channel list            List channels
agentos channel setup <name>    Configure channel
agentos channel test <name>     Test channel
agentos channel enable <name>   Enable channel
agentos channel disable <name>  Disable channel

agentos config show             Show configuration
agentos config get <key>        Get config value
agentos config set <k> <v>      Set config value
agentos config set-key <p> <k>  Set API key
agentos config keys             List API keys

agentos models list             List available models
agentos models test <model>     Test a model

agentos memory query <text>     Query memory
agentos memory list             List memories
agentos memory clear [agent]    Clear memory

agentos security audit          View audit log
agentos security verify         Verify audit chain
agentos security scan <text>    Scan for injection
agentos security caps <agent>   View capabilities

agentos approvals list          List pending approvals
agentos approvals approve <id>  Approve action
agentos approvals deny <id>     Deny action

agentos sessions list           List sessions
agentos sessions get <id>       Get session details

agentos vault set <k> <v>       Store secret
agentos vault get <k>           Retrieve secret
agentos vault list              List secrets

agentos cron list               List cron jobs
agentos cron create <expr> <fn> Create cron job
agentos cron delete <id>        Delete cron job

agentos migrate run <target>    Run migration

agentos logs [--lines N] [--follow]  View logs
agentos integrations [query]    Browse integrations
agentos add <name> [--key K]    Add integration
agentos remove <name>           Remove integration
agentos mcp                     MCP server mode
agentos onboard [--quick]       Interactive onboarding
agentos reset [--confirm]       Factory reset
agentos completion <shell>      Shell completions
agentos tui                     Launch terminal UI
agentos dashboard               Open web dashboard
```

## TUI Dashboard

22 screens accessible via number keys (1-0) or Tab:

```
Dashboard · Agents · Chat · Channels · Skills · Hands
Workflows · Sessions · Approvals · Logs · Memory · Audit
Security · Peers · Extensions · Triggers · Templates
Usage · Settings · Welcome · Wizard · Workflow Builder
```

## Templates

### 45 Agent Templates (`agents/`)

Pre-built agents ready to spawn across 9 divisions: assistant, coder, researcher, debugger, architect, code-reviewer, doc-writer, test-engineer, devops-lead, ops, orchestrator, planner, analyst, data-scientist, customer-support, email-assistant, health-tracker, home-automation, legal-assistant, meeting-assistant, personal-finance, recruiter, sales-assistant, security-auditor, social-media, translator, travel-planner, tutor, writer, hello-world, ux-architect, brand-guardian, image-prompt-engineer, growth-hacker, content-creator, app-store-optimizer, evidence-collector, performance-benchmarker, reality-checker, trend-researcher, feedback-synthesizer, sprint-prioritizer, rapid-prototyper, mobile-builder, ai-engineer.

### 7 Hands (`hands/`)

Autonomous background workers: researcher, collector, predictor, twitter, browser, clip, lead.

### 25 MCP Integrations (`integrations/`)

GitHub, GitLab, Slack, Discord, Jira, Linear, Notion, Google Drive, Gmail, Google Calendar, AWS, Azure, GCP, PostgreSQL, MongoDB, Redis, Elasticsearch, SQLite, Sentry, Dropbox, Brave Search, Exa Search, Bitbucket, Teams, Todoist.

### 40 Channel Adapters (`src/channels/`)

Telegram, Discord, Slack, WhatsApp, Email, Teams, Google Chat, IRC, Matrix, Mattermost, Signal, Bluesky, Mastodon, Reddit, Twitch, XMPP, Zulip, Rocket.Chat, Feishu, LINE, Messenger, Viber, Revolt, Webex, DingTalk, Discourse, Nostr, Threema, Guilded, Keybase, Nextcloud, Flock, Pumble, Twist, Gitter, Gotify, ntfy, Mumble, LinkedIn, Webhook.

## Security

- **Fail-Closed Defaults**: All security gates deny by default when services are unavailable
- **RBAC**: Per-agent capability enforcement with tool-level granularity
- **Mutual Auth (MAP)**: Agent-to-agent authentication with HMAC-SHA256 challenge-response
- **Timing-Safe Comparison**: Constant-time HMAC verification prevents timing attacks
- **Audit Chain**: Merkle-linked SHA-256 audit log with tamper detection
- **Taint Tracking**: Information flow control (Secret, PII, UntrustedAgent labels)
- **Manifest Signing**: Ed25519 signatures for agent/skill manifests
- **Tool Policy**: Configurable allow/deny/approve policies per tool
- **Approval Tiers**: Auto (read-only), Async (write), Sync (destructive) with exponential backoff
- **Docker Sandbox**: Container-isolated code execution
- **WASM Sandbox**: wasmtime-based untrusted code execution with fuel limits
- **Prompt Injection**: Regex-based injection pattern scanning
- **Rate Limiting**: GCRA token bucket per agent
- **Loop Guard**: Infinite loop detection with circuit breaker
- **Vault**: AES-256-GCM encrypted secrets with PBKDF2 key derivation and auto-lock
- **SQL Injection Prevention**: Identifier validation on all dynamic query fields
- **Sensitive Data Zeroing**: Auto-zeroing of decrypted secrets after configurable TTL

## LLM Providers (25)

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus, Sonnet, Haiku |
| OpenAI | GPT-4o, GPT-4o-mini, o1, o3-mini |
| Google | Gemini 2.0 Flash, Pro |
| AWS Bedrock | Claude, Titan |
| DeepSeek | V3, R1 |
| Groq | Llama, Mixtral |
| Mistral | Large, Medium, Small |
| Together | Open-source models |
| Fireworks | Fast inference |
| Cohere | Command R+ |
| Perplexity | Sonar |
| xAI | Grok |
| Replicate | Open-source |
| Ollama | Local models |
| vLLM | Self-hosted |
| LM Studio | Local models |
| OpenRouter | Multi-provider routing |
| HuggingFace | Inference API |
| AI21 | Jamba |
| Cerebras | Fast inference |
| SambaNova | Enterprise |
| Qwen | Qwen models |
| Minimax | Minimax models |
| Zhipu | GLM models |
| Moonshot | Kimi |

## SkillKit Integration

Access 15,000+ skills from the SkillKit marketplace:

```bash
agentos skill search "code review"
agentos skill install pro-workflow
```

Built-in bridge to [agenstskills.com](https://agenstskills.com) for skill discovery, installation, and AI-powered recommendations.

## Configuration

`config.yaml` configures the iii-engine with modules:

| Module | Port | Purpose |
|--------|------|---------|
| WebSocket | 49134 | Worker connections |
| REST API | 3111 | HTTP API |
| Streams | 3112 | WebSocket streams |
| State | — | File-based KV store |
| Queue | — | Built-in job queue |
| PubSub | — | Event pub/sub |
| Cron | — | Scheduled jobs |
| KV Server | — | Key-value store |
| Observability | — | OpenTelemetry metrics |

## Project Structure

```
agentos/
├── Cargo.toml              Rust workspace
├── package.json            Node.js package
├── config.yaml             iii-engine configuration
├── vitest.config.ts        Test configuration
│
├── crates/                 Rust crates (10 — hot path)
│   ├── agent-core/         ReAct agent loop
│   ├── api/                Rust HTTP API
│   ├── cli/                CLI (50+ commands)
│   ├── hand-runner/        Autonomous hands
│   ├── llm-router/         25 LLM providers
│   ├── memory/             Session memory
│   ├── security/           RBAC, audit, taint, signing, sandbox
│   ├── tui/                22-screen terminal dashboard
│   ├── wasm-sandbox/       WASM execution
│   └── workflow/           Workflow engine
│
├── src/                    TypeScript workers (39)
│   ├── api.ts              OpenAI-compatible API
│   ├── agent-core.ts       TS agent loop
│   ├── tools.ts            22 built-in tools
│   ├── tools-extended.ts   38 extended tools
│   ├── swarm.ts            Multi-agent swarms
│   ├── knowledge-graph.ts  Entity-relation graph
│   ├── session-replay.ts   Session recording
│   ├── tool-profiles.ts    8 tool filtering profiles
│   ├── skillkit-bridge.ts  SkillKit marketplace bridge
│   ├── security-map.ts     Mutual Authentication Protocol
│   ├── channels/           40 channel adapters
│   ├── shared/             Shared utilities
│   ├── __tests__/          1,439 TypeScript tests
│   └── ...                 25 more workers
│
├── workers/                Python workers
│   └── embedding/          Text embeddings
│
├── agents/                 30 agent templates
├── hands/                  7 autonomous hands
├── integrations/           25 MCP integrations
└── identity/               System identity files
```

## Testing

2,419 tests across three languages:

```bash
npx vitest --run          # 1,439 TypeScript tests (48 files)
cargo test --workspace    # 819 Rust tests (10 crates)
python3 -m pytest         # 161 Python tests
```

## How It Works

Every component is a **Worker** that registers **Functions** and binds them to **Triggers**:

```rust
// Rust worker
let iii = III::new("ws://localhost:49134");

iii.register_function_with_description(
    "agent::chat",
    "Process a message through the agent loop",
    move |input: Value| { /* ... */ },
);

iii.register_trigger("queue", "agent::chat", json!({ "topic": "agent.inbox" }))?;
```

```typescript
// TypeScript worker
const { registerFunction, registerTrigger, trigger } = init(
  'ws://localhost:49134',
  { workerName: 'api' }
)

registerFunction(
  { id: 'api::chat_completions', description: 'OpenAI-compatible chat completions' },
  async (req) => { /* ... */ }
)

registerTrigger({
  type: 'http',
  function_id: 'api::chat_completions',
  config: { api_path: 'v1/chat/completions', http_method: 'POST' }
})
```

```python
# Python worker
iii = III("ws://localhost:49134", worker_name="embedding")

@iii.function(id="embedding::generate", description="Generate text embeddings")
async def generate_embedding(input):
    # ...
```

Functions call each other via `trigger()` regardless of language:

```
HTTP POST /v1/chat/completions
  → api::chat_completions (TypeScript)
    → agent::chat (Rust)
      → security::check_capability (Rust)
      → approval::classify (TypeScript)
      → memory::recall (Rust)
      → llm::route (Rust)
      → llm::complete (TypeScript)
      → tool::web_search (TypeScript)
      → loop_guard::check (TypeScript)
    → memory::store (Rust)
    → replay::record (TypeScript)
```

## Requirements

- [iii-engine](https://iii.dev) v0.3+
- Rust 1.75+
- Node.js 20+
- Python 3.11+ (optional, for embeddings)

## License

Apache-2.0

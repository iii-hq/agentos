<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="AgentOS — The Agent Operating System" src="assets/banner-dark.svg" width="800">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-facc15?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/Tests-2,754_passing-22c55e?style=for-the-badge" alt="Tests">
  <img src="https://img.shields.io/badge/Tools-60+-facc15?style=for-the-badge" alt="Tools">
  <img src="https://img.shields.io/badge/LLM_Providers-25-fde68a?style=for-the-badge" alt="LLM Providers">
  <img src="https://img.shields.io/badge/Models-47-71717a?style=for-the-badge" alt="Models">
</p>

<p align="center">
  <a href="https://agentos.sh">Website</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="https://github.com/iii-hq/agentos">GitHub</a>
</p>

Every capability — agents, memory, security, LLM routing, workflows, tools, swarms, knowledge graphs, session replay, vault, **self-evolving functions**, **DAG-based artifact exchange**, **inter-agent coordination**, **self-curating memory**, **session lifecycle**, **task decomposition**, **multi-agent orchestration** — is a plain function registered on an [iii-engine](https://iii.dev) bus. No frameworks, no vendor lock-in, no magic.

<p align="center">
  <img src="assets/architecture.svg" alt="AgentOS architecture: Rust (18 crates), TypeScript (46 workers), Python (embeddings) on iii-engine" width="720">
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/iii-hq/agentos/main/scripts/install.sh | sh
```

Installs both **iii-engine** (dependency) and **agentos** binary to `~/.local/bin`.

Options:
```bash
AGENTOS_VERSION=v0.1.0 curl -fsSL ... | sh   # specific version
BIN_DIR=/usr/local/bin curl -fsSL ... | sh    # custom install dir
```

## Quickstart

```bash
# 1. Initialize and start
agentos init --quick
agentos config set-key anthropic $ANTHROPIC_API_KEY
agentos start

# 2. Chat with an agent
agentos chat default
```

### Manual startup (development)

```bash
# 1. Start the engine
iii --config config.yaml

# 2. Start Rust workers (hot path)
cargo run --release -p agentos-core &
cargo run --release -p agentos-security &
cargo run --release -p agentos-memory &
cargo run --release -p agentos-llm-router &
cargo run --release -p agentos-wasm-sandbox &

# 3. Start control plane workers
cargo run --release -p agentos-realm &
cargo run --release -p agentos-hierarchy &
cargo run --release -p agentos-directive &
cargo run --release -p agentos-mission &
cargo run --release -p agentos-ledger &
cargo run --release -p agentos-council &
cargo run --release -p agentos-pulse &
cargo run --release -p agentos-bridge &

# 4. Start TypeScript workers
npx tsx src/api.ts &
npx tsx src/agent-core.ts &
npx tsx src/tools.ts &
npx tsx src/workflow.ts &

# 5. Start Python embedding worker
python workers/embedding/main.py &

# 6. Chat with an agent
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

### Rust Crates (18)

| Crate | Purpose | LOC |
|-------|---------|-----|
| `agent-core` | ReAct agent loop — orchestrates LLM calls, tool execution, memory | ~320 |
| `security` | RBAC, Merkle audit chain, taint tracking, Ed25519 signing, tool policy, Docker sandbox | ~700 |
| `memory` | Session/episodic memory, recall, consolidation, eviction | ~840 |
| `llm-router` | Routes to 25 LLM providers with complexity-based model selection | ~320 |
| `wasm-sandbox` | Executes untrusted code in WASM via wasmtime | ~180 |
| `cli` | 50+ commands across 15 subcommand groups | ~700 |
| `tui` | 25-screen terminal dashboard (ratatui) | ~350 |
| `api` | Rust HTTP API layer | ~200 |
| `hand-runner` | Autonomous hand execution engine | ~150 |
| `workflow` | Rust workflow step execution | ~200 |
| `realm` | Multi-tenant isolation domains with export/import | ~280 |
| `hierarchy` | Agent org structure with cycle-safe DFS tree building | ~250 |
| `directive` | Hierarchical goal alignment with optimistic concurrency | ~280 |
| `mission` | Task lifecycle with state machine and atomic checkout | ~350 |
| `ledger` | Budget enforcement with soft/hard limits and versioned CAS | ~300 |
| `council` | Governance proposals with SHA-256 merkle-chained audit trail | ~450 |
| `pulse` | Scheduled agent invocation with context-aware ticks | ~250 |
| `bridge` | External runtime adapters (Process/HTTP/ClaudeCode/Codex/Cursor/OpenCode) | ~300 |

### TypeScript Workers (51)

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
| `memory.ts` | TypeScript memory layer (profile modeling, session search) |
| `memory-reflection.ts` | Self-curating memory reflection (auto-extracts facts, discovers skills) |
| `llm-router.ts` | 25-provider LLM routing with complexity scoring |
| `model-catalog.ts` | 47 models with pricing and capability metadata |
| `mcp-client.ts` | Model Context Protocol client |
| `a2a.ts` | Agent-to-Agent protocol (JSON-RPC 2.0) |
| `a2a-cards.ts` | A2A agent card discovery |
| `vault.ts` | AES-256-GCM encrypted vault with PBKDF2 key derivation |
| `browser.ts` | Headless browser automation with SSRF protection |
| `context-manager.ts` | Context window budget management |
| `context-monitor.ts` | Structured context compression (5-phase with iterative summaries) |
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
| `telemetry.ts` | OpenTelemetry metrics (SDK-native, auto worker CPU/memory/event-loop) |
| `cron.ts` | Scheduled jobs (session cleanup, cost aggregation, rate limit reset) |
| `code-agent.ts` | Specialized coding agent |
| `evolve.ts` | Dynamic function evolution (LLM code gen + vm sandbox + DAG branching) |
| `eval.ts` | Production eval harness (pluggable scorers, suites, inline auto-scoring) |
| `feedback.ts` | Feedback loop (auto-review, improve/kill, promote, signal injection) |
| `artifact-dag.ts` | DAG-based content artifact exchange (push/fetch/diff/leaves/history) |
| `coordination.ts` | Inter-agent coordination board (channels, threaded posts, pinning) |
| `session-lifecycle.ts` | Session state machine with declarative reaction rules |
| `task-decomposer.ts` | Recursive task decomposition with hierarchical IDs |
| `recovery.ts` | Session health scanning and automated recovery |
| `orchestrator.ts` | Multi-agent orchestrator (plan, decompose, spawn, monitor) |
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

## Control Plane

The control plane layer provides full agent orchestration — multi-tenant isolation, org hierarchies, goal alignment, task management, budget enforcement, governance, scheduling, and external runtime adapters.

All 8 crates are Rust workers on iii-sdk, exposing 45 functions via 44 HTTP endpoints and 2 PubSub triggers.

```rust
trigger("realm::create", json!({ "name": "production", "description": "Prod environment" }))
trigger("hierarchy::set", json!({ "realmId": "r-1", "agentId": "agent-ceo", "title": "CEO" }))
trigger("directive::create", json!({ "realmId": "r-1", "title": "Ship v2", "level": "realm" }))
trigger("mission::create", json!({ "realmId": "r-1", "title": "Build auth", "directiveId": "dir-1" }))
trigger("ledger::set_budget", json!({ "realmId": "r-1", "monthlyCents": 500000 }))
trigger("council::submit", json!({ "realmId": "r-1", "kind": "hire_agent", "title": "Hire researcher" }))
trigger("pulse::register", json!({ "realmId": "r-1", "agentId": "agent-ops", "intervalSecs": 300 }))
trigger("bridge::invoke", json!({ "realmId": "r-1", "runtimeId": "rt-1", "input": "Review PR #42" }))
```

| Crate | Endpoints | Key Features |
|-------|-----------|-------------|
| `realm` | 7 REST | Multi-tenant isolation, export/import with secret scrubbing |
| `hierarchy` | 5 REST | Org charts, cycle detection (DFS), capability search, chain-of-command |
| `directive` | 5 REST | Goal trees, ancestry tracing, optimistic concurrency (CAS) |
| `mission` | 7 REST | State machine (Backlog→Queued→Active→Review→Complete), atomic checkout |
| `ledger` | 4 REST + 1 PubSub | Soft/hard budget limits, versioned CAS, spend tracking by agent/model/provider |
| `council` | 6 REST + 1 PubSub | Proposal governance, SHA-256 merkle audit chain, agent override (pause/resume/terminate) |
| `pulse` | 4 REST | Scheduled invocation, context modes (thin/full), budget-gated ticks |
| `bridge` | 5 REST | 6 runtime adapters, path traversal prevention, process timeout, JoinHandle cleanup |

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

## Artifact DAG

Git-style DAG-based content exchange for swarms. Agents push versioned artifacts with parent references, enabling branching histories, diffs, and frontier discovery.

```typescript
const node = await trigger("artifact::push", {
  content: { report: "Q1 analysis..." },
  parentIds: ["art_abc123"],
  agentId: "analyst-1",
  swarmId: "swarm_research",
  metadata: { type: "report", format: "markdown" }
})

const leaves = await trigger("artifact::leaves", { swarmId: "swarm_research" })

const diff = await trigger("artifact::diff", { nodeIdA: "art_abc123", nodeIdB: node.nodeId })
```

**6 functions**: `artifact::push`, `artifact::fetch`, `artifact::children`, `artifact::leaves`, `artifact::diff`, `artifact::history`

- Content-addressed with SHA-256 hashing (first 16 hex chars)
- Parent validation on push (all parentIds must exist)
- Swarm-scoped publishing via PubSub (`artifact:{swarmId}` topic)
- Frontier discovery (leaves with no children, excluding orphans)
- 512KB max content size per artifact

## Coordination Board

Persistent inter-agent communication channels with threaded posts and pinning.

```typescript
await trigger("coord::create_channel", {
  name: "design-decisions",
  description: "Architecture discussions",
  agentId: "architect-1"
})

await trigger("coord::post", {
  channelId: "chan_abc123",
  agentId: "architect-1",
  content: "Proposal: switch to event sourcing for audit trail"
})

await trigger("coord::reply", {
  channelId: "chan_abc123",
  parentId: "post_xyz789",
  agentId: "reviewer-1",
  content: "Agreed — aligns with our immutability requirements"
})

await trigger("coord::pin", { channelId: "chan_abc123", postId: "post_xyz789" })
```

**6 functions**: `coord::create_channel`, `coord::post`, `coord::reply`, `coord::list_channels`, `coord::read`, `coord::pin`

- Threaded replies via `parentId`
- Pin/unpin with 25-pin limit per channel
- 1,000-post limit per channel
- Auth enforced on post and reply (HTTP requests)
- PubSub notifications on `coord:{channelId}` topic

## Agent Intelligence

Self-improving agent capabilities that run automatically during normal operation.

### Memory Reflection

Agents periodically curate their own memory. Every 5 turns, a background reflection extracts durable facts from the conversation and stores them as `[Curated]` entries for future recall.

```typescript
trigger("reflect::check_turn", { agentId: "agent-1", sessionId: "s1", iterations: 3 })
trigger("reflect::curate_memory", { agentId: "agent-1", sessionId: "s1" })
trigger("reflect::discover_skills", { agentId: "agent-1", sessionId: "s1", iterations: 8 })
```

- **3 functions**: `reflect::check_turn`, `reflect::curate_memory`, `reflect::discover_skills`
- Auto-extracts preferences, decisions, learnings from conversation
- Auto-discovers reusable skills from tool-heavy sessions (5+ iterations) via `evolve::generate`
- Builds user profile automatically (`memory::user_profile::update`)
- Fire-and-forget — never blocks the chat response

### Structured Context Compression

5-phase compression that preserves context quality:

1. **Prune** — truncate old tool results (>200 chars)
2. **Sanitize** — fix orphaned tool call/result pairs
3. **Merge** — combine consecutive system messages
4. **Protect** — reserve 40% of token budget for recent context
5. **Summarize** — LLM generates structured summary (Goal / Progress / Decisions / Files / Next Steps / Critical Context)

Iterative: detects existing summaries and updates them instead of re-summarizing from scratch.

### User Profile Modeling

Agents build a persistent understanding of who they're working with:

```typescript
trigger("memory::user_profile::update", { agentId: "agent-1", updates: { workStyle: "concise" } })
trigger("memory::user_profile::get", { agentId: "agent-1" })
trigger("memory::session_search", { agentId: "agent-1", query: "deployment pipeline" })
```

- Profile auto-injected as `[User Profile]` system message in every chat
- Cross-session search with keyword + recency scoring
- Deep-merge updates (objects merged, arrays concatenated)

### Smart Model Routing

Complexity-aware model selection with per-agent tier support:

```typescript
trigger("llm::route", { message: "Step 1: create DB. Then build API.", toolCount: 5, agentTier: "premium" })
```

- Detects multi-step instructions, multiple code blocks, reasoning keywords
- `economy` tier: always routes to fastest model
- `premium` tier: never below mid-tier
- Default: automatic complexity scoring

## Orchestration

Multi-agent coordination and lifecycle management.

### Session Lifecycle

Formal state machine for agent sessions with declarative reaction rules:

```text
spawning → working → blocked → working (retry)
working → pr_open → review → merged → done
working → failed → recovering → working
```

```typescript
trigger("lifecycle::transition", { agentId: "agent-1", newState: "working" })
trigger("lifecycle::add_reaction", {
  from: "working", to: "blocked",
  action: "send_to_agent",
  payload: { message: "You appear stuck. What's blocking you?" },
  escalateAfter: 3,
})
```

- **5 functions**: `lifecycle::transition`, `lifecycle::get_state`, `lifecycle::add_reaction`, `lifecycle::list_reactions`, `lifecycle::check_all`
- Validates transitions, fires hooks on state changes
- 4 reaction types: `send_to_agent`, `notify`, `escalate`, `auto_recover`
- Auto-scans all agents every 2 minutes via cron

### Task Decomposition

Recursive task breakdown with hierarchical IDs and status propagation:

```typescript
const { rootId, tasks } = await trigger("task::decompose", {
  description: "Build a user authentication system with OAuth and rate limiting"
})

await trigger("task::spawn_workers", { rootId })
```

- **5 functions**: `task::decompose`, `task::get`, `task::update_status`, `task::list`, `task::spawn_workers`
- Hierarchical IDs: `1` → `1.1` → `1.1.2`
- Status propagation: all siblings complete → parent complete, child fails → parent blocked
- Each leaf task gets its own agent via `tool::agent_spawn`

### Session Recovery

Automated health scanning and recovery for agent sessions:

```typescript
trigger("recovery::scan", {})
trigger("recovery::recover", { agentId: "agent-1" })
```

- **5 functions**: `recovery::scan`, `recovery::validate`, `recovery::classify`, `recovery::recover`, `recovery::report`
- Classification: `healthy`, `degraded`, `dead`, `unrecoverable`
- Degraded → wake-up message, Dead → circuit breaker reset + restart, Unrecoverable → escalate to human
- Auto-scans every 10 minutes via cron

### Orchestrator

Meta-agent that plans and coordinates multi-agent work:

```typescript
const { planId, analysis } = await trigger("orchestrator::plan", {
  description: "Build a real-time analytics dashboard",
  autoExecute: true,
})

await trigger("orchestrator::status", { planId })
await trigger("orchestrator::intervene", { planId, action: "pause" })
```

- **4 functions**: `orchestrator::plan`, `orchestrator::execute`, `orchestrator::status`, `orchestrator::intervene`
- LLM analyzes feature complexity, estimates agents needed, generates decomposition prompt
- Decomposes tasks, registers lifecycle reactions, spawns workers
- Human intervention: pause, resume, cancel, redirect

### Signal Injection

Push external signals (CI failures, review comments) directly into agent sessions:

```typescript
trigger("feedback::inject_signal", {
  agentId: "agent-1",
  signalType: "ci_failure",
  content: "Build failed: TypeError in auth.ts line 42",
  source: "github-actions",
})
```

- **3 functions**: `feedback::inject_signal`, `feedback::register_source`, `feedback::list_signals`
- Signal types: `ci_failure`, `review_comment`, `merge_conflict`, `dependency_update`, `custom`
- Auto-routes to agent via `tool::agent_send`

## Dynamic Function Evolution

Agents can write, register, evaluate, and improve functions at runtime. The evolve-eval-feedback loop turns AgentOS from a static orchestrator into a self-evolving system.

```text
Agent goal/spec
    ↓
evolve::generate  →  LLM writes function code
    ↓
evolve::register  →  security scan → vm sandbox → register on iii bus
    ↓
eval::suite       →  invoke N times → score each → aggregate
    ↓
feedback::review  →  analyze scores → KEEP / IMPROVE / KILL
    ↓                    ↓              ↓
    ↓               evolve::generate   evolve::unregister
    ↓               (with feedback)
    ↓
feedback::promote →  draft → staging → production
```

### Evolve (8 functions, 8 endpoints)

```typescript
trigger("evolve::generate", { goal: "Double a number", name: "doubler", agentId: "agent-1" })
trigger("evolve::register", { functionId: "evolved::doubler_v1" })
trigger("evolve::list", { status: "production" })

trigger("evolve::fork", { functionId: "evolved::doubler_v1", goal: "Handle negative numbers", agentId: "agent-2" })
trigger("evolve::leaves", { name: "doubler" })
trigger("evolve::lineage", { functionId: "evolved::doubler_v3" })
```

- LLM generates function code from a goal/spec
- Code runs in a `node:vm` sandbox (no fetch, fs, process, require, setTimeout, eval)
- Sandboxed `trigger()` proxy only allows `evolved::`, `tool::`, `llm::` prefixes
- Pre-registration security scan via `skill::pipeline`
- Lifecycle: `draft` → `staging` → `production` → `deprecated` → `killed`
- **DAG branching**: fork from any version (not just latest), discover frontier leaves, trace full lineage to root

### Eval (6 functions, 5 endpoints)

```typescript
trigger("eval::run", { functionId: "evolved::doubler_v1", input: { value: 5 }, expected: { doubled: 10 } })
trigger("eval::suite", { suiteId: "suite_doubler" })
trigger("eval::compare", { functionIdA: "evolved::doubler_v1", functionIdB: "evolved::doubler_v2", testCases: [...] })
```

- Pluggable scorers: `exact_match`, `llm_judge`, `semantic_similarity`, `custom`
- Inline auto-scoring on every evolved function call (configurable: auto/sampled/manual/off)
- Score formula: correctness (50%) + safety (25%) + latency (15%) + cost (10%)

### Feedback (7 functions, 6 endpoints + cron)

```typescript
trigger("feedback::review", { functionId: "evolved::doubler_v1" })
trigger("feedback::promote", { functionId: "evolved::doubler_v1", targetStatus: "production" })
trigger("feedback::leaderboard", {})
```

- Auto-review every 6 hours via cron
- Decision algorithm: kill (≥3 failures in last 5), improve (avg < 0.5), keep
- Recursive improvement: up to 3 attempts with LLM feedback
- Leaderboard ranking by overall score

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
agentos config unset <key>      Remove config value
agentos config set-key <p> <k>  Set API key
agentos config keys             List API keys

agentos models list             List available models
agentos models aliases          List model aliases
agentos models providers        List LLM providers
agentos models describe <model> Describe model details

agentos memory get <agent> <key>     Get memory entry
agentos memory set <agent> <k> <v>   Set memory entry
agentos memory delete <agent> <key>  Delete memory entry
agentos memory list <agent>          List agent memories

agentos security audit          View audit log
agentos security verify         Verify audit chain
agentos security scan <text>    Scan for injection

agentos approvals list          List pending approvals
agentos approvals approve <id>  Approve action
agentos approvals reject <id>   Reject action

agentos sessions list [agent]   List sessions
agentos sessions delete <id>    Delete session

agentos vault init              Initialize vault
agentos vault set <k> <v>       Store secret
agentos vault list              List secrets
agentos vault remove <key>      Remove secret

agentos cron list               List cron jobs
agentos cron create <expr> <fn> Create cron job
agentos cron delete <id>        Delete cron job
agentos cron enable <id>        Enable cron job
agentos cron disable <id>       Disable cron job

agentos replay get <session>    Get session replay
agentos replay list [--agent]   List replays
agentos replay summary <session>  Replay summary

agentos migrate scan            Scan for migrations
agentos migrate openclaw [--dry-run]   Migrate from OpenClaw
agentos migrate langchain [--dry-run]  Migrate from LangChain
agentos migrate report          Migration report

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

25 screens accessible via keyboard shortcuts:

```
1 Dashboard    2 Agents      3 Chat       4 Channels    5 Skills
6 Hands        7 Workflows   8 Sessions   9 Approvals   0 Logs
m Memory       a Audit       s Security   p Peers       e Extensions
t Triggers     T Templates   u Usage      S Settings    w Wizard
W Wf Builder   L Lifecycle   K Tasks      R Recovery    O Orchestrator

Tab/Shift-Tab to cycle · r to refresh · q to quit
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
| Observability | — | OpenTelemetry metrics |

## Project Structure

```
agentos/
├── Cargo.toml              Rust workspace
├── package.json            Node.js package
├── config.yaml             iii-engine configuration
├── vitest.config.ts        Unit/integration test configuration
├── vitest.e2e.config.ts    E2E test configuration
│
├── crates/                 Rust crates (18 — hot path + control plane)
│   ├── agent-core/         ReAct agent loop
│   ├── api/                Rust HTTP API
│   ├── bridge/             External runtime adapters (6 runtimes)
│   ├── cli/                CLI (50+ commands)
│   ├── council/            Governance proposals + merkle audit chain
│   ├── directive/          Hierarchical goal alignment
│   ├── hand-runner/        Autonomous hands
│   ├── hierarchy/          Agent org structure (cycle-safe)
│   ├── ledger/             Budget enforcement (soft/hard limits)
│   ├── llm-router/         25 LLM providers
│   ├── memory/             Session memory
│   ├── mission/            Task lifecycle + state machine
│   ├── pulse/              Scheduled agent invocation
│   ├── realm/              Multi-tenant isolation domains
│   ├── security/           RBAC, audit, taint, signing, sandbox
│   ├── tui/                21-screen terminal dashboard
│   ├── wasm-sandbox/       WASM execution
│   └── workflow/           Workflow engine
│
├── src/                    TypeScript workers (51)
│   ├── api.ts              OpenAI-compatible API
│   ├── agent-core.ts       TS agent loop (profile injection, memory reflection)
│   ├── tools.ts            22 built-in tools
│   ├── tools-extended.ts   38 extended tools
│   ├── memory-reflection.ts Self-curating memory reflection
│   ├── session-lifecycle.ts Session state machine + reaction rules
│   ├── task-decomposer.ts  Recursive task decomposition
│   ├── recovery.ts         Session health + auto-recovery
│   ├── orchestrator.ts     Multi-agent orchestrator
│   ├── evolve.ts           Dynamic function evolution + DAG branching
│   ├── eval.ts             Production eval harness
│   ├── feedback.ts         Feedback loop + signal injection
│   ├── artifact-dag.ts     DAG-based content artifact exchange
│   ├── coordination.ts     Inter-agent coordination board
│   ├── swarm.ts            Multi-agent swarms
│   ├── knowledge-graph.ts  Entity-relation graph
│   ├── session-replay.ts   Session recording
│   ├── tool-profiles.ts    8 tool filtering profiles
│   ├── skillkit-bridge.ts  SkillKit marketplace bridge
│   ├── security-map.ts     Mutual Authentication Protocol
│   ├── channels/           40 channel adapters
│   ├── shared/             Shared utilities
│   ├── __tests__/          1,748 TypeScript tests (70 files)
│   └── ...                 25 more workers
│
├── workers/                Python workers
│   └── embedding/          Text embeddings
│
├── agents/                 45 agent templates
├── hands/                  7 autonomous hands
├── integrations/           25 MCP integrations
└── identity/               System identity files
```

## Testing

Test suites:

```bash
npx vitest --run                              # TypeScript unit/integration
npm run test:e2e                              # Black-box API e2e (requires AGENTOS_API_KEY)
cargo test --workspace                        # Rust crates
python3 -m pytest                             # Python worker tests
```

## How It Works

Every component is a **Worker** that registers **Functions** and binds them to **Triggers**:

```rust
// Rust worker
let iii = register_worker("ws://localhost:49134", InitOptions::default());

iii.register_function_with_description(
    "agent::chat",
    "Process a message through the agent loop",
    move |input: Value| { /* ... */ },
);

iii.register_trigger("queue", "agent::chat", json!({ "topic": "agent.inbox" }))?;
```

```typescript
// TypeScript worker (direct iii-sdk registerWorker API)
import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";

const sdk = registerWorker(ENGINE_URL, { workerName: "api", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

registerFunction(
  {
    id: 'api::chat_completions',
    description: 'OpenAI-compatible chat completions',
    metadata: { category: 'api' },
    request_format: [
      { name: 'model', type: 'string', required: true },
      { name: 'messages', type: 'array', required: true },
    ],
  },
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

- [iii-engine](https://iii.dev) current stable (iii-sdk registerWorker API with built-in OTel, cron triggers, metadata schemas)
- Rust 1.75+
- Node.js 20+
- Python 3.11+ (optional, for embeddings)

## License

Apache-2.0

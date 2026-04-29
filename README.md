<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="AgentOS — The Agent Operating System" src="assets/banner-dark.svg" width="800">
  </picture>
</p>

<h3 align="center">An agent OS built as 65 narrow workers on iii primitives.</h3>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-facc15?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/Workers-65-facc15?style=for-the-badge" alt="Workers">
  <img src="https://img.shields.io/badge/Functions-257-fde68a?style=for-the-badge" alt="Functions">
  <img src="https://img.shields.io/badge/iii--sdk-0.11.4--next.4-71717a?style=for-the-badge" alt="iii-sdk">
</p>

<p align="center">
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#workers">Workers</a> ·
  <a href="https://github.com/iii-experimental/agentos">GitHub</a>
</p>

```bash
curl -fsSL https://install.iii.dev/iii/main/install.sh | sh
git clone https://github.com/iii-experimental/agentos && cd agentos
cargo build --workspace --release
iii --config config.yaml &
./target/release/agentos-* &
```

That's it. Engine boots, 64 Rust workers connect, 257 functions register over WebSocket on port 49134.

## Three primitives

| Primitive | What it does |
|-----------|--------------|
| **Worker** | One Rust binary per domain. Connects to the engine, registers functions. |
| **Function** | A named handler — `agent::chat`, `llm::route`, `memory::search`. |
| **Trigger** | Binds a function to HTTP, cron, or pub/sub event. |

Every capability — reasoning, state, sandboxing, channels — is a Function on a Worker. There is no shared in-process bus. Workers talk to each other via `iii.trigger`.

## Workers

64 Rust + 1 Python, grouped by responsibility:

| Group | Workers |
|-------|---------|
| Reasoning | `agent-core`, `llm-router`, `council`, `swarm`, `directive`, `mission` |
| State | `realm`, `memory`, `ledger`, `vault`, `context-manager`, `context-cache` |
| Coordination | `orchestrator`, `workflow`, `hierarchy`, `coordination`, `task-decomposer` |
| Execution | `wasm-sandbox`, `browser`, `code-agent`, `hand-runner`, `lsp-tools` |
| Safety | `security`, `security-headers`, `security-map`, `security-zeroize`, `skill-security`, `approval`, `approval-tiers`, `rate-limiter`, `loop-guard` |
| Surfaces | `a2a`, `a2a-cards`, `mcp-client`, `skillkit-bridge`, `bridge`, `streaming` |
| Channels | `channel-{bluesky, discord, email, linkedin, mastodon, matrix, reddit, signal, slack, teams, telegram, twitch, webex, whatsapp}` |
| Telemetry | `telemetry`, `pulse`, `session-lifecycle`, `session-replay`, `feedback`, `eval`, `evolve`, `hashline`, `hooks`, `cron` |
| Embeddings | `embedding` (Python) |

Each worker ships `iii.worker.yaml` declaring its registry shape. CI validates conformance on every PR.

## Quickstart

Boot the engine and a single worker:

```bash
iii --config config.yaml &
./target/release/agentos-realm &
```

Call a function via HTTP (engine's `iii-http` listens on port 3111):

```bash
curl -X POST http://127.0.0.1:3111/v1/realms \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod","description":"production"}'
```

Or trigger directly via the iii SDK:

```rust
let iii = register_worker("ws://localhost:49134", InitOptions::default());
let result = iii.trigger(TriggerRequest {
    function_id: "realm::create".to_string(),
    payload: json!({"name": "prod"}),
    action: None,
    timeout_ms: None,
}).await?;
```

## Calling functions across workers

```rust
iii.trigger(TriggerRequest {
    function_id: "memory::recall".to_string(),
    payload: json!({"agentId": "alice", "query": "..."}),
    action: None,
    timeout_ms: None,
}).await?
```

This is the only inter-worker contract. Workers stay narrow because the engine carries routing, retries, state, and traces.

## Sandbox surfaces

Two distinct namespaces:

| Namespace | Worker | Semantics |
|-----------|--------|-----------|
| `sandbox::*` | builtin iii-sandbox (engine) | Ephemeral microVMs from OCI rootfs |
| `wasm::*` | agentos `wasm-sandbox` | wasmtime, fuel-metered, sub-millisecond cold start |

CI's `no sandbox::* clash with builtin` job ensures no agentos worker registers under the reserved namespace.

## Layout

```
workers/    64 Rust workers + 1 Python (embedding)
crates/     CLI + TUI surfaces (HTTP clients, not workers)
e2e/        vitest end-to-end suite (live engine + workers)
tests/      Rust integration tests
hands/      Agent personas (TOML)
integrations/  MCP server configs (TOML)
agents/     Agent templates (markdown)
workflows/  Workflow definitions (YAML)
plugin/     Reusable agent/command/skill/hook bundles
config.yaml iii engine boot config
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full primitive flow and worker manifest spec.

## Build and test

```bash
cargo build --workspace --release         # all workers
cargo test --workspace --release          # 1281 tests
npm install && npm run test:e2e           # live engine + workers (requires AGENTOS_API_KEY)
```

## Versioning

- iii engine: `v0.11.4-next.4`
- iii-sdk (Rust): pinned at `=0.11.4-next.4` in workspace
- iii-sdk (Python): `>=0.11.3` for the embedding worker
- agentos: `0.0.1` (pre-1.0; 1.0 is reserved for behavioral proof against live infra, not feature completeness)

## License

Apache-2.0

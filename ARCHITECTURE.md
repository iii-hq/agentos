# AgentOS architecture

AgentOS is an agent operating system built on the [iii engine](https://github.com/iii-hq/iii).
The repo ships **narrow workers** (one binary per domain), declarative
configuration (hands, integrations, agents), and surfaces (`cli`, `tui`).
Everything coordinates through iii primitives — `register_function`,
`register_trigger`, `iii.trigger` — over the engine's WebSocket on port
49134. There is no agent runtime that lives outside iii.

## Repository layout

```
agentos/
├── workers/                Narrow iii workers (one binary each)
│   ├── agent-core/         ReAct loop                    agent::*
│   ├── bridge/             External runtime adapters     bridge::*
│   ├── council/            Proposals + activity log      council::*
│   ├── directive/          Hierarchical goal alignment   directive::*
│   ├── embedding/          SentenceTransformers (Python) embedding::*
│   ├── hierarchy/          Org graph (cycle-safe)        hierarchy::*
│   ├── ledger/             Budget + spend tracking       ledger::*
│   ├── llm-router/         Provider routing              llm::*
│   ├── memory/             Narrow agent memory           memory::*
│   ├── mission/            Task lifecycle                mission::*
│   ├── pulse/              Scheduled invocation          pulse::*
│   ├── realm/              Multi-tenant isolation        realm::*
│   ├── security/           Combined guardrails + audit   security::*
│   └── wasm-sandbox/       wasmtime fuel-metered         wasm::*
│
├── crates/                 Surfaces (clients, not workers)
│   ├── cli/                Command-line interface
│   └── tui/                21-screen terminal dashboard
│
├── src/                    TypeScript workers (54 files, ~23k LOC)
│   └── ...                 a2a, browser, cron, evolve, swarm, etc.
│
├── hands/                  Agent personas as TOML config (consumed by hand-runner)
├── integrations/           MCP server configs as TOML
├── agents/                 Agent templates as markdown
│
├── config.yaml             iii engine boot config (workers: + modules:)
└── .github/workflows/ci.yml End-to-end CI (build, test, e2e smoke, namespace check)
```

## Worker manifest

Every directory under `workers/` ships an `iii.worker.yaml` that declares
its registry shape:

```yaml
iii: v1
name: <name>           # must equal the folder name
language: rust         # rust | python
deploy: binary         # binary | image
manifest: Cargo.toml   # Cargo.toml (Rust) | pyproject.toml (Python)
bin: <cargo-bin-name>  # binary deploys only
description: ...
```

CI's `validate iii.worker.yaml` job enforces this on every PR.

## Function namespaces

| namespace | worker | shape |
|---|---|---|
| `agent::` | agent-core | `chat`, `create`, `list`, `delete`, `list_tools` |
| `bridge::` | bridge | `register`, `invoke`, `run`, `list`, `cancel` |
| `council::` | council | `submit`, `decide`, `override`, `proposals`, `activity`, `verify` |
| `directive::` | directive | `create`, `get`, `update`, `list`, `ancestry` |
| `embedding::` | embedding (py) | `generate` |
| `hierarchy::` | hierarchy | `set`, `tree`, `chain`, `find`, `remove` |
| `ledger::` | ledger | `set_budget`, `spend`, `check`, `summary` |
| `llm::` | llm-router | `route`, `complete`, `usage`, `providers` |
| `memory::` | memory | `store`, `recall`, `consolidate`, `evict`, `delete` |
| `mission::` | mission | `create`, `list`, `checkout`, `transition`, `comment`, `release` |
| `pulse::` | pulse | `register`, `tick`, `invoke`, `status`, `toggle` |
| `realm::` | realm | `create`, `get`, `update`, `delete`, `list`, `import`, `export` |
| `security::` | security | `audit`, `scan`, `scan_injection`, `check_capability`, `set_capabilities`, `verify_audit`, `docker_exec`, `sign_manifest`, `verify_manifest` |
| `wasm::` | wasm-sandbox | `execute`, `validate`, `list_modules` |

`sandbox::*` is reserved for the **builtin iii-sandbox** worker (iii
v0.11.4-next.4), which boots ephemeral microVMs from OCI rootfs.
AgentOS workers never register under that namespace; the
`no sandbox::* clash with builtin` CI job enforces this.

## Engine boot

`config.yaml` (iii v0.11.4 schema) declares the seven baseline workers
the engine spawns: `iii-http`, `iii-state`, `iii-stream`, `iii-queue`,
`iii-pubsub`, `iii-cron`, `iii-observability`. AgentOS workers are
spawned alongside as separate processes — each connects to the engine
WebSocket via `register_worker("ws://localhost:49134", ...)` and stays
resident.

The engine WebSocket port (49134) is configurable per-worker via the
`III_WS_URL` environment variable, with `ws://localhost:49134` as the
default. Containerized deploys override.

## Calling a function from another worker

```rust
iii.trigger(TriggerRequest {
    function_id: "memory::recall".to_string(),
    payload: json!({ "agentId": "alice", "query": "..." }),
    action: None,
    timeout_ms: None,
}).await?
```

Or fire-and-forget:

```rust
let iii_c = iii.clone();
tokio::spawn(async move {
    let _ = iii_c.trigger(TriggerRequest {
        function_id: "security::audit".to_string(),
        payload: json!({ "type": "..." }),
        action: None,
        timeout_ms: None,
    }).await;
});
```

This is the only inter-worker contract. There is no shared in-process
state; everything goes through `iii.trigger`.

## TypeScript workers (src/)

The 54 TypeScript files in `src/` predate the Rust `workers/`
decomposition. Several are duplicates of Rust workers
(`src/memory.ts` ↔ `workers/memory`, `src/security.ts` ↔
`workers/security`, `src/llm-router.ts` ↔ `workers/llm-router`,
`src/agent-core.ts` ↔ `workers/agent-core`); the rest are TypeScript-
only features (`a2a`, `swarm`, `eval`, `evolve`, `feedback`,
`hand-runner`, etc).

Long-term these will collapse into `workers/` as well, with the Rust
versions becoming canonical for the duplicated domains and the
TypeScript-only features moving each to `workers/<name>/` with
`language: node, deploy: image` manifests. That migration is a
follow-up — not in this iteration.

## Surfaces (cli, tui)

`crates/cli` and `crates/tui` are clients, not workers. They speak
HTTP to `iii-http` on port 3111. They register no functions and
declare no `iii.worker.yaml`. Future work should move them onto the
iii client SDK directly so they call workers via `iii.trigger` instead
of REST.

## Hands, integrations, agents

These are **declarative config**, not workers:

- `hands/<name>/HAND.toml` — agent persona (system prompt, allowed
  tools, schedule, dashboard metrics) consumed at runtime by
  `src/hand-runner.ts`.
- `integrations/<name>.toml` — MCP server connection details (transport,
  command, OAuth scopes), consumed by `src/mcp-client.ts`.
- `agents/<name>/...` — markdown templates for spawning agent
  personas.

None of these ship as registered functions; they configure workers that
do.

## Versioning

- iii engine: **v0.11.4-next.4**
- iii-sdk (Rust): **=0.11.4-next.4** in workspace `Cargo.toml`
- iii-sdk (Python): **>=0.11.3** in `workers/embedding/pyproject.toml`
- agentos workspace: `version = "0.0.1"` (reserved for behavioral proof
  against live infra, not feature completeness)

## CI

Five jobs run on every PR:

| job | gate |
|---|---|
| `rust build + test` | `cargo build --release` + `cargo test --workspace` (831 tests) |
| `validate iii.worker.yaml` | every `workers/<name>/iii.worker.yaml` parses and matches its folder |
| `no sandbox::* clash with builtin` | grep ensures no agentos worker registers `sandbox::*` |
| `e2e smoke` | starts engine + 13 workers, asserts ports listen, ≥30 functions register, no namespace clash |
| `e2e full` | runs vitest e2e suite against the live stack — gated on `AGENTOS_API_KEY` secret |

Plus `.github/workflows/vercel-deploy.yml` (separate workflow): pushes
to `main` touching `website/**` trigger a Vercel Deploy Hook so the
docs site stays current with main.

## Dependencies (declarative chain-install)

iii v0.11.4-next.4 added a `dependencies:` map in `iii.worker.yaml`
that lets `iii worker add ./workers/agent-core` chain-install
`llm-router`, `memory`, `security` from the registry. AgentOS workers
do not yet declare deps because they aren't published to the registry
— once registry publishing lands, agent-core gets:

```yaml
dependencies:
  llm-router: ^0.0.1
  memory: ^0.0.1
  security: ^0.0.1
```

## Sandbox primitives — the two distinct surfaces

| namespace | worker | semantics |
|---|---|---|
| `sandbox::create` / `sandbox::exec` / `sandbox::list` / `sandbox::stop` | **builtin** iii-sandbox (v0.11.4-next.4) | Ephemeral microVMs booted from OCI rootfs (Python, Node presets). Full Linux. |
| `wasm::execute` / `wasm::validate` / `wasm::list_modules` | agentos `wasm-sandbox` | wasmtime fuel-metered, instruction-level, sub-millisecond cold start. |

Different cost profiles. The CI namespace-clash job ensures the two
never collide.

## Atomic state ops (iii v0.11.4)

iii now exposes `state::update` / `stream::update` with `UpdateOp::set`,
`UpdateOp::increment`, `UpdateOp::append`, plus nested shallow-merge
paths. Workers should prefer these over `state::list + state::set` race
patterns when adding to a list or counter.

`council::activity` still uses the manual hash-chain on `state::list +
state::set` — a separate refactor will move it onto `UpdateOp::append`
once the chain protocol is redesigned to tolerate concurrent appends
without compare-and-swap.

## File-by-file responsibilities

For deeper detail on any worker, read its `src/main.rs` (Rust) or
`main.py` (Python). Each is intentionally small (5-10 registered
functions, 300-2000 LOC) so it's possible to hold the whole worker in
your head before touching it.

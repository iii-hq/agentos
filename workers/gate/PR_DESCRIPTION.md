# feat(gate): add state-gate write-conditioning worker

## Summary

Introduces `workers/gate` — a new Rust worker that sits between callers and
`iii-state`, conditioning writes so that downstream reactive triggers only fire
on effective changes.

- **`gate::set_if_changed`** — strict, epsilon (numeric tolerance), or deep
  structural comparison; skips `state::set` when value hasn't changed.
- **`gate::increment_throttled`** — accumulates increments within a configurable
  time window; flushes one composite `state::update` per window.
- **`gate::debounce`** — last-write-wins within a delay window; only the final
  settled value commits.
- **`gate::accumulate`** — coalesces concurrent update ops per key; flushes one
  consolidated write when the in-flight write completes or a batch-size threshold
  is reached.
- **`gate::batch_commit`** — deduplicates a caller-assembled batch of mutations
  by `(scope, key)` and commits the survivors in parallel.

Optional `GATE_ATTEMPT_TOPIC` environment variable enables a PubSub stream of
raw attempt events (function, scope, key, accepted, reason) for callers that
need visibility into suppressed writes.

## Verification status (Phase 2 smoke test — 2026-05-13)

| Claim | Status | Evidence |
|---|---|---|
| `gate::set_if_changed` suppresses redundant `state::set` calls | **Verified** | 10 calls, identical value, running engine: 1 write, 9 suppressed. `written` field per call, `state::get` post-test, `smoketest.bin` mtime unchanged after call 1. |
| Trigger amplification reduction | **Inferred from contract** | Triggers fire only when `state::set` / `state::update` is called. Gate suppresses the call; no trigger fires as a consequence. Not directly observed — no trigger subscriber registered during smoke test. |
| All 5 functions callable on the bus | **Verified** | Phase 1: live trigger calls to all 5 functions returned correct responses. |

A follow-on integration test with a real state trigger subscriber would directly measure trigger fire count and close the remaining gap.

iii-state fires triggers unconditionally on every write (verified from engine source: `state.rs` calls `invoke_triggers` after every successful adapter write regardless of value change). For high-frequency signal sources, this produces write amplification: 1,000 write attempts against a stable value produce 1,000 trigger dispatches, each O(N) over the registered trigger list.

The gate is an interposition layer. Callers express intent; the gate decides if/when the actual `state::set` or `state::update` happens. Triggers downstream fire only on effective changes.

This pattern generalises to any reactive system on iii state with high-frequency signal sources:

- Agent memory substrates (reinforcement, confidence decay)
- Telemetry and metrics pipelines (counter accumulation)
- Real-time collaboration state (last-known-value debouncing)
- Bulk import flows (batch dedup before hitting the KV layer)

## Related upstream observations

**`iii-sdk` double-registers every function on connect.** Verified during Phase 1
local testing: the engine emits `Function X is already registered. Overwriting.`
for all SDK-connected workers, including `agentos-memory` and `agentos-gate`.
Root cause: the SDK's connection loop calls `collect_registrations()` then
`flush_queue()` twice on initial connect (confirmed in `iii-sdk@0.11.6`
`src/iii.rs:1310`). The engine overwrites silently; functional behaviour is
unaffected. This is not gate-specific — every Rust SDK worker exhibits it.
Filed for upstream awareness; no action needed in this PR.

## Design decisions and deviations from original brief

**Workers live in `workers/`, not `crates/`.** The design doc specified
`crates/gate/`. The actual workspace places all Rust workers in `workers/`. This
crate is at `workers/gate/` to match the established convention.

**State function IDs are `state::*` (double-colon), not `state.*` (dots).**
The brief hedged on this. Engine source and every existing worker in the
workspace confirm `state::get`, `state::set`, `state::update`, `state::list`,
`state::delete`.

**`GateOp` uses `"value"` for increment delta, not `"by"`.** The published
SDK type (`UpdateOp::Increment { by: i64 }`) uses `by`, but every existing
agentos worker sends `"value"` when constructing `state::update` operations
manually (rate-limiter, memory, etc.). The gate follows the in-use convention;
if the engine resolves this ambiguity in a future SDK release, a one-field
rename suffices.

**No OTEL span instrumentation beyond `tracing::info!`.** Workers in this
workspace use `tracing_subscriber::fmt::init()` and `tracing::info/error`
macros. The OTEL export is handled engine-side by `iii-observability`. Adding
custom spans would diverge from the established pattern and requires
`opentelemetry` crate dependencies not present in the workspace.

**No benchmark crate.** No existing worker has one; adding `criterion` is a
workspace-level change outside this worker's scope. The integration test in
`tests/integration.rs` asserts effective-write counts directly (e.g. "10 calls
with stable value → 0 writes"). Benchmarking is documented as future work.

## Test plan

- [ ] `cargo fmt --check -p agentos-gate` — formatting
- [ ] `cargo clippy -p agentos-gate -- -D warnings` — lint
- [ ] `cargo test -p agentos-gate` — unit tests (17 in-module + integration tests)
- [ ] `cargo build --release -p agentos-gate` — release build
- [x] Manual smoke test: 10 calls with identical value against running engine;
      1 write, 9 suppressed. Corroborated by `written` field, `state::get`,
      and state file mtime (2026-05-13).

## Future work

- Persistent buffer storage (replace DashMaps with state-backed implementation;
  internal types designed for this swap).
- Benchmarking suite (`criterion`-based, measuring write-amplification reduction).
- Cross-process gate coordination (currently single-process semantics only).


Co-authored with with [Claude Code](https://claude.com/claude-code)

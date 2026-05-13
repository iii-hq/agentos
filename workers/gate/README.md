# gate

A write-conditioning layer for the iii-state module. Sits between callers and
`state::set` / `state::update`, filtering redundant writes so that downstream
reactive triggers only fire on effective changes.

## Verification status

| Claim | Status | Evidence |
|---|---|---|
| `gate::set_if_changed` suppresses redundant `state::set` calls | **Verified** | Smoke test against running engine: 10 calls with identical value, 1 write committed, 9 suppressed. Corroborated by `written` field per call, `state::get` post-test, and state file mtime. |
| Trigger amplification reduction | **Inferred from contract** | `iii-state` fires triggers only when `state::set` or `state::update` is called. Since the gate suppresses the call, no trigger fires. Not directly observed in v1 testing — no trigger subscriber was registered during the smoke test. |

A follow-on integration test that registers a real state trigger subscriber and counts fires would close the second gap with direct measurement.

## When to use

Every `state::set` and `state::update` call fires registered state triggers
unconditionally — regardless of whether the value actually changed. For
high-frequency sources (agent memory reinforcement loops, sensor pipelines,
accumulator patterns) this produces **write amplification**: N redundant writes
cause N trigger dispatches, each iterating the full trigger list. The gate
eliminates the redundant writes; trigger suppression follows from state's
contract (see [Verification status](#verification-status)).

Use the gate when:

- A signal source can repeat the same value many times in quick succession and
  downstream subscribers only care about transitions.
- Multiple concurrent callers are incrementing the same counter and a single
  consolidated write is sufficient.
- A noisy update stream should only commit its final settled value, not every
  intermediate state.
- A bulk import sends many mutations across the same keys and deduplication
  should happen before hitting the KV layer.

**Do not add the gate for low-frequency writes.** If your code calls
`state::set` a few times per minute, call it directly — the gate adds latency
and in-memory state for no meaningful gain.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `III_WS_URL` | `ws://localhost:49134` | iii engine WebSocket URL |
| `GATE_ATTEMPT_TOPIC` | *(unset)* | If set, every `gate::*` call publishes an attempt event to this PubSub topic |

The gate uses no persistent storage of its own. All pending throttle
accumulations, debounce timers, and accumulate queues live in process memory.
**Pending writes are lost on process restart or SIGTERM.** This is intentional
for v1; see [Future work](#future-work).

## Functions

### `gate::set_if_changed`

Write to state only when the new value differs from the current stored value.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | string | yes | State scope |
| `key` | string | yes | State key |
| `value` | any | yes | Value to write |
| `comparison` | `"strict"` \| `"epsilon"` \| `"deep"` | no | Comparison mode. Default: `"strict"` |
| `epsilon` | number | no | Tolerance for `"epsilon"` mode. Default: `0` |

**Comparison modes**

- `strict` / `deep` — structural equality via JSON value comparison (equivalent
  for all JSON types).
- `epsilon` — for numeric scalars; skips the write when `|new − old| ≤ epsilon`.
  Falls back to `changed` when either value is non-numeric.

**Returns**

```json
{ "written": true, "old_value": <any|null>, "new_value": <any>, "reason": "changed|unchanged|below_epsilon" }
```

**Caveats**

The read-compare-write is not atomic. A concurrent writer can change the stored
value between the gate's read and its write, causing an unnecessary trigger fire.
This is a known TOCTOU race with bounded harm — at worst one extra trigger.

---

### `gate::increment_throttled`

Accumulate numeric increments within a time window. Flushes one composite
`state::update` per window.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | string | yes | State scope |
| `key` | string | yes | State key |
| `by` | integer | yes | Amount to increment |
| `window_ms` | integer | yes | Accumulation window in milliseconds |
| `path` | string | no | JSON path within the value. Empty string = root numeric value |

**Returns**

```json
{ "accumulated_so_far": 42, "will_flush_at_ms": 1735000000000, "immediate": false }
```

`immediate: true` means this call started the window (first call after the
previous window expired). The flush happens in the background after `window_ms`.

**Caveats**

If the worker process dies before the window expires, the accumulated total is
lost. The subsequent flush does not happen.

---

### `gate::debounce`

Last-write-wins within a delay window. Only the final value commits to state.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | string | yes | State scope |
| `key` | string | yes | State key |
| `value` | any | yes | Value to eventually commit |
| `delay_ms` | integer | yes | How long to wait after the last call before committing |

**Returns**

```json
{ "committed": false, "will_commit_at_ms": 1735000000000 }
```

`committed` is always `false` — the commit happens asynchronously after the
delay. If a new call arrives before the timer fires, the timer resets and the
new value replaces the pending one.

---

### `gate::accumulate`

Coalesce concurrent update operations. While a state write for a key is
in-flight, additional operations queue and flush as one consolidated write when
the current flight completes.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | string | yes | State scope |
| `key` | string | yes | State key |
| `op` | object | yes | A single state update operation (same JSON shape as `state::update` operations) |
| `flush_when` | object | no | Flush trigger. Default: `{ "type": "in_flight_completion" }` |

`flush_when` options:

```json
{ "type": "in_flight_completion" }
{ "type": "concurrent_count", "threshold": 10 }
```

**Op shape** (same as `state::update` operations):

```json
{ "type": "set",       "path": "fieldName", "value": <any>    }
{ "type": "increment", "path": "counter",   "value": 5        }
{ "type": "decrement", "path": "counter",   "value": 2        }
{ "type": "merge",     "path": "obj",       "value": { ... }  }
{ "type": "append",    "path": "list",      "value": <any>    }
{ "type": "remove",    "path": "fieldName"                    }
```

**Merging rules**

Before flushing, queued ops for the same path are merged:

- Multiple `increment` on the same path → one increment with summed value.
- Multiple `decrement` on the same path → one decrement with summed value.
- Multiple `set` on the same path → one set with the last value.
- `merge`, `append`, `remove` are not aggregated; all are passed through.

**Returns**

```json
{ "batched": true, "batch_size": 5 }
```

`batched: false` means this call triggered an immediate flush. `batched: true`
means the op was queued behind an in-flight write.

---

### `gate::batch_commit`

Deduplicate a caller-assembled batch of mutations by `(scope, key)`, then
commit the survivors in parallel.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `operations` | array | yes | Array of `{ scope, key, value? | op? }` items |

Each item must have either `value` (maps to `state::set`) or `op` (maps to
`state::update` with a single operation).

**Returns**

```json
{
  "written": 42,
  "skipped": 8,
  "results": [{ "scope": "...", "key": "...", "written": true }, ...]
}
```

---

## Observability

When `GATE_ATTEMPT_TOPIC` is set, every `gate::*` call publishes to the
configured PubSub topic:

```json
{ "function": "gate::set_if_changed", "scope": "...", "key": "...", "accepted": true, "reason": "changed" }
```

Workers that need the raw attempt stream (metrics, audit) subscribe to this
topic. Workers that only care about effective state changes subscribe to
`state::*` triggers as usual — the gate ensures those only fire on real writes.

## Semantic constraints

- **Trigger semantics change.** With the gate in front, state triggers only fire
  on effective writes. Callers relying on every-call trigger semantics will not
  see triggers for suppressed writes.
- **No transactional guarantees.** In-memory buffers are lost on restart. There
  is no atomicity between accumulation and commit. Trigger ordering across
  batched commits is not guaranteed.
- **TOCTOU on `set_if_changed`.** Read-compare-write is not atomic. Worst case:
  one extra trigger fire per concurrent writer race.
- **Pending writes dropped on SIGTERM.** This matches the in-memory-only
  contract. Best-effort flush on shutdown is out of scope for v1.

## Future work

- **Persistent buffers.** Replace the in-process DashMaps with a
  state-backed implementation so pending accumulations survive restarts. The
  internal state types are designed for this swap.
- **Benchmarking suite.** A `criterion`-based bench measuring write-amplification
  reduction (N raw `state::set` calls vs N `gate::set_if_changed` calls against
  a stable value).
- **Cross-process coordination.** Current semantics are single-process only.


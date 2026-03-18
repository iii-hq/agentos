# AgentSOS Project Guide

## Quick Start
```bash
npm test           # Run all tests (vitest --run)
npm run dev        # Start engine + watch mode
npm run start      # Production start
```

## Architecture
- **Runtime**: TypeScript workers on iii-sdk (Worker/Function/Trigger primitives)
- **SDK**: `iii-sdk` v0.9.0 — direct `registerWorker()` usage with object-style `trigger({ function_id, payload })`; fire-and-forget via `TriggerAction.Void()`
- **Each worker file**: calls `registerWorker(ENGINE_URL, { workerName, otel })` directly, then registers functions + HTTP/cron triggers
- **Entry point**: `src/index.ts` imports all workers
- **43 TypeScript workers**, Rust crates for CLI/TUI/security, Python for embeddings

## Code Conventions
- ESM only (`"type": "module"`, `.js` extensions in imports)
- No code comments — code should be self-documenting
- Auth pattern: `if (req.headers) requireAuth(req)` — skips auth for internal trigger calls, enforces for HTTP
- Error handling: `safeCall(fn, fallback, { operation })` for external calls that may fail
- IDs: validated with `sanitizeId()` (alphanumeric + `_-:.`, max 256 chars)
- SSRF: `assertNoSsrf(url)` before any outbound HTTP (DNS resolution check)
- Security: timing-safe HMAC via `safeEqual()`, AES-256-GCM vault

## Test Pattern
All tests follow the same structure in `src/__tests__/`:
1. Inline KV store mock (`kvStore`, `getScope`, `resetKv`, `seedKv`)
2. `mockTrigger` handling `state::get/set/list/update/delete` + domain mocks
3. `vi.mock("iii-sdk")` with `handlers` map capturing registered functions
4. Mock shared modules: `utils.js`, `logger.js`, `metrics.js`, `errors.js`
5. `safeCall` mock: `async (fn, fallback, _context?) => { try { return await fn(); } catch { return fallback; } }`
6. `beforeAll(async () => import("../module.js"))` to register handlers
7. `call(id, input)` helper to invoke handlers

Shared test helpers available at `src/__tests__/helpers.ts` (KV mock, request builders).

## KV Scopes
State is stored in scoped key-value stores via `trigger("state::get/set/list", { scope, key })`:
- `agents`, `sessions:{agentId}`, `skills`, `memory:{agentId}`
- `evolved_functions`, `eval_results`, `eval_suites`
- `feedback_decisions`, `feedback_policy`
- `cost_records`, `cost_daily`, `swarms`, `replay`
- `kg_temporal:{agentId}`, `browser_sessions`

## Key Files
- `src/shared/config.ts` — SDK init, path traversal guard, secret getter
- `src/shared/errors.ts` — AppError, classifyError, withRetry, safeCall
- `src/shared/utils.ts` — requireAuth, assertNoSsrf, sanitizeId, splitMessage
- `src/shared/validate.ts` — safeInt, safeString, safeArray, safePagination
- `src/types.ts` — shared type definitions
- `src/evolve.ts` — dynamic function evolution (vm sandbox)
- `src/eval.ts` — production eval harness
- `src/feedback.ts` — feedback loop (keep/improve/kill)

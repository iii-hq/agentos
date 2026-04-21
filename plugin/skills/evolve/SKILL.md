---
name: evolve
description: "Generate functions from a goal specification, execute them in a sandboxed VM, evaluate with pluggable scorers, and iteratively improve via an LLM feedback loop. Use when the user wants dynamic code generation, runtime function creation, self-improving code, or auto-generated utilities."
user-invocable: true
triggers:
  - "generate function"
  - "runtime code"
  - "self-improving"
  - "evolve"
  - "dynamic function"
  - "code generation"
  - "write a function"
metadata:
  toolScope: [Bash, Read]
  effort: extended
---

Create, test, and improve functions at runtime using the AgentOS evolve-eval-feedback loop.

**1. Generate a function from a goal:**

```bash
curl -X POST http://localhost:3111/api/evolve/generate \
  -H 'Content-Type: application/json' \
  -d '{"goal": "Double a number", "name": "doubler", "agentId": "claude-code"}'
```

Returns `{"functionId": "evolved::doubler_v1", "status": "draft"}`. Code runs in a `node:vm` sandbox (no fs, fetch, process, require).

**2. Register the function on the engine bus:**

```bash
curl -X POST http://localhost:3111/api/evolve/register \
  -H 'Content-Type: application/json' \
  -d '{"functionId": "evolved::doubler_v1"}'
```

Pre-registration security scan runs automatically. Only `evolved::`, `tool::`, `llm::` prefixes are allowed inside the sandbox.

**3. Evaluate with test cases:**

```bash
curl -X POST http://localhost:3111/api/eval/run \
  -H 'Content-Type: application/json' \
  -d '{"functionId": "evolved::doubler_v1", "input": {"value": 5}, "expected": {"doubled": 10}}'
```

Score formula: correctness (50%) + safety (25%) + latency (15%) + cost (10%). Scorers: `exact_match`, `llm_judge`, `semantic_similarity`, `custom`.

**4. Review and improve (or kill) underperforming functions:**

```bash
curl -X POST http://localhost:3111/api/feedback/review \
  -H 'Content-Type: application/json' \
  -d '{"functionId": "evolved::doubler_v1"}'
```

Decision: KEEP (score >= 0.5), IMPROVE (avg < 0.5, up to 3 attempts), or KILL (>= 3 failures in last 5 runs). Functions evolve through: `draft` -> `staging` -> `production`.

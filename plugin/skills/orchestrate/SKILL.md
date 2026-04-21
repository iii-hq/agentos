---
name: orchestrate
description: "Plan multi-agent work from a feature description, decompose into tasks, spawn workers, and monitor progress with human intervention controls (pause, resume, cancel). Use when the user wants to coordinate multiple agents, orchestrate a complex feature, or run parallel agent workflows."
user-invocable: true
triggers:
  - "orchestrate"
  - "multi-agent"
  - "coordinate agents"
  - "plan feature"
  - "parallel agents"
  - "spawn workers"
metadata:
  toolScope: [Bash, Read, Write, Agent]
  effort: extended
---

Plan, execute, and monitor multi-agent work via the AgentOS orchestrator.

**1. Create a plan from a feature description:**

```bash
curl -X POST http://localhost:3111/api/orchestrator/plan \
  -H 'Content-Type: application/json' \
  -d '{"description": "Build a real-time analytics dashboard", "autoExecute": false}'
```

Returns `{"planId": "plan_xyz", "analysis": {"complexity": "high", "estimatedAgents": 4, "tasks": [...]}}`. Set `autoExecute: true` to skip step 2.

**2. Execute the plan (spawns workers for each subtask):**

```bash
curl -X POST http://localhost:3111/api/orchestrator/execute \
  -H 'Content-Type: application/json' \
  -d '{"planId": "plan_xyz"}'
```

Decomposes tasks, registers lifecycle reactions, and spawns agent workers.

**3. Monitor progress:**

```bash
curl -X POST http://localhost:3111/api/orchestrator/status \
  -H 'Content-Type: application/json' \
  -d '{"planId": "plan_xyz"}'
```

**4. Intervene if needed:**

```bash
curl -X POST http://localhost:3111/api/orchestrator/intervene \
  -H 'Content-Type: application/json' \
  -d '{"planId": "plan_xyz", "action": "pause"}'
```

Intervention actions: `pause`, `resume`, `cancel`, `redirect`.

**Workflow:** Plan -> review analysis -> execute -> poll status -> intervene if stuck or off-track.

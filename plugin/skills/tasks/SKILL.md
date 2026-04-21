---
name: tasks
description: "Decompose a feature into hierarchical subtasks, spawn dedicated agent workers for each leaf task, and track completion status with automatic propagation. Use when the user wants to break down work, split a feature into subtasks, plan a sprint, or assign parallel workers."
user-invocable: true
triggers:
  - "break down task"
  - "decompose feature"
  - "subtasks"
  - "task planning"
  - "split work"
  - "spawn workers"
metadata:
  toolScope: [Bash, Read, Write]
  effort: normal
---

Recursive task decomposition and worker assignment via the AgentOS API.

**1. Decompose a feature into subtasks:**

```bash
curl -X POST http://localhost:3111/api/tasks/decompose \
  -H 'Content-Type: application/json' \
  -d '{"description": "Build user auth with OAuth and rate limiting", "maxDepth": 3}'
```

Returns `{"rootId": "task_abc", "tasks": [{"id": "1", "title": "...", "children": ["1.1", "1.2"]}]}`. Hierarchical IDs: `1` -> `1.1` -> `1.1.2`.

**2. Spawn agent workers for leaf tasks:**

```bash
curl -X POST http://localhost:3111/api/tasks/spawn \
  -H 'Content-Type: application/json' \
  -d '{"taskId": "task_abc"}'
```

Each leaf task gets its own agent via `tool::agent_spawn`.

**3. List tasks and check progress:**

```bash
curl 'http://localhost:3111/api/tasks/list?agentId=claude-code'
```

**4. Update task status:**

```bash
curl -X POST http://localhost:3111/api/tasks/update \
  -H 'Content-Type: application/json' \
  -d '{"taskId": "1.1", "status": "completed"}'
```

Status propagation: all siblings complete -> parent auto-completes. Any child fails -> parent marked blocked.

**Workflow:** Decompose -> verify subtask tree -> spawn workers -> monitor via list -> update status as work completes.

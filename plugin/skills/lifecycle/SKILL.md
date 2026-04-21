---
name: lifecycle
description: "Transition agent sessions between states (spawning, working, blocked, done), add automated reactions to state changes, and query current session state. Use when an agent appears stuck, needs a state change, or you want to set up auto-recovery rules on state transitions."
user-invocable: true
triggers:
  - "session state"
  - "agent stuck"
  - "transition state"
  - "lifecycle"
  - "blocked agent"
  - "session status"
metadata:
  toolScope: [Bash, Read]
  effort: normal
---

Manage agent session lifecycle via the AgentOS REST API.

**State machine:**

```
spawning → working → blocked → working (retry)
working → pr_open → review → merged → done
working → failed → recovering → working
any → terminated
```

**1. Transition an agent to a new state:**

```bash
curl -X POST http://localhost:3111/api/lifecycle/transition \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "claude-code", "newState": "working"}'
```

Returns `{"success": true, "previousState": "spawning"}`. Fails if the transition is invalid for the current state.

**2. Check current state:**

```bash
curl http://localhost:3111/api/lifecycle/state/claude-code
```

**3. Add a reaction rule (auto-fires on state change):**

```bash
curl -X POST http://localhost:3111/api/lifecycle/reactions \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "claude-code", "from": "working", "to": "blocked", "action": "send_to_agent", "payload": {"message": "You appear stuck. What is blocking you?"}, "escalateAfter": 3}'
```

Reaction types: `send_to_agent`, `notify`, `escalate`, `auto_recover`. All agents are auto-scanned every 2 minutes via cron.

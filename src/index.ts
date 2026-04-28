import { shutdownManager } from "@agentos/shared/shutdown";

shutdownManager.initShutdown();
console.log("AgentOS booting (iii-sdk registerWorker API, OTel enabled)");

// Canonical workers for memory, security, llm-router, and agent-core live in
// workers/ as Rust crates. Their TypeScript duplicates have been removed.
// Callers should invoke those functions via iii.trigger({ function_id: "memory::store", ... }).

import "./api.js";
import "./artifact-dag.js";
import "./hashline.js";
import "./lsp-tools.js";
import "./coordination.js";
import "./approval.js";
import "./approval-tiers.js";
import "./a2a.js";
import "./a2a-cards.js";
import "./browser.js";
import "./code-agent.js";
import "./context-cache.js";
import "./context-manager.js";
import "./context-monitor.js";
import "./cost-tracker.js";
import "./dashboard.js";
import "./eval.js";
import "./evolve.js";
import "./feedback.js";
import "./hand-runner.js";
import "./hooks.js";
import "./knowledge-graph.js";
import "./loop-guard.js";
import "./mcp-client.js";
import "./memory-reflection.js";
import "./migration.js";
import "./model-catalog.js";
import "./orchestrator.js";
import "./rate-limiter.js";
import "./recovery.js";
import "./security-headers.js";
import "./security-map.js";
import "./security-zeroize.js";
import "./session-lifecycle.js";
import "./session-replay.js";
import "./skill-security.js";
import "./skillkit-bridge.js";
import "./skills.js";
import "./streaming.js";
import "./swarm.js";
import "./task-decomposer.js";
import "./tool-profiles.js";
import "./tools.js";
import "./tools-extended.js";
import "./workflow.js";

console.log("AgentOS ready");

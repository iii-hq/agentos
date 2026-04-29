import { shutdownManager } from "@agentos/shared/shutdown";

shutdownManager.initShutdown();
console.log("AgentOS booting (iii-sdk registerWorker API, OTel enabled)");

import "./api.js";
import "./artifact-dag.js";
import "./lsp-tools.js";
import "./approval.js";
import "./approval-tiers.js";
import "./context-cache.js";
import "./context-manager.js";
import "./context-monitor.js";
import "./cost-tracker.js";
import "./dashboard.js";
import "./hand-runner.js";
import "./knowledge-graph.js";
import "./memory-reflection.js";
import "./migration.js";
import "./model-catalog.js";
import "./recovery.js";
import "./security-headers.js";
import "./security-map.js";
import "./security-zeroize.js";
import "./skill-security.js";
import "./skills.js";
import "./task-decomposer.js";
import "./tool-profiles.js";
import "./tools.js";
import "./tools-extended.js";

console.log("AgentOS ready");

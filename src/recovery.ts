import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";

const log = createLogger("recovery");

const sdk = registerWorker(ENGINE_URL, {
  workerName: "recovery",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

type HealthClass = "healthy" | "degraded" | "dead" | "unrecoverable";

const STALE_THRESHOLD_MS = 60 * 60 * 1000;
const DEAD_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 3;

interface HealthReport {
  agentId: string;
  classification: HealthClass;
  checks: Record<string, { passed: boolean; detail: string }>;
  lastActivity?: number;
  recoveryAttempts: number;
}

registerFunction(
  {
    id: "recovery::scan",
    description: "Scan all agent sessions for health issues",
    metadata: { category: "recovery" },
  },
  async () => {
    const agents: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: "agents" },
        }),
      [],
      { operation: "list_agents" },
    );

    const validAgents = agents
      .map((a: any) => a.key)
      .filter(Boolean);

    const results = await Promise.all(
      validAgents.map((agentId: string) =>
        safeCall(
          () =>
            trigger({
              function_id: "recovery::validate",
              payload: { agentId },
            }),
          null,
          { agentId, operation: "validate" },
        ),
      ),
    );
    const reports: HealthReport[] = results.filter(Boolean) as HealthReport[];

    const summary = {
      total: reports.length,
      healthy: reports.filter((r) => r.classification === "healthy").length,
      degraded: reports.filter((r) => r.classification === "degraded").length,
      dead: reports.filter((r) => r.classification === "dead").length,
      unrecoverable: reports.filter((r) => r.classification === "unrecoverable").length,
    };

    recordMetric("recovery_scan_total", 1, summary as any);
    return { summary, reports };
  },
);

registerFunction(
  {
    id: "recovery::validate",
    description: "Assess session integrity",
    metadata: { category: "recovery" },
  },
  async ({ agentId }: { agentId: string }) => {
    const checks: Record<string, { passed: boolean; detail: string }> = {};

    const lifecycleState: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `lifecycle:${agentId}`, key: "state" },
        }),
      null,
      { agentId, operation: "check_lifecycle" },
    );

    const isTerminal =
      lifecycleState?.state === "done" ||
      lifecycleState?.state === "terminated";
    checks.lifecycle = {
      passed: !isTerminal,
      detail: lifecycleState?.state || "no_state",
    };

    const replaySummary: any = await safeCall(
      () =>
        trigger({
          function_id: "replay::summary",
          payload: { sessionId: `default:${agentId}` },
        }),
      null,
      { agentId, operation: "check_activity" },
    );

    const lastActivity = replaySummary?.endTime || 0;
    const ageMs = lastActivity ? Date.now() - lastActivity : Infinity;
    checks.activity = {
      passed: ageMs < STALE_THRESHOLD_MS,
      detail: lastActivity
        ? `Last activity ${Math.round(ageMs / 60000)}m ago`
        : "No activity recorded",
    };

    const guardStats: any = await safeCall(
      () =>
        trigger({
          function_id: "guard::stats",
          payload: { agentId },
        }),
      null,
      { agentId, operation: "check_guard" },
    );

    checks.circuitBreaker = {
      passed: !guardStats?.circuitBroken,
      detail: guardStats?.circuitBroken
        ? `Broken: ${guardStats.totalCalls} calls`
        : "OK",
    };

    const memoryList: any = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `memory:${agentId}` },
        }),
      null,
      { agentId, operation: "check_memory" },
    );

    checks.memory = {
      passed: memoryList !== null,
      detail: Array.isArray(memoryList)
        ? `${memoryList.length} entries`
        : "Inaccessible",
    };

    const recoveryState: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `recovery:${agentId}`, key: "state" },
        }),
      null,
      { agentId, operation: "get_recovery_state" },
    );
    const recoveryAttempts = recoveryState?.attempts || 0;

    const classification: HealthClass = await trigger({
      function_id: "recovery::classify",
      payload: { checks, ageMs, recoveryAttempts },
    });

    const report: HealthReport = {
      agentId,
      classification,
      checks,
      lastActivity: lastActivity || undefined,
      recoveryAttempts,
    };

    return report;
  },
);

registerFunction(
  {
    id: "recovery::classify",
    description: "Classify session health",
    metadata: { category: "recovery" },
  },
  async ({
    checks,
    ageMs,
    recoveryAttempts,
  }: {
    checks: Record<string, { passed: boolean }>;
    ageMs: number;
    recoveryAttempts: number;
  }) => {
    if (!checks.lifecycle?.passed) return "unrecoverable";
    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return "unrecoverable";

    const failedChecks = Object.values(checks).filter((c) => !c.passed).length;

    if (failedChecks === 0) return "healthy";
    if (ageMs > DEAD_THRESHOLD_MS || checks.circuitBreaker?.passed === false)
      return "dead";
    return "degraded";
  },
);

registerFunction(
  {
    id: "recovery::recover",
    description: "Execute recovery action based on classification",
    metadata: { category: "recovery" },
  },
  async ({ agentId }: { agentId: string }) => {
    const report: any = await trigger({
      function_id: "recovery::validate",
      payload: { agentId },
    });

    if (!report) return { recovered: false, reason: "Validation failed" };

    if (report.classification === "healthy") {
      return { recovered: true, action: "none", reason: "Already healthy" };
    }

    await trigger({
      function_id: "state::update",
      payload: {
        scope: `recovery:${agentId}`,
        key: "state",
        operations: [
          { type: "increment", path: "attempts", value: 1 },
          { type: "set", path: "lastAttemptAt", value: Date.now() },
          { type: "set", path: "classification", value: report.classification },
        ],
      },
    });

    if (report.classification === "degraded") {
      triggerVoid("tool::agent_send", {
        targetAgentId: agentId,
        message:
          "Health check: You appear idle. What is your current status? Please report what you are working on.",
      });
      recordMetric("recovery_actions_total", 1, { action: "wake_up" });
      log.info("Recovery: sent wake-up", { agentId });
      return { recovered: true, action: "wake_up", agentId };
    }

    if (report.classification === "dead") {
      triggerVoid("lifecycle::transition", {
        agentId,
        newState: "recovering",
        reason: "Auto-recovery: session classified as dead",
      });

      const circuitWasReset = report.checks?.circuitBreaker?.passed === false;
      if (circuitWasReset) {
        triggerVoid("guard::reset", { agentId });
      }

      triggerVoid("tool::agent_send", {
        targetAgentId: agentId,
        message: circuitWasReset
          ? "Recovery: Your session was detected as inactive. Circuit breaker has been reset. Please resume your task."
          : "Recovery: Your session was detected as inactive. Please resume your task.",
      });

      recordMetric("recovery_actions_total", 1, { action: "restart" });
      log.info("Recovery: attempted restart", { agentId });
      return { recovered: true, action: "restart", agentId };
    }

    triggerVoid("hook::fire", {
      type: "AgentRecoveryFailed",
      agentId,
      classification: report.classification,
      attempts: report.recoveryAttempts + 1,
    });

    recordMetric("recovery_actions_total", 1, { action: "escalate" });
    log.warn("Recovery: escalated to human", { agentId });
    return { recovered: false, action: "escalate", agentId };
  },
);

registerFunction(
  {
    id: "recovery::report",
    description: "Generate recovery report with metrics",
    metadata: { category: "recovery" },
  },
  async () => {
    const scanResult: any = await trigger({
      function_id: "recovery::scan",
      payload: {},
    });

    const recoverable = (scanResult?.reports || []).filter(
      (r: any) => r.classification === "degraded" || r.classification === "dead",
    );

    const results = await Promise.all(
      recoverable.map((report: any) =>
        safeCall(
          () =>
            trigger({
              function_id: "recovery::recover",
              payload: { agentId: report.agentId },
            }),
          null,
          { agentId: report.agentId, operation: "auto_recover" },
        ).then((result: any) =>
          result ? { agentId: report.agentId, ...result } : null,
        ),
      ),
    );
    const actionsTaken = results.filter(Boolean);

    return {
      summary: scanResult?.summary,
      actionsTaken,
      timestamp: Date.now(),
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "recovery::scan",
  config: { api_path: "api/recovery/scan", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "recovery::recover",
  config: { api_path: "api/recovery/recover", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "recovery::report",
  config: { api_path: "api/recovery/report", http_method: "GET" },
});
registerTrigger({
  type: "cron",
  function_id: "recovery::report",
  config: { expression: "*/10 * * * *" },
});

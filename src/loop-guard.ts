import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createHash } from "crypto";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "loop-guard",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, trigger } = sdk;

interface CallRecord {
  hash: string;
  resultHash: string;
  toolName: string;
  timestamp: number;
}

const HISTORY_SIZE = 30;
const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 5;
const PER_AGENT_CIRCUIT_BREAKER = 100;
const POLL_TOOLS = new Set(["tool::shell_exec", "tool::web_fetch"]);
const POLL_MULTIPLIER = 3;
const BACKOFF_SCHEDULE = [5000, 10000, 30000, 60000];

const AGENT_TTL_MS = 3_600_000;

async function getAgentIndex(): Promise<string[]> {
  return (
    (await trigger({
      function_id: "state::get",
      payload: { scope: "loop_guard_history", key: "_index" },
    })) || []
  );
}

async function setAgentIndex(index: string[]): Promise<void> {
  await trigger({
    function_id: "state::set",
    payload: { scope: "loop_guard_history", key: "_index", value: index },
    action: TriggerAction.Void(),
  });
}

async function getWarningKeysForAgent(agentId: string): Promise<string[]> {
  return (
    (await trigger({
      function_id: "state::get",
      payload: { scope: "loop_guard_warnings", key: `_keys:${agentId}` },
    })) || []
  );
}

async function setWarningKeysForAgent(
  agentId: string,
  keys: string[],
): Promise<void> {
  await trigger({
    function_id: "state::set",
    payload: { scope: "loop_guard_warnings", key: `_keys:${agentId}`, value: keys },
    action: TriggerAction.Void(),
  });
}

async function clearWarningBuckets(agentId: string): Promise<void> {
  const keys = await getWarningKeysForAgent(agentId);
  for (const key of keys) {
    await trigger({
      function_id: "state::set",
      payload: { scope: "loop_guard_warnings", key, value: null },
      action: TriggerAction.Void(),
    });
  }
  await setWarningKeysForAgent(agentId, []);
}

async function evictStaleAgents() {
  const now = Date.now();
  const index = await getAgentIndex();
  const remaining: string[] = [];
  for (const agentId of index) {
    const history: CallRecord[] | null = await trigger({
      function_id: "state::get",
      payload: { scope: "loop_guard_history", key: agentId },
    });
    if (!history || history.length === 0) {
      continue;
    }
    const lastEntry = history[history.length - 1];
    if (lastEntry && now - lastEntry.timestamp > AGENT_TTL_MS) {
      await trigger({
        function_id: "state::set",
        payload: { scope: "loop_guard_history", key: agentId, value: null },
        action: TriggerAction.Void(),
      });
      await trigger({
        function_id: "state::set",
        payload: { scope: "loop_guard_counts", key: agentId, value: null },
        action: TriggerAction.Void(),
      });
      await clearWarningBuckets(agentId);
    } else {
      remaining.push(agentId);
    }
  }
  await setAgentIndex(remaining);
}

setInterval(() => {
  evictStaleAgents().catch((err) => {
    console.error("evictStaleAgents failed:", err);
  });
}, 600_000);

type GuardDecision = "allow" | "warn" | "block" | "circuit_break";

registerFunction(
  {
    id: "guard::check",
    description: "Loop guard: check for repeated tool calls",
  },
  async ({
    agentId,
    toolName,
    params,
    resultHash,
  }: {
    agentId: string;
    toolName: string;
    params: Record<string, unknown>;
    resultHash?: string;
  }) => {
    const prevCalls: number =
      (await trigger({
        function_id: "state::get",
        payload: { scope: "loop_guard_counts", key: agentId },
      })) || 0;
    const agentCalls = prevCalls + 1;
    await trigger({
      function_id: "state::set",
      payload: { scope: "loop_guard_counts", key: agentId, value: agentCalls },
      action: TriggerAction.Void(),
    });

    if (agentCalls > PER_AGENT_CIRCUIT_BREAKER) {
      return {
        decision: "circuit_break",
        reason: `Per-agent circuit breaker: ${agentCalls} calls for ${agentId}`,
      };
    }

    const callHash = hashCall(toolName, params);
    const history: CallRecord[] =
      (await trigger({
        function_id: "state::get",
        payload: { scope: "loop_guard_history", key: agentId },
      })) || [];

    const record: CallRecord = {
      hash: callHash,
      resultHash: resultHash || "",
      toolName,
      timestamp: Date.now(),
    };

    history.push(record);
    if (history.length > HISTORY_SIZE) history.shift();
    await trigger({
      function_id: "state::set",
      payload: { scope: "loop_guard_history", key: agentId, value: history },
      action: TriggerAction.Void(),
    });

    const index = await getAgentIndex();
    if (!index.includes(agentId)) {
      index.push(agentId);
      await setAgentIndex(index);
    }

    const isPollTool = POLL_TOOLS.has(toolName);
    const warnAt = isPollTool
      ? WARN_THRESHOLD * POLL_MULTIPLIER
      : WARN_THRESHOLD;
    const blockAt = isPollTool
      ? BLOCK_THRESHOLD * POLL_MULTIPLIER
      : BLOCK_THRESHOLD;

    const identicalCount = history.filter((h) => h.hash === callHash).length;

    const sameResultCount = resultHash
      ? history.filter(
          (h) => h.hash === callHash && h.resultHash === resultHash,
        ).length
      : 0;

    const pingPong = detectPingPong(history);

    if (sameResultCount >= blockAt || pingPong.detected) {
      return {
        decision: "block",
        reason: pingPong.detected
          ? `Ping-pong pattern: ${pingPong.pattern}`
          : `Identical call+result repeated ${sameResultCount} times`,
        suggestion: "Break the loop — try a different approach",
      };
    }

    if (identicalCount >= blockAt) {
      return {
        decision: "block",
        reason: `Tool ${toolName} called ${identicalCount} times with same params`,
        suggestion:
          "The tool keeps returning the same result. Change your approach.",
      };
    }

    if (identicalCount >= warnAt) {
      const bucketKey = `${agentId}:${callHash}`;
      const prevWarnings: number =
        (await trigger({
          function_id: "state::get",
          payload: { scope: "loop_guard_warnings", key: bucketKey },
        })) || 0;
      const warnings = prevWarnings + 1;
      await trigger({
        function_id: "state::set",
        payload: { scope: "loop_guard_warnings", key: bucketKey, value: warnings },
        action: TriggerAction.Void(),
      });

      const warnKeys = await getWarningKeysForAgent(agentId);
      if (!warnKeys.includes(bucketKey)) {
        warnKeys.push(bucketKey);
        await setWarningKeysForAgent(agentId, warnKeys);
      }

      if (warnings >= 3) {
        return {
          decision: "block",
          reason: `Repeated warnings escalated to block after ${warnings} warnings`,
        };
      }

      const backoffIdx = Math.min(warnings - 1, BACKOFF_SCHEDULE.length - 1);
      return {
        decision: "warn",
        reason: `Tool ${toolName} called ${identicalCount} times with same params`,
        backoffMs: BACKOFF_SCHEDULE[backoffIdx],
      };
    }

    return { decision: "allow" };
  },
);

registerFunction(
  { id: "guard::reset", description: "Reset loop guard state for an agent" },
  async ({ agentId }: { agentId: string }) => {
    await trigger({
      function_id: "state::set",
      payload: { scope: "loop_guard_history", key: agentId, value: null },
      action: TriggerAction.Void(),
    });
    await clearWarningBuckets(agentId);
    await trigger({
      function_id: "state::set",
      payload: { scope: "loop_guard_counts", key: agentId, value: null },
      action: TriggerAction.Void(),
    });
    const index = await getAgentIndex();
    await setAgentIndex(index.filter((id) => id !== agentId));
    return { reset: true };
  },
);

registerFunction(
  { id: "guard::stats", description: "Get loop guard statistics" },
  async ({ agentId }: { agentId: string }) => {
    const history: CallRecord[] =
      (await trigger({
        function_id: "state::get",
        payload: { scope: "loop_guard_history", key: agentId },
      })) || [];
    const callCounts = new Map<string, number>();

    for (const h of history) {
      callCounts.set(h.toolName, (callCounts.get(h.toolName) || 0) + 1);
    }

    const warnKeys = await getWarningKeysForAgent(agentId);
    const warnEntries: [string, number][] = [];
    for (const key of warnKeys) {
      const val: number =
        (await trigger({
          function_id: "state::get",
          payload: { scope: "loop_guard_warnings", key },
        })) || 0;
      if (val > 0) warnEntries.push([key, val]);
    }

    const agentCalls: number =
      (await trigger({
        function_id: "state::get",
        payload: { scope: "loop_guard_counts", key: agentId },
      })) || 0;

    return {
      historySize: history.length,
      agentCalls,
      toolCounts: Object.fromEntries(callCounts),
      warningBuckets: Object.fromEntries(warnEntries),
    };
  },
);

function hashCall(toolName: string, params: Record<string, unknown>): string {
  const data = JSON.stringify({ toolName, params });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function detectPingPong(history: CallRecord[]): {
  detected: boolean;
  pattern?: string;
} {
  if (history.length < 6) return { detected: false };

  const recent = history.slice(-10).map((h) => h.hash);

  for (let patternLen = 2; patternLen <= 4; patternLen++) {
    if (recent.length < patternLen * 3) continue;

    const pattern = recent.slice(-patternLen);
    let repeats = 0;

    for (let i = recent.length - patternLen * 2; i >= 0; i -= patternLen) {
      const chunk = recent.slice(i, i + patternLen);
      if (chunk.every((h, idx) => h === pattern[idx])) {
        repeats++;
      } else {
        break;
      }
    }

    if (repeats >= 2) {
      const toolNames = history
        .slice(-patternLen)
        .map((h) => h.toolName.split("::").pop());
      return {
        detected: true,
        pattern: toolNames.join(" → ") + " (×" + (repeats + 1) + ")",
      };
    }
  }

  return { detected: false };
}

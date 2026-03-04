import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";

const { registerFunction, registerTrigger, trigger } = init(
  ENGINE_URL,
  { workerName: "session-replay" },
);

type ReplayAction = "llm_call" | "tool_call" | "tool_result" | "memory_op";

interface ReplayEntry {
  sessionId: string;
  agentId: string;
  action: ReplayAction;
  data: Record<string, unknown>;
  durationMs: number;
  timestamp: number;
  iteration: number;
  sequence: number;
}

interface RecordInput {
  sessionId: string;
  agentId: string;
  action: ReplayAction;
  data: Record<string, unknown>;
  durationMs?: number;
  iteration?: number;
}

registerFunction(
  {
    id: "replay::record",
    description: "Record an action in the session replay log",
    metadata: { category: "replay" },
  },
  async (input: RecordInput) => {
    const { sessionId, agentId, action, data, durationMs, iteration } = input;
    if (!sessionId || !agentId || !action)
      return { error: "sessionId, agentId, and action required" };

    const counterKey = `${sessionId}:counter`;
    const updated: any = await trigger("state::update", {
      scope: "replay",
      key: counterKey,
      operations: [{ type: "increment", path: "value", value: 1 }],
      upsert: { value: 1 },
    }).catch(() => null);

    const sequence = updated?.value || Date.now();

    const entry: ReplayEntry = {
      sessionId,
      agentId,
      action,
      data: data || {},
      durationMs: durationMs || 0,
      timestamp: Date.now(),
      iteration: iteration || 0,
      sequence,
    };

    await trigger("state::set", {
      scope: "replay",
      key: `${sessionId}:${String(sequence).padStart(8, "0")}`,
      value: entry,
    });

    return { recorded: true, sequence };
  },
);

registerFunction(
  {
    id: "replay::get",
    description: "Get full session replay",
    metadata: { category: "replay" },
  },
  async ({ sessionId }: { sessionId: string }) => {
    if (!sessionId) return { error: "sessionId required" };

    const raw = (await trigger("state::list", { scope: "replay" }).catch(
      () => [],
    )) as any[];
    return raw
      .filter((e: any) => {
        if (!e.value?.sessionId || !e.value?.action) return false;
        if (e.key?.endsWith(":counter")) return false;
        return e.value.sessionId === sessionId;
      })
      .map((e: any) => e.value as ReplayEntry)
      .sort((a, b) => a.sequence - b.sequence);
  },
);

registerFunction(
  {
    id: "replay::search",
    description: "Search replay sessions by criteria",
    metadata: { category: "replay" },
  },
  async ({
    agentId,
    toolUsed,
    timeRange,
    limit: rawLimit,
  }: {
    agentId?: string;
    toolUsed?: string;
    timeRange?: { from: number; to: number };
    limit?: number;
  }) => {
    const limit = Math.max(1, Math.min(Number(rawLimit) || 50, 200));
    const raw = (await trigger("state::list", { scope: "replay" }).catch(
      () => [],
    )) as any[];
    const entries: ReplayEntry[] = raw
      .filter(
        (e: any) =>
          e.value?.sessionId && e.value?.action && !e.key?.endsWith(":counter"),
      )
      .map((e: any) => e.value as ReplayEntry);

    const sessionMap = new Map<string, ReplayEntry[]>();
    for (const entry of entries) {
      if (agentId && entry.agentId !== agentId) continue;
      if (
        timeRange &&
        (entry.timestamp < timeRange.from || entry.timestamp > timeRange.to)
      )
        continue;
      if (
        toolUsed &&
        !(
          entry.action === "tool_call" &&
          (entry.data as any)?.toolId === toolUsed
        )
      )
        continue;

      if (!sessionMap.has(entry.sessionId)) sessionMap.set(entry.sessionId, []);
      sessionMap.get(entry.sessionId)!.push(entry);
    }

    const summaries = [...sessionMap.entries()]
      .map(([sid, actions]) => ({
        sessionId: sid,
        agentId: actions[0]?.agentId,
        actionCount: actions.length,
        startTime: Math.min(...actions.map((a) => a.timestamp)),
        endTime: Math.max(...actions.map((a) => a.timestamp)),
      }))
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);

    return summaries;
  },
);

registerFunction(
  {
    id: "replay::summary",
    description: "Get session replay summary with stats",
    metadata: { category: "replay" },
  },
  async ({ sessionId }: { sessionId: string }) => {
    if (!sessionId) return { error: "sessionId required" };

    const entries: ReplayEntry[] = await trigger("replay::get", { sessionId });
    if (!entries?.length) return { error: "Session not found" };

    let totalDuration = 0;
    let tokensUsed = 0;
    let cost = 0;
    const toolSet = new Set<string>();
    let maxIteration = 0;
    let toolCalls = 0;

    for (const entry of entries) {
      totalDuration += entry.durationMs || 0;
      if (entry.iteration > maxIteration) maxIteration = entry.iteration;

      if (entry.action === "tool_call") {
        toolCalls++;
        const toolId = (entry.data as any)?.toolId;
        if (toolId) toolSet.add(toolId);
      }

      if (entry.action === "llm_call") {
        const usage = (entry.data as any)?.usage;
        if (usage?.total) tokensUsed += usage.total;
        if (usage?.cost) cost += usage.cost;
      }
    }

    return {
      sessionId,
      agentId: entries[0].agentId,
      totalDuration,
      iterations: maxIteration,
      toolCalls,
      tokensUsed,
      cost,
      tools: [...toolSet],
      actionCount: entries.length,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "replay::get",
  config: { api_path: "api/replay/:sessionId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "replay::search",
  config: { api_path: "api/replay/search", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "replay::summary",
  config: { api_path: "api/replay/:sessionId/summary", http_method: "GET" },
});

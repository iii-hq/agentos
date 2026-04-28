import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import type { ContextHealthScore } from "./types.js";
import type { Message } from "@agentos/shared/tokens";
import { estimateTokens, estimateMessagesTokens } from "@agentos/shared/tokens";
import { requireAuth , httpOk } from "@agentos/shared/utils";


const sdk = registerWorker(ENGINE_URL, {
  workerName: "context-monitor",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function scoreTokenUtilization(usedTokens: number, maxTokens: number): number {
  const ratio = usedTokens / maxTokens;
  if (ratio < 0.5) return 25;
  if (ratio < 0.8) return 25 - ((ratio - 0.5) / 0.3) * 10;
  if (ratio < 0.95) return 15 - ((ratio - 0.8) / 0.15) * 15;
  return 0;
}

function scoreRelevanceDecay(messages: Message[]): number {
  if (messages.length === 0) return 25;
  const now = Date.now();
  let weightedScore = 0;
  let totalWeight = 0;
  for (let i = 0; i < messages.length; i++) {
    const recency = (i + 1) / messages.length;
    const age = messages[i].timestamp
      ? (now - messages[i].timestamp!) / (1000 * 60 * 60)
      : messages.length - i;
    const ageDecay = Math.max(0, 1 - age / 24);
    weightedScore += ageDecay * recency;
    totalWeight += recency;
  }
  return totalWeight > 0 ? (weightedScore / totalWeight) * 25 : 25;
}

function scoreRepetition(messages: Message[]): number {
  if (messages.length < 2) return 25;
  const sets = messages.map((m) => wordSet(m.content || ""));
  let duplicateCount = 0;
  let comparisons = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < Math.min(i + 5, sets.length); j++) {
      comparisons++;
      if (jaccardSimilarity(sets[i], sets[j]) > 0.8) {
        duplicateCount++;
      }
    }
  }
  const dupeRatio = comparisons > 0 ? duplicateCount / comparisons : 0;
  return Math.round(25 * (1 - dupeRatio));
}

function scoreToolDensity(messages: Message[]): number {
  if (messages.length === 0) return 25;
  let toolCount = 0;
  for (const m of messages) {
    if (m.role === "tool" || m.toolResults) toolCount++;
  }
  const ratio = toolCount / messages.length;
  if (ratio >= 0.3 && ratio <= 0.5) return 25;
  if (ratio < 0.3) return Math.round(25 * (ratio / 0.3));
  return Math.round(25 * (1 - (ratio - 0.5) / 0.5));
}

registerFunction(
  {
    id: "context::health",
    description: "Compute context health score (0-100)",
    metadata: { category: "context" },
  },
  async (req: any) => {
    const input = req.body || req;
    const usedTokens = estimateMessagesTokens(input.messages);
    const tokenUtilization = scoreTokenUtilization(usedTokens, input.maxTokens);
    const relevanceDecay = scoreRelevanceDecay(input.messages);
    const repetitionPenalty = scoreRepetition(input.messages);
    const toolDensity = scoreToolDensity(input.messages);

    const result = {
      overall: Math.round(
        tokenUtilization + relevanceDecay + repetitionPenalty + toolDensity,
      ),
      tokenUtilization: Math.round(tokenUtilization),
      relevanceDecay: Math.round(relevanceDecay),
      repetitionPenalty: Math.round(repetitionPenalty),
      toolDensity: Math.round(toolDensity),
    };
    return httpOk(req, result);
  },
);

function sanitizeToolPairs(messages: Message[]): Message[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const m of messages) {
    if (m.role === "assistant" && (m as any).tool_calls) {
      for (const tc of (m as any).tool_calls) {
        const cid = tc.callId || tc.id;
        if (cid) callIds.add(cid);
      }
    }
    if (m.role === "tool" && (m as any).tool_call_id) {
      resultIds.add((m as any).tool_call_id);
    }
  }

  const filtered = messages.filter((m) => {
    if (m.role === "tool" && (m as any).tool_call_id) {
      return callIds.has((m as any).tool_call_id);
    }
    return true;
  });

  const orphanedCalls = [...callIds].filter((cid) => !resultIds.has(cid));
  for (const cid of orphanedCalls) {
    filtered.push({
      role: "tool",
      tool_call_id: cid,
      content: "[Result cleared — see context summary]",
    } as any);
  }

  return filtered;
}

registerFunction(
  {
    id: "context::compress",
    description: "Proactive 5-phase context compression",
    metadata: { category: "context" },
  },
  async (req: any) => {
    const input = req.body || req;
    const originalTokens = estimateMessagesTokens(input.messages);
    if (originalTokens <= input.targetTokens) {
      triggerVoid("hook::fire", { type: "AfterCompact", payload: { agentId: input.agentId, removedCount: 0, savedTokens: 0, finalMessageCount: input.messages.length } });
      return httpOk(req, { compressed: input.messages, removedCount: 0, savedTokens: 0 });
    }

    triggerVoid("hook::fire", {
      type: "BeforeCompact",
      payload: {
        agentId: input.agentId,
        messageCount: input.messages.length,
        originalTokens,
        targetTokens: input.targetTokens,
      },
    });

    let messages = [...input.messages];
    let removedCount = 0;

    const recentCutoff = Math.floor(messages.length * 0.6);
    for (let i = 0; i < recentCutoff; i++) {
      if (
        (messages[i].role === "tool" || messages[i].toolResults) &&
        (messages[i].content || "").length > 200
      ) {
        const summary = `[Tool result summarized: ${(messages[i].content || "").slice(0, 100)}...]`;
        messages[i] = {
          ...messages[i],
          content: summary,
          toolResults: undefined,
        };
        removedCount++;
      }
    }

    messages = sanitizeToolPairs(messages);

    const merged: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === "system" && messages[i].role === "system") {
        merged[merged.length - 1] = {
          ...prev,
          content: prev.content + "\n" + messages[i].content,
        };
        removedCount++;
      } else {
        merged.push(messages[i]);
      }
    }
    messages = merged;

    if (estimateMessagesTokens(messages) <= input.targetTokens) {
      const savedTokens = originalTokens - estimateMessagesTokens(messages);
      triggerVoid("hook::fire", { type: "AfterCompact", payload: { agentId: input.agentId, removedCount, savedTokens, finalMessageCount: messages.length } });
      return httpOk(req, { compressed: messages, removedCount, savedTokens });
    }

    const recentBudget = Math.floor(input.targetTokens * 0.4);
    let recentTokens = 0;
    let splitIdx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(messages[i].content || "");
      if (recentTokens + msgTokens > recentBudget) break;
      recentTokens += msgTokens;
      splitIdx = i;
    }

    if (splitIdx === messages.length && messages.length > 0) {
      splitIdx = messages.length - 1;
    }

    const oldMessages = messages.slice(0, splitIdx);
    const recentMessages = messages.slice(splitIdx);

    if (oldMessages.length === 0) {
      const savedTokens = originalTokens - estimateMessagesTokens(messages);
      triggerVoid("hook::fire", { type: "AfterCompact", payload: { agentId: input.agentId, removedCount, savedTokens, finalMessageCount: messages.length } });
      return httpOk(req, { compressed: messages, removedCount, savedTokens });
    }

    const summaryText = oldMessages
      .filter((m) => m.content)
      .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 150)}`)
      .join("\n");

    const SUMMARY_TEMPLATE = `[Structured Summary]
Goal: <primary objective>
Progress: <completed steps>
Decisions: <key decisions made>
Files: <important files/paths mentioned>
Next Steps: <pending work>
Critical Context: <must-preserve details>`;

    const existingSummaryIdx = messages.findIndex(
      (m) =>
        m.role === "system" &&
        m.content?.includes("[Structured Summary]"),
    );
    const existingSummaryContent =
      existingSummaryIdx >= 0 ? messages[existingSummaryIdx].content : "";

    const iterativeBlock = existingSummaryContent
      ? `\nPREVIOUS SUMMARY TO UPDATE:\n${existingSummaryContent}\n`
      : "";

    try {
      const llmSummary: any = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            maxTokens: 1024,
          },
          systemPrompt:
            "Summarize this conversation into the structured template. Preserve key facts and decisions.",
          messages: [
            {
              role: "user",
              content: `${iterativeBlock}TEMPLATE:\n${SUMMARY_TEMPLATE}\n\nCONVERSATION:\n${summaryText.slice(0, 8000)}`,
            },
          ],
        },
      });
      const condensed: Message = {
        role: "system",
        content: `[Structured Summary]\n${llmSummary.content}`,
      };
      removedCount += oldMessages.length;
      const filtered = recentMessages.filter(
        (m) =>
          !(
            m.role === "system" &&
            m.content?.includes("[Structured Summary]")
          ),
      );
      messages = [condensed, ...filtered];
    } catch {
      const condensed: Message = {
        role: "system",
        content: `[Structured Summary]\nGoal: ${summaryText.slice(0, 500)}\nProgress: ${oldMessages.length} messages processed\nDecisions: See context\nFiles: N/A\nNext Steps: Continue conversation\nCritical Context: ${summaryText.slice(0, 1000)}`,
      };
      removedCount += oldMessages.length;
      const filtered = recentMessages.filter(
        (m) =>
          !(
            m.role === "system" &&
            m.content?.includes("[Structured Summary]")
          ),
      );
      messages = [condensed, ...filtered];
    }

    const savedTokens = originalTokens - estimateMessagesTokens(messages);

    triggerVoid("hook::fire", { type: "AfterCompact", payload: { agentId: input.agentId, removedCount, savedTokens, finalMessageCount: messages.length } });

    return httpOk(req, {
      compressed: messages,
      removedCount,
      savedTokens,
    });
  },
);

registerFunction(
  {
    id: "context::stats",
    description: "Current context metrics",
    metadata: { category: "context" },
  },
  async (input: {
    messages: Message[];
  }): Promise<{
    totalTokens: number;
    messageCount: number;
    toolResultCount: number;
    uniqueTools: number;
    oldestMessageAge: number;
    healthScore: number;
  }> => {
    const totalTokens = estimateMessagesTokens(input.messages);
    const toolMessages = input.messages.filter(
      (m) => m.role === "tool" || m.toolResults,
    );
    const toolIds = new Set<string>();
    for (const m of input.messages) {
      if (m.role === "tool" && m.content) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed.tool_call_id) toolIds.add(parsed.tool_call_id);
        } catch {
          toolIds.add(`tool_${toolIds.size}`);
        }
      }
    }

    const now = Date.now();
    const oldest = input.messages[0]?.timestamp;
    const oldestAge = oldest ? (now - oldest) / (1000 * 60) : 0;

    const health: any = await trigger({
      function_id: "context::health",
      payload: { messages: input.messages, maxTokens: 200_000 },
    }).catch(() => ({ overall: -1 }));

    return {
      totalTokens,
      messageCount: input.messages.length,
      toolResultCount: toolMessages.length,
      uniqueTools: toolIds.size,
      oldestMessageAge: Math.round(oldestAge),
      healthScore: health.overall,
    };
  },
);

registerFunction(
  {
    id: "context::trim",
    description: "Lightweight in-turn compression without LLM",
    metadata: { category: "context" },
  },
  async (req: any): Promise<{
    compacted: Message[];
    removedTokens: number;
  }> => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const originalTokens = estimateMessagesTokens(input.messages);
    const messages = [...input.messages];
    const result: Message[] = [];

    const recentBoundary = Math.max(0, messages.length - 5);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        i < recentBoundary &&
        (msg.role === "tool" || msg.toolResults) &&
        (msg.content || "").length > 100
      ) {
        result.push({
          ...msg,
          content: (msg.content || "").slice(0, 100),
          toolResults: undefined,
        });
        continue;
      }

      const prev = result[result.length - 1];
      if (prev && prev.content === msg.content && prev.role === msg.role) {
        continue;
      }

      if (prev && prev.role === "system" && msg.role === "system") {
        result[result.length - 1] = {
          ...prev,
          content: prev.content + "\n" + msg.content,
        };
        continue;
      }

      result.push(msg);
    }

    return httpOk(req, {
      compacted: result,
      removedTokens: originalTokens - estimateMessagesTokens(result),
    });
  },
);

registerFunction(
  {
    id: "context::prune",
    description: "Drop old turns entirely, keep structured summary placeholder",
    metadata: { category: "context" },
  },
  async (req: any): Promise<{
    snipped: Message[];
    removedCount: number;
  }> => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const messages = [...input.messages];
    if (messages.length <= 10) {
      return httpOk(req, { snipped: messages, removedCount: 0 });
    }

    const keepStart = 3;
    const keepEndCount = Math.ceil(messages.length * 0.4);
    const keepEndStart = messages.length - keepEndCount;

    if (keepEndStart <= keepStart) {
      return httpOk(req, { snipped: messages, removedCount: 0 });
    }

    const head = messages.slice(0, keepStart);
    const tail = messages.slice(keepEndStart);
    const removedCount = keepEndStart - keepStart;

    const snipMessage: Message = {
      role: "system",
      content: `[Snipped ${removedCount} messages]`,
    };

    return httpOk(req, {
      snipped: [...head, snipMessage, ...tail],
      removedCount,
    });
  },
);

registerFunction(
  {
    id: "context::auto_optimize",
    description: "Pattern-detection-triggered compaction",
    metadata: { category: "context" },
  },
  async (req: any): Promise<{
    compacted: Message[];
    strategy: string;
    savedTokens: number;
  }> => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const originalTokens = estimateMessagesTokens(input.messages);
    const health: ContextHealthScore = await trigger({
      function_id: "context::health",
      payload: {
        messages: input.messages,
        maxTokens: input.maxTokens || 200_000,
      },
    });

    let messages = [...input.messages];
    let strategy = "none";

    if (health.repetitionPenalty < 10) {
      strategy = "deduplicate";
      const deduped: Message[] = [];
      for (const msg of messages) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.content === msg.content && prev.role === msg.role) {
          continue;
        }
        deduped.push(msg);
      }
      messages = deduped;
    }

    if (health.toolDensity < 10) {
      strategy = strategy === "none" ? "summarize_tools" : strategy + "+summarize_tools";
      messages = messages.map((m) => {
        if (
          (m.role === "tool" || m.toolResults) &&
          (m.content || "").length > 200
        ) {
          return {
            ...m,
            content: `[Tool summary: ${(m.content || "").slice(0, 100)}...]`,
            toolResults: undefined,
          };
        }
        return m;
      });
    }

    if (health.tokenUtilization < 20) {
      strategy = strategy === "none" ? "aggressive" : strategy + "+aggressive";
      const microResult: any = await trigger({
        function_id: "context::trim",
        payload: { messages },
      });
      messages = microResult.compacted;

      const snipResult: any = await trigger({
        function_id: "context::prune",
        payload: { messages },
      });
      messages = snipResult.snipped;
    }

    return httpOk(req, {
      compacted: messages,
      strategy,
      savedTokens: originalTokens - estimateMessagesTokens(messages),
    });
  },
);

registerTrigger({
  type: "http",
  function_id: "context::health",
  config: { api_path: "api/context/health", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::compress",
  config: { api_path: "api/context/compress", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::trim",
  config: { api_path: "api/context/micro-compact", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::prune",
  config: { api_path: "api/context/snip-compact", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::auto_optimize",
  config: { api_path: "api/context/reactive-compact", http_method: "POST" },
});

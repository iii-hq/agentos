import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import type { ContextHealthScore } from "./types.js";
import type { Message } from "./shared/tokens.js";
import { estimateTokens, estimateMessagesTokens } from "./shared/tokens.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "context-monitor",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

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
  async (input: {
    messages: Message[];
    maxTokens: number;
  }): Promise<ContextHealthScore> => {
    const usedTokens = estimateMessagesTokens(input.messages);
    const tokenUtilization = scoreTokenUtilization(usedTokens, input.maxTokens);
    const relevanceDecay = scoreRelevanceDecay(input.messages);
    const repetitionPenalty = scoreRepetition(input.messages);
    const toolDensity = scoreToolDensity(input.messages);

    return {
      overall: Math.round(
        tokenUtilization + relevanceDecay + repetitionPenalty + toolDensity,
      ),
      tokenUtilization: Math.round(tokenUtilization),
      relevanceDecay: Math.round(relevanceDecay),
      repetitionPenalty: Math.round(repetitionPenalty),
      toolDensity: Math.round(toolDensity),
    };
  },
);

registerFunction(
  {
    id: "context::compress",
    description: "Proactive context compression",
    metadata: { category: "context" },
  },
  async (input: {
    messages: Message[];
    targetTokens: number;
  }): Promise<{
    compressed: Message[];
    removedCount: number;
    savedTokens: number;
  }> => {
    const originalTokens = estimateMessagesTokens(input.messages);
    if (originalTokens <= input.targetTokens) {
      return { compressed: input.messages, removedCount: 0, savedTokens: 0 };
    }

    let messages = [...input.messages];
    let removedCount = 0;

    const recentBoundary = Math.max(0, messages.length - 10);
    for (let i = 0; i < recentBoundary; i++) {
      if (messages[i].role === "tool" || messages[i].toolResults) {
        const summary = `[Tool result summarized: ${(messages[i].content || "").slice(0, 100)}...]`;
        messages[i] = {
          ...messages[i],
          content: summary,
          toolResults: undefined,
        };
        removedCount++;
      }
    }

    if (estimateMessagesTokens(messages) <= input.targetTokens) {
      return {
        compressed: messages,
        removedCount,
        savedTokens: originalTokens - estimateMessagesTokens(messages),
      };
    }

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
      return {
        compressed: messages,
        removedCount,
        savedTokens: originalTokens - estimateMessagesTokens(messages),
      };
    }

    const halfIdx = Math.floor(messages.length / 2);
    const oldMessages = messages.slice(0, halfIdx);
    const recentMessages = messages.slice(halfIdx);

    const summaryText = oldMessages
      .filter((m) => m.content)
      .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 150)}`)
      .join("\n");

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
          "Summarize this conversation concisely, preserving key facts and decisions.",
        messages: [{ role: "user", content: summaryText.slice(0, 8000) }],
      },
      });
      const condensed: Message = {
        role: "system",
        content: `[Conversation summary - ${oldMessages.length} messages condensed]\n${llmSummary.content}`,
      };
      removedCount += oldMessages.length;
      messages = [condensed, ...recentMessages];
    } catch {
      const condensed: Message = {
        role: "system",
        content: `[Conversation summary - ${oldMessages.length} messages condensed]\n${summaryText.slice(0, 2000)}`,
      };
      removedCount += oldMessages.length;
      messages = [condensed, ...recentMessages];
    }

    return {
      compressed: messages,
      removedCount,
      savedTokens: originalTokens - estimateMessagesTokens(messages),
    };
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

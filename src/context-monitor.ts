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

function sanitizeToolPairs(messages: Message[]): Message[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const cid = tc.callId || tc.id;
        if (cid) callIds.add(cid);
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id);
    }
  }

  const orphanedResults = new Set(
    [...resultIds].filter((id) => !callIds.has(id)),
  );
  let filtered = messages.filter(
    (m) => !(m.role === "tool" && orphanedResults.has(m.tool_call_id)),
  );

  const missingResults = new Set(
    [...callIds].filter((id) => !resultIds.has(id)),
  );
  if (missingResults.size > 0) {
    const patched: Message[] = [];
    for (const msg of filtered) {
      patched.push(msg);
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const cid = tc.callId || tc.id;
          if (missingResults.has(cid)) {
            patched.push({
              role: "tool",
              content: "[Result cleared — see context summary]",
              tool_call_id: cid,
            } as Message);
          }
        }
      }
    }
    filtered = patched;
  }

  return filtered;
}

registerFunction(
  {
    id: "context::compress",
    description: "Structured context compression with iterative updates",
    metadata: { category: "context" },
  },
  async (input: {
    messages: Message[];
    targetTokens: number;
    agentId?: string;
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

    const recentBoundary = Math.max(
      0,
      messages.length - Math.ceil(messages.length * 0.4),
    );
    for (let i = 0; i < recentBoundary; i++) {
      if (
        (messages[i].role === "tool" || messages[i].toolResults) &&
        (messages[i].content || "").length > 200
      ) {
        messages[i] = {
          ...messages[i],
          content: `[Tool result truncated: ${(messages[i].content || "").slice(0, 200)}]`,
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
      return {
        compressed: messages,
        removedCount,
        savedTokens: originalTokens - estimateMessagesTokens(messages),
      };
    }

    const tailBudget = Math.floor(input.targetTokens * 0.4);
    let tailStart = messages.length;
    let tailTokens = 0;
    const headEnd = Math.min(3, messages.length);
    for (let i = messages.length - 1; i >= headEnd; i--) {
      const msgTokens = estimateTokens(messages[i].content || "") + 10;
      if (tailTokens + msgTokens > tailBudget) break;
      tailTokens += msgTokens;
      tailStart = i;
    }

    if (headEnd >= tailStart) {
      return {
        compressed: messages,
        removedCount,
        savedTokens: originalTokens - estimateMessagesTokens(messages),
      };
    }

    const turnsToSummarize = messages.slice(headEnd, tailStart);
    const serialized = turnsToSummarize
      .map((m) => {
        const content = (m.content || "").slice(0, 3000);
        if (m.role === "tool") return `[TOOL RESULT]: ${content}`;
        if (m.role === "assistant") return `[ASSISTANT]: ${content}`;
        return `[${(m.role || "unknown").toUpperCase()}]: ${content}`;
      })
      .join("\n\n");

    const existingSummary = messages.find(
      (m) =>
        m.role === "system" && (m.content || "").includes("[Structured Summary]"),
    );

    const summaryBudget = Math.min(
      Math.floor(estimateTokens(serialized) * 0.3),
      12000,
    );

    const SUMMARY_TEMPLATE = `## Goal
What the user is trying to accomplish.

## Progress
### Done
Completed work — include file paths, commands, results.
### In Progress
Work currently underway.

## Key Decisions
Important decisions and why they were made.

## Files Modified
File paths that were read, modified, or created.

## Next Steps
What needs to happen next.

## Critical Context
Values, error messages, config that would be lost without preservation.`;

    let prompt: string;
    if (existingSummary) {
      prompt = `Update this existing context summary with the new conversation data.

PREVIOUS SUMMARY:
${existingSummary.content}

NEW TURNS TO INCORPORATE:
${serialized}

Use this structure. PRESERVE existing info, ADD new progress:
${SUMMARY_TEMPLATE}

Target ~${summaryBudget} tokens. Be specific.`;
    } else {
      prompt = `Create a structured handoff summary of this conversation.

TURNS TO SUMMARIZE:
${serialized}

Use this structure:
${SUMMARY_TEMPLATE}

Target ~${summaryBudget} tokens. Be specific.`;
    }

    let summary: string;
    try {
      const llmResult: any = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            maxTokens: Math.max(1024, summaryBudget * 2),
          },
          systemPrompt:
            "You create structured context summaries. Output only the summary using the exact template provided.",
          messages: [{ role: "user", content: prompt.slice(0, 16000) }],
        },
      });
      summary = (llmResult?.content || "").trim();
    } catch {
      summary = serialized.slice(0, 2000);
    }

    removedCount += turnsToSummarize.length;
    const isOldSummary = (m: Message) =>
      m.role === "system" && (m.content || "").includes("[Structured Summary");
    const compressed: Message[] = [
      ...messages.slice(0, headEnd).filter((m) => !isOldSummary(m)),
      {
        role: "system",
        content: `[Structured Summary — ${turnsToSummarize.length} messages condensed]\n${summary}`,
      } as Message,
      ...messages.slice(tailStart).filter((m) => !isOldSummary(m)),
    ];

    return {
      compressed,
      removedCount,
      savedTokens: originalTokens - estimateMessagesTokens(compressed),
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

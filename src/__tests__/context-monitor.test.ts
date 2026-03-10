import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

const handlers: Record<string, Function> = {};

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "context::health") {
    const handler = handlers["context::health"];
    if (handler) return handler(data);
    return { overall: -1 };
  }
  if (fnId === "llm::complete") {
    return { content: "Summary text" };
  }
  return null;
});
const mockTriggerVoid = vi.fn();

vi.mock("iii-sdk", () => ({
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

vi.mock("../shared/tokens.js", () => ({
  estimateTokens: (text: string) => Math.ceil([...text].length / 4),
  estimateMessagesTokens: (msgs: any[]) => {
    let total = 0;
    for (const m of msgs) {
      total += Math.ceil([...(m.content || "")].length / 4);
      if (m.toolResults)
        total += Math.ceil(JSON.stringify(m.toolResults).length / 4);
    }
    return total;
  },
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../context-monitor.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("context::health", () => {
  it("returns score of 100 for ideal context with recent timestamps", async () => {
    const now = Date.now();
    const messages = [
      { role: "user", content: "Hello, can you help me?", timestamp: now - 1000 },
      { role: "assistant", content: "Sure, I can help you with that.", timestamp: now - 900 },
      { role: "tool", content: "Tool result data here", timestamp: now - 800 },
      { role: "user", content: "Thanks for the tool output", timestamp: now - 700 },
      { role: "assistant", content: "Here is my analysis of the results", timestamp: now - 600 },
      { role: "tool", content: "Another tool result", timestamp: now - 500 },
      { role: "user", content: "Great, one more question", timestamp: now - 400 },
      { role: "assistant", content: "Happy to answer more questions", timestamp: now - 300 },
      { role: "tool", content: "Final tool output", timestamp: now - 200 },
      { role: "user", content: "Perfect, that answers everything", timestamp: now - 100 },
    ];
    const result = await call("context::health", {
      messages,
      maxTokens: 200_000,
    });
    expect(result.overall).toBe(100);
    expect(result.tokenUtilization).toBe(25);
    expect(result.relevanceDecay).toBe(25);
    expect(result.toolDensity).toBe(25);
    expect(result.repetitionPenalty).toBe(25);
  });

  it("returns lower score for high token utilization", async () => {
    const longContent = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: longContent + ` unique${i}`,
    }));
    const result = await call("context::health", {
      messages,
      maxTokens: 5000,
    });
    expect(result.tokenUtilization).toBeLessThan(25);
    expect(result.overall).toBeLessThan(100);
  });

  it("penalizes repetitive messages", async () => {
    const messages = Array.from({ length: 10 }, () => ({
      role: "user",
      content: "The exact same message repeated over and over again",
    }));
    const result = await call("context::health", {
      messages,
      maxTokens: 200_000,
    });
    expect(result.repetitionPenalty).toBeLessThan(25);
    expect(result.overall).toBeLessThan(100);
  });

  it("returns score in 0-100 range", async () => {
    const messages = [
      { role: "user", content: "short" },
      { role: "assistant", content: "reply" },
    ];
    const result = await call("context::health", {
      messages,
      maxTokens: 200_000,
    });
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(result.tokenUtilization).toBeGreaterThanOrEqual(0);
    expect(result.tokenUtilization).toBeLessThanOrEqual(25);
    expect(result.relevanceDecay).toBeGreaterThanOrEqual(0);
    expect(result.relevanceDecay).toBeLessThanOrEqual(25);
    expect(result.repetitionPenalty).toBeGreaterThanOrEqual(0);
    expect(result.repetitionPenalty).toBeLessThanOrEqual(25);
    expect(result.toolDensity).toBeGreaterThanOrEqual(0);
    expect(result.toolDensity).toBeLessThanOrEqual(25);
  });
});

describe("context::compress", () => {
  it("returns unchanged when under target", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = await call("context::compress", {
      messages,
      targetTokens: 100_000,
    });
    expect(result.compressed).toEqual(messages);
    expect(result.removedCount).toBe(0);
    expect(result.savedTokens).toBe(0);
  });

  it("summarizes tool results when over target", async () => {
    const longToolResult = "x".repeat(2000);
    const messages = [
      { role: "tool", content: longToolResult, toolResults: { data: "big" } },
      ...Array.from({ length: 11 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} with some text content`,
      })),
    ];
    const result = await call("context::compress", {
      messages,
      targetTokens: 100,
    });
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.savedTokens).toBeGreaterThan(0);
  });
});

describe("context::stats", () => {
  it("returns correct message count and tool count", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "tool", content: '{"tool_call_id": "t1"}' },
      { role: "user", content: "Thanks" },
      { role: "tool", content: '{"tool_call_id": "t2"}' },
    ];
    const result = await call("context::stats", { messages });
    expect(result.messageCount).toBe(5);
    expect(result.toolResultCount).toBe(2);
    expect(result.uniqueTools).toBe(2);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.healthScore).toBeDefined();
  });
});

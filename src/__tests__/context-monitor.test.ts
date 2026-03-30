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
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
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

describe("context::compress - orphan removal", () => {
  it("removes orphaned tool results", async () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ callId: "tc1", id: "tool::read" }],
      },
      { role: "tool", content: "result 1", tool_call_id: "tc1" },
      { role: "tool", content: "orphaned result", tool_call_id: "tc_missing" },
      ...Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg ${i} ${"x".repeat(200)}`,
      })),
    ];
    const result = await call("context::compress", {
      messages,
      targetTokens: 50,
    });
    const orphanedContent = result.compressed.find(
      (m: any) => m.tool_call_id === "tc_missing",
    );
    expect(orphanedContent).toBeUndefined();
  });

  it("adds stub for orphaned tool calls", async () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { callId: "tc1", id: "tool::read" },
          { callId: "tc2", id: "tool::write" },
        ],
      },
      { role: "tool", content: "result 1", tool_call_id: "tc1" },
      ...Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg ${i} ${"x".repeat(200)}`,
      })),
    ];
    const result = await call("context::compress", {
      messages,
      targetTokens: 50,
    });
    const stub = result.compressed.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "tc2",
    );
    expect(stub).toBeDefined();
    expect(stub.content).toBe("[Result cleared — see context summary]");
  });
});

describe("context::compress - tail protection", () => {
  it("preserves recent messages within 40% budget", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message number ${i} with content ${"y".repeat(100)}`,
    }));
    const result = await call("context::compress", {
      messages,
      targetTokens: 200,
    });
    const lastMsg = result.compressed[result.compressed.length - 1];
    expect(lastMsg.content).toContain("Message number 29");
  });
});

describe("context::compress - structured template", () => {
  it("uses structured summary template", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Long message ${i} ${"z".repeat(300)}`,
    }));
    const result = await call("context::compress", {
      messages,
      targetTokens: 100,
    });
    const summaryMsg = result.compressed.find(
      (m: any) =>
        m.role === "system" && m.content?.includes("[Structured Summary]"),
    );
    expect(summaryMsg).toBeDefined();
  });

  it("handles iterative update with existing summary", async () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Structured Summary]\nGoal: Build API\nProgress: Started",
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as string,
        content: `Continuation message ${i} ${"w".repeat(300)}`,
      })),
    ];
    const result = await call("context::compress", {
      messages,
      targetTokens: 100,
    });
    const summaries = result.compressed.filter(
      (m: any) =>
        m.role === "system" && m.content?.includes("[Structured Summary]"),
    );
    expect(summaries.length).toBeLessThanOrEqual(1);
  });

  it("falls back gracefully on LLM failure", async () => {
    mockTrigger.mockImplementationOnce(async (fnId: string, data?: any) => {
      if (fnId === "llm::complete") throw new Error("LLM unavailable");
      if (fnId === "context::health") return { overall: -1 };
      return null;
    });

    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Fallback test ${i} ${"f".repeat(300)}`,
    }));
    const result = await call("context::compress", {
      messages,
      targetTokens: 100,
    });
    expect(result.compressed.length).toBeGreaterThan(0);
    const summaryMsg = result.compressed.find(
      (m: any) =>
        m.role === "system" && m.content?.includes("[Structured Summary]"),
    );
    expect(summaryMsg).toBeDefined();
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

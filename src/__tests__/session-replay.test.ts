import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}
function seedKv(scope: string, key: string, value: unknown) {
  getScope(scope).set(key, value);
}

const handlers: Record<string, Function> = {};

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "merge") {
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
      } else if (op.type === "set") {
        current[op.path] = op.value;
      } else if (op.type === "increment") {
        current[op.path] = (current[op.path] || 0) + op.value;
      }
    }
    if (data.upsert && Object.keys(current).length === 0) {
      Object.assign(current, data.upsert);
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "replay::get") {
    const handler = handlers["replay::get"];
    if (handler) return handler(data);
    return [];
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

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../session-replay.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("replay::record", () => {
  it("stores entry with sequence number", async () => {
    const result = await call("replay::record", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: { toolId: "read" },
      durationMs: 100,
    });
    expect(result.recorded).toBe(true);
    expect(result.sequence).toBeDefined();
    expect(typeof result.sequence).toBe("number");
  });

  it("returns error for missing fields", async () => {
    const result = await call("replay::record", {
      sessionId: "s1",
      data: {},
    });
    expect(result.error).toBeDefined();
  });
});

describe("replay::get", () => {
  it("returns entries sorted by sequence", async () => {
    seedKv("replay", "s1:00000003", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: {},
      sequence: 3,
      timestamp: 1000,
    });
    seedKv("replay", "s1:00000001", {
      sessionId: "s1",
      agentId: "a1",
      action: "llm_call",
      data: {},
      sequence: 1,
      timestamp: 900,
    });
    seedKv("replay", "s1:00000002", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_result",
      data: {},
      sequence: 2,
      timestamp: 950,
    });
    const result = await call("replay::get", { sessionId: "s1" });
    expect(result).toHaveLength(3);
    expect(result[0].sequence).toBe(1);
    expect(result[1].sequence).toBe(2);
    expect(result[2].sequence).toBe(3);
  });

  it("filters by sessionId", async () => {
    seedKv("replay", "s1:00000001", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: {},
      sequence: 1,
    });
    seedKv("replay", "s2:00000001", {
      sessionId: "s2",
      agentId: "a2",
      action: "llm_call",
      data: {},
      sequence: 1,
    });
    const result = await call("replay::get", { sessionId: "s1" });
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s1");
  });
});

describe("replay::search", () => {
  it("filters by agentId", async () => {
    seedKv("replay", "s1:00000001", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: {},
      timestamp: 1000,
      sequence: 1,
    });
    seedKv("replay", "s2:00000001", {
      sessionId: "s2",
      agentId: "a2",
      action: "llm_call",
      data: {},
      timestamp: 2000,
      sequence: 1,
    });
    const result = await call("replay::search", { agentId: "a1" });
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s1");
    expect(result[0].agentId).toBe("a1");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      seedKv("replay", `s${i}:00000001`, {
        sessionId: `s${i}`,
        agentId: "a1",
        action: "tool_call",
        data: {},
        timestamp: 1000 + i,
        sequence: 1,
      });
    }
    const result = await call("replay::search", { agentId: "a1", limit: 2 });
    expect(result).toHaveLength(2);
  });
});

describe("replay::summary", () => {
  it("calculates total duration and tool calls", async () => {
    seedKv("replay", "s1:00000001", {
      sessionId: "s1",
      agentId: "a1",
      action: "llm_call",
      data: { usage: { total: 500, cost: 0.01 } },
      durationMs: 200,
      timestamp: 1000,
      iteration: 1,
      sequence: 1,
    });
    seedKv("replay", "s1:00000002", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: { toolId: "read" },
      durationMs: 50,
      timestamp: 1200,
      iteration: 1,
      sequence: 2,
    });
    seedKv("replay", "s1:00000003", {
      sessionId: "s1",
      agentId: "a1",
      action: "tool_call",
      data: { toolId: "write" },
      durationMs: 75,
      timestamp: 1300,
      iteration: 2,
      sequence: 3,
    });
    const result = await call("replay::summary", { sessionId: "s1" });
    expect(result.sessionId).toBe("s1");
    expect(result.agentId).toBe("a1");
    expect(result.totalDuration).toBe(325);
    expect(result.toolCalls).toBe(2);
    expect(result.tools).toContain("read");
    expect(result.tools).toContain("write");
    expect(result.actionCount).toBe(3);
    expect(result.iterations).toBe(2);
    expect(result.tokensUsed).toBe(500);
    expect(result.cost).toBe(0.01);
  });
});

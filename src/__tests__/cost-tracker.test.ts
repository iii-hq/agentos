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

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::list") {
    const entries = [...getScope(data.scope).entries()];
    if (data.prefix) {
      return entries
        .filter(([key]) => key.startsWith(data.prefix))
        .map(([key, value]) => ({ key, value }));
    }
    return entries.map(([key, value]) => ({ key, value }));
  }
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") current[op.path] = op.value;
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
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

vi.mock("../shared/pricing.js", () => ({
  PRICING: {
    "claude-opus-4-6": { input: 15, output: 75 },
    "gpt-4o": { input: 2.5, output: 10 },
  },
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../cost-tracker.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("cost::track", () => {
  it("calculates cost correctly for known model", async () => {
    const result = await call("cost::track", {
      agentId: "agent-1",
      sessionId: "sess-1",
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
    });
    const expected = (1000 * 15 + 500 * 75) / 1_000_000;
    expect(result.cost).toBeCloseTo(expected, 8);
    expect(result.provider).toBe("known");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("handles unknown model with zero pricing", async () => {
    const result = await call("cost::track", {
      agentId: "agent-1",
      sessionId: "sess-1",
      model: "unknown-model-xyz",
      inputTokens: 5000,
      outputTokens: 2000,
    });
    expect(result.cost).toBe(0);
    expect(result.provider).toBe("unknown");
  });

  it("stores record in cost_records scope", async () => {
    await call("cost::track", {
      agentId: "agent-1",
      sessionId: "sess-1",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 200,
    });
    const setCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set" && c[1].scope === "cost_records",
    );
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][1].value.agentId).toBe("agent-1");
    expect(setCalls[0][1].value.model).toBe("gpt-4o");
  });

  it("calculates cost for gpt-4o model", async () => {
    const result = await call("cost::track", {
      agentId: "agent-2",
      sessionId: "sess-2",
      model: "gpt-4o",
      inputTokens: 2000,
      outputTokens: 1000,
    });
    const expected = (2000 * 2.5 + 1000 * 10) / 1_000_000;
    expect(result.cost).toBeCloseTo(expected, 8);
  });

  it("updates daily aggregates via triggerVoid", async () => {
    await call("cost::track", {
      agentId: "agent-1",
      sessionId: "sess-1",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "state::update",
      expect.objectContaining({ scope: "cost_daily" }),
    );
  });

  it("includes cache token costs when provided", async () => {
    const result = await call("cost::track", {
      agentId: "agent-1",
      sessionId: "sess-1",
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });
    const cacheReadPrice = 15 * 0.1;
    const cacheWritePrice = 15 * 1.25;
    const expected =
      (1000 * 15 + 500 * 75 + 200 * cacheReadPrice + 100 * cacheWritePrice) /
      1_000_000;
    expect(result.cost).toBeCloseTo(expected, 8);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheWriteTokens).toBe(100);
  });
});

describe("cost::summary", () => {
  it("returns total and breakdown", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedKv("cost_records", `${today}:agent-1:sess-1:1000`, {
      agentId: "agent-1",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.00075,
      timestamp: Date.now(),
    });
    seedKv("cost_records", `${today}:agent-1:sess-1:2000`, {
      agentId: "agent-1",
      model: "gpt-4o",
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.0015,
      timestamp: Date.now(),
    });

    const result = await call("cost::summary", {
      startDate: today,
      endDate: today,
    });
    expect(result.total).toBeCloseTo(0.00225, 6);
    expect(result.breakdown.length).toBeGreaterThan(0);
    expect(result.period.start).toBe(today);
    expect(result.period.end).toBe(today);
  });

  it("groups by agent", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    seedKv("cost_records", `${today}:agent-a:sess-1:${now}`, {
      agentId: "agent-a",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      timestamp: now,
    });
    seedKv("cost_records", `${today}:agent-b:sess-1:${now + 1}`, {
      agentId: "agent-b",
      model: "gpt-4o",
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.002,
      timestamp: now + 1,
    });

    const result = await call("cost::summary", {
      startDate: today,
      endDate: today,
      groupBy: "agent",
    });
    expect(result.breakdown.length).toBe(2);
    const keys = result.breakdown.map((b: any) => b.key).sort();
    expect(keys).toEqual(["agent-a", "agent-b"]);
  });

  it("filters by agentId when provided", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    seedKv("cost_records", `${today}:agent-a:sess-1:${now}`, {
      agentId: "agent-a",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      timestamp: now,
    });
    seedKv("cost_records", `${today}:agent-b:sess-1:${now + 1}`, {
      agentId: "agent-b",
      model: "gpt-4o",
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.002,
      timestamp: now + 1,
    });

    const result = await call("cost::summary", {
      agentId: "agent-a",
      startDate: today,
      endDate: today,
    });
    expect(result.total).toBeCloseTo(0.001, 6);
  });
});

describe("cost::budget_check", () => {
  it("returns within budget when no budget configured", async () => {
    const result = await call("cost::budget_check", { agentId: "agent-1" });
    expect(result.withinBudget).toBe(true);
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });

  it("detects budget exceeded", async () => {
    seedKv("agents", "agent-1", {
      resources: { dailyBudget: 0.001, monthlyBudget: 1.0 },
    });
    const today = new Date().toISOString().slice(0, 10);
    seedKv("cost_daily", `${today}:agent-1`, {
      cost: 0.5,
      inputTokens: 10000,
      outputTokens: 5000,
      calls: 10,
    });

    const result = await call("cost::budget_check", { agentId: "agent-1" });
    expect(result.withinBudget).toBe(false);
    expect(result.spent).toBeGreaterThan(0);
  });

  it("audits when budget is exceeded", async () => {
    seedKv("agents", "agent-1", {
      resources: { dailyBudget: 0.0001 },
    });
    const today = new Date().toISOString().slice(0, 10);
    seedKv("cost_daily", `${today}:agent-1`, { cost: 1.0 });

    await call("cost::budget_check", { agentId: "agent-1" });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "budget_exceeded" }),
    );
  });

  it("returns within budget when spend is under limit", async () => {
    seedKv("agents", "agent-1", {
      resources: { dailyBudget: 100, monthlyBudget: 1000 },
    });
    const today = new Date().toISOString().slice(0, 10);
    seedKv("cost_daily", `${today}:agent-1`, { cost: 0.01 });

    const result = await call("cost::budget_check", { agentId: "agent-1" });
    expect(result.withinBudget).toBe(true);
  });
});

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
    for (const op of data.ops || data.operations || []) {
      if (op.type === "set") {
        current[op.path] = op.value;
      } else if (op.type === "increment") {
        current[op.path] = (current[op.path] || 0) + op.value;
      }
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

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../cron.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("cron::cleanup_stale_sessions", () => {
  it("removes stale sessions and keeps recent ones", async () => {
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    const recentTime = Date.now() - 1 * 60 * 60 * 1000;

    seedKv("agents", "agent-1", { name: "Agent 1" });

    seedKv("sessions:agent-1", "stale-session", {
      lastActiveAt: staleTime,
      name: "old",
    });
    seedKv("sessions:agent-1", "recent-session", {
      lastActiveAt: recentTime,
      name: "new",
    });

    const result = await call("cron::cleanup_stale_sessions", {});
    expect(result.cleaned).toBe(1);
    expect(result.checkedAt).toBeDefined();
    expect(getScope("sessions:agent-1").has("stale-session")).toBe(false);
    expect(getScope("sessions:agent-1").has("recent-session")).toBe(true);
  });

  it("handles empty agents list", async () => {
    const result = await call("cron::cleanup_stale_sessions", {});
    expect(result.cleaned).toBe(0);
    expect(result.checkedAt).toBeDefined();
  });
});

describe("cron::aggregate_daily_costs", () => {
  it("processes cost data", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedKv("costs", today, { totalCost: 1.5 });
    seedKv("metering", "entry-1", { totalTokens: 500 });
    seedKv("metering", "entry-2", { totalTokens: 300 });

    const result = await call("cron::aggregate_daily_costs", {});
    expect(result.date).toBe(today);
    expect(result.aggregated).toBe(true);

    const updated = getScope("costs").get(today) as any;
    expect(updated.totalTokens).toBe(800);
    expect(updated.aggregatedAt).toBeDefined();
  });

  it("handles missing cost data", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const result = await call("cron::aggregate_daily_costs", {});
    expect(result.date).toBe(today);
    expect(result.aggregated).toBe(true);
    expect(getScope("costs").has(today)).toBe(false);
  });
});

describe("cron::reset_rate_limits", () => {
  it("removes expired windows", async () => {
    const expiredTime = Date.now() - 60 * 1000;
    seedKv("rates", "rate-1", { windowEnd: expiredTime, count: 10 });
    seedKv("rates", "rate-2", { windowEnd: expiredTime - 5000, count: 5 });

    const result = await call("cron::reset_rate_limits", {});
    expect(result.reset).toBe(2);
    expect(result.checkedAt).toBeDefined();
    expect(getScope("rates").has("rate-1")).toBe(false);
    expect(getScope("rates").has("rate-2")).toBe(false);
  });

  it("keeps active windows", async () => {
    const futureTime = Date.now() + 60 * 1000;
    const expiredTime = Date.now() - 60 * 1000;
    seedKv("rates", "active-rate", { windowEnd: futureTime, count: 3 });
    seedKv("rates", "expired-rate", { windowEnd: expiredTime, count: 7 });

    const result = await call("cron::reset_rate_limits", {});
    expect(result.reset).toBe(1);
    expect(getScope("rates").has("active-rate")).toBe(true);
    expect(getScope("rates").has("expired-rate")).toBe(false);
  });
});

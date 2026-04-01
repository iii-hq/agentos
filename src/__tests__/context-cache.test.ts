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
  if (fnId === "memory::recall") {
    return { data: "fetched-value" };
  }
  return null;
});

vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: (req: any) => mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
}));

vi.mock("../shared/config.js", () => ({
  ENGINE_URL: "ws://localhost:3111",
  OTEL_CONFIG: undefined,
  registerShutdown: vi.fn(),
}));
vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  sanitizeId: (id: string) => id,
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
});

beforeAll(async () => {
  await import("../context-cache.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("context_cache::get_or_fetch", () => {
  it("fetches and caches on miss", async () => {
    const result = await call("context_cache::get_or_fetch", {
      agentId: "agent-1",
      key: "test-key",
      fetchFunctionId: "memory::recall",
      fetchPayload: { query: "test" },
      ttlMs: 60_000,
    });

    expect(result).toEqual({ data: "fetched-value" });

    const cached = getScope("cache:agent-1").get("test-key") as any;
    expect(cached).toBeTruthy();
    expect(cached.value).toEqual({ data: "fetched-value" });
  });

  it("returns cached value on hit", async () => {
    const now = Date.now();
    getScope("cache:agent-1").set("test-key", {
      value: { data: "cached-data" },
      cachedAt: now,
      ttlMs: 60_000,
    });

    const result = await call("context_cache::get_or_fetch", {
      agentId: "agent-1",
      key: "test-key",
      fetchFunctionId: "memory::recall",
      fetchPayload: { query: "test" },
      ttlMs: 60_000,
    });

    expect(result).toEqual({ data: "cached-data" });
    const fetchCalls = mockTrigger.mock.calls.filter(
      ([id]: any) => id === "memory::recall",
    );
    expect(fetchCalls.length).toBe(0);
  });

  it("re-fetches on expired cache", async () => {
    getScope("cache:agent-1").set("test-key", {
      value: { data: "stale-data" },
      cachedAt: Date.now() - 120_000,
      ttlMs: 60_000,
    });

    const result = await call("context_cache::get_or_fetch", {
      agentId: "agent-1",
      key: "test-key",
      fetchFunctionId: "memory::recall",
      fetchPayload: { query: "test" },
      ttlMs: 60_000,
    });

    expect(result).toEqual({ data: "fetched-value" });
  });
});

describe("context_cache::invalidate", () => {
  it("clears a single key", async () => {
    getScope("cache:agent-1").set("k1", {
      value: "v1",
      cachedAt: Date.now(),
      ttlMs: 60_000,
    });
    getScope("cache:agent-1").set("k2", {
      value: "v2",
      cachedAt: Date.now(),
      ttlMs: 60_000,
    });

    const result = await call("context_cache::invalidate", {
      agentId: "agent-1",
      key: "k1",
    });

    expect(result).toEqual({ cleared: 1 });
    expect(getScope("cache:agent-1").has("k1")).toBe(false);
    expect(getScope("cache:agent-1").has("k2")).toBe(true);
  });

  it("clears all keys for an agent", async () => {
    getScope("cache:agent-2").set("a", { value: 1, cachedAt: Date.now(), ttlMs: 1000 });
    getScope("cache:agent-2").set("b", { value: 2, cachedAt: Date.now(), ttlMs: 1000 });

    const result = await call("context_cache::invalidate", {
      agentId: "agent-2",
    });

    expect(result).toEqual({ cleared: 2 });
  });
});

describe("context_cache::stats", () => {
  it("returns stats for an agent after fetch operations", async () => {
    await call("context_cache::get_or_fetch", {
      agentId: "stats-agent",
      key: "k1",
      fetchFunctionId: "memory::recall",
      fetchPayload: {},
      ttlMs: 60_000,
    });

    await call("context_cache::get_or_fetch", {
      agentId: "stats-agent",
      key: "k1",
      fetchFunctionId: "memory::recall",
      fetchPayload: {},
      ttlMs: 60_000,
    });

    const stats = await call("context_cache::stats", {
      agentId: "stats-agent",
    });

    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("returns all stats when no agentId given", async () => {
    await call("context_cache::get_or_fetch", {
      agentId: "agent-a",
      key: "x",
      fetchFunctionId: "memory::recall",
      fetchPayload: {},
      ttlMs: 60_000,
    });

    const stats = await call("context_cache::stats", {});

    expect(typeof stats).toBe("object");
    expect(stats["agent-a"]).toBeTruthy();
  });
});

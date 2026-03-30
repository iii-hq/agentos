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
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "recovery::validate") {
    const handler = handlers["recovery::validate"];
    if (handler) return handler(data);
    return null;
  }
  if (fnId === "recovery::classify") {
    const handler = handlers["recovery::classify"];
    if (handler) return handler(data);
    return null;
  }
  if (fnId === "lifecycle::transition") {
    return { transitioned: true };
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

vi.mock("../shared/config.js", () => ({
  ENGINE_URL: "ws://localhost:3111",
  OTEL_CONFIG: {},
  registerShutdown: vi.fn(),
}));
vi.mock("../shared/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../shared/metrics.js", () => ({
  recordMetric: vi.fn(),
}));
vi.mock("../shared/errors.js", () => ({
  safeCall: async (fn: Function, fallback: any, _context?: any) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../recovery.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("recovery::classify", () => {
  it("classifies healthy agent", async () => {
    seedKv("lifecycle:a1", "state", { state: "working" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::classify", { agentId: "a1" });
    expect(result.classification).toBe("healthy");
  });

  it("classifies degraded agent (stale)", async () => {
    seedKv("lifecycle:a1", "state", { state: "working" });
    seedKv("sessions:a1", "s1", {
      lastActiveAt: Date.now() - 60 * 60 * 1000,
    });

    const result = await call("recovery::classify", { agentId: "a1" });
    expect(result.classification).toBe("degraded");
  });

  it("classifies dead agent (failed lifecycle)", async () => {
    seedKv("lifecycle:a1", "state", { state: "failed" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::classify", { agentId: "a1" });
    expect(result.classification).toBe("dead");
  });

  it("classifies unrecoverable agent (terminal + circuit breaker)", async () => {
    seedKv("lifecycle:a1", "state", { state: "terminated" });
    seedKv("circuit_breakers", "a1", { state: "open" });

    const result = await call("recovery::classify", { agentId: "a1" });
    expect(result.classification).toBe("unrecoverable");
  });

  it("classifies degraded for blocked lifecycle", async () => {
    seedKv("lifecycle:a1", "state", { state: "blocked" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::classify", { agentId: "a1" });
    expect(result.classification).toBe("degraded");
  });
});

describe("recovery::recover", () => {
  it("sends wake-up for degraded agents", async () => {
    seedKv("lifecycle:a1", "state", { state: "blocked" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("wake_up");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "tool::agent_send",
      expect.objectContaining({ targetAgentId: "a1" }),
    );
  });

  it("restarts dead agents", async () => {
    seedKv("lifecycle:a1", "state", { state: "failed" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("restart");
    expect(mockTrigger).toHaveBeenCalledWith(
      "lifecycle::transition",
      expect.objectContaining({ agentId: "a1", newState: "recovering" }),
    );
  });

  it("stops after max recovery attempts", async () => {
    seedKv("recovery_attempts", "a1", { count: 3 });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("exhausted");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "hook::fire",
      expect.objectContaining({ type: "RecoveryExhausted" }),
    );
  });

  it("escalates unrecoverable agents", async () => {
    seedKv("lifecycle:a1", "state", { state: "failed" });
    seedKv("circuit_breakers", "a1", { state: "open" });
    seedKv("memory:a1", "_health", { healthy: false });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("escalate");
  });

  it("takes no action for healthy agents", async () => {
    seedKv("lifecycle:a1", "state", { state: "working" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("none");
  });
});

describe("recovery::scan", () => {
  it("scans all agents", async () => {
    seedKv("agents", "a1", { id: "a1" });
    seedKv("agents", "a2", { id: "a2" });
    seedKv("lifecycle:a1", "state", { state: "working" });
    seedKv("lifecycle:a2", "state", { state: "blocked" });
    seedKv("sessions:a1", "s1", { lastActiveAt: Date.now() });

    const result = await call("recovery::scan", {});
    expect(result.scannedAt).toBeDefined();
    expect(result.agents.length).toBe(2);
  });

  it("returns empty when no agents", async () => {
    const result = await call("recovery::scan", {});
    expect(result.agents.length).toBe(0);
  });
});

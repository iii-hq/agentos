import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

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
      else if (op.type === "set") current[op.path] = op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "guard::stats") return data?._guardResponse || { circuitBroken: false };
  if (fnId === "replay::summary") return data?._replayResponse || { endTime: Date.now() };
  if (fnId === "recovery::validate") {
    const handler = handlers["recovery::validate"];
    if (handler) return handler(data);
  }
  if (fnId === "recovery::classify") {
    const handler = handlers["recovery::classify"];
    if (handler) return handler(data);
  }
  if (fnId === "recovery::recover") {
    const handler = handlers["recovery::recover"];
    if (handler) return handler(data);
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
  await import("../recovery.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("recovery::classify", () => {
  it("returns healthy when all checks pass", async () => {
    const result = await call("recovery::classify", {
      checks: {
        lifecycle: { passed: true },
        activity: { passed: true },
        circuitBreaker: { passed: true },
        memory: { passed: true },
      },
      ageMs: 1000,
      recoveryAttempts: 0,
    });
    expect(result).toBe("healthy");
  });

  it("returns unrecoverable for terminal lifecycle", async () => {
    const result = await call("recovery::classify", {
      checks: {
        lifecycle: { passed: false },
        activity: { passed: true },
        circuitBreaker: { passed: true },
        memory: { passed: true },
      },
      ageMs: 1000,
      recoveryAttempts: 0,
    });
    expect(result).toBe("unrecoverable");
  });

  it("returns dead when circuit breaker is tripped", async () => {
    const result = await call("recovery::classify", {
      checks: {
        lifecycle: { passed: true },
        activity: { passed: false },
        circuitBreaker: { passed: false },
        memory: { passed: true },
      },
      ageMs: 3600000,
      recoveryAttempts: 0,
    });
    expect(result).toBe("dead");
  });

  it("returns unrecoverable after max recovery attempts", async () => {
    const result = await call("recovery::classify", {
      checks: {
        lifecycle: { passed: true },
        activity: { passed: false },
      },
      ageMs: 5000,
      recoveryAttempts: 3,
    });
    expect(result).toBe("unrecoverable");
  });

  it("returns degraded for stale but recoverable session", async () => {
    const result = await call("recovery::classify", {
      checks: {
        lifecycle: { passed: true },
        activity: { passed: false },
        circuitBreaker: { passed: true },
        memory: { passed: true },
      },
      ageMs: 30 * 60 * 1000,
      recoveryAttempts: 0,
    });
    expect(result).toBe("degraded");
  });
});

describe("recovery::recover", () => {
  it("returns healthy for already healthy agent", async () => {
    getScope("agents").set("a1", { id: "a1" });
    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("none");
  });

  it("sends wake-up for degraded agent", async () => {
    getScope("lifecycle:a1").set("state", {
      state: "working",
      transitionedAt: Date.now() - 90 * 60 * 1000,
    });

    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") {
        getScope(data.scope).set(data.key, data.value);
        return { ok: true };
      }
      if (fnId === "state::update") {
        const scope = getScope(data.scope);
        const current: any = scope.get(data.key) || {};
        for (const op of data.operations || []) {
          if (op.type === "increment")
            current[op.path] = (current[op.path] || 0) + op.value;
          else if (op.type === "set") current[op.path] = op.value;
        }
        scope.set(data.key, current);
        return current;
      }
      if (fnId === "state::list") {
        return [...getScope(data.scope).entries()].map(([key, value]) => ({
          key,
          value,
        }));
      }
      if (fnId === "guard::stats") return { circuitBroken: false };
      if (fnId === "replay::summary")
        return { endTime: Date.now() - 90 * 60 * 1000 };
      if (fnId === "recovery::validate") {
        const handler = handlers["recovery::validate"];
        if (handler) return handler(data);
      }
      if (fnId === "recovery::classify") {
        const handler = handlers["recovery::classify"];
        if (handler) return handler(data);
      }
      return null;
    });

    const result = await call("recovery::recover", { agentId: "a1" });
    expect(result.action).toBe("wake_up");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "tool::agent_send",
      expect.objectContaining({ targetAgentId: "a1" }),
    );
  });
});

describe("recovery::scan", () => {
  it("scans all agents and returns reports", async () => {
    getScope("agents").set("a1", { id: "a1" });
    getScope("agents").set("a2", { id: "a2" });
    const result = await call("recovery::scan", {});
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBe(2);
  });
});

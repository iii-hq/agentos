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
      if (op.type === "set") current[op.path] = op.value;
      if (op.type === "merge")
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "guard::stats") return null;
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
  await import("../session-lifecycle.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("lifecycle::transition", () => {
  it("transitions from spawning to working", async () => {
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(result.transitioned).toBe(true);
    expect(result.from).toBe("spawning");
    expect(result.to).toBe("working");
  });

  it("rejects invalid transitions", async () => {
    seedKv("lifecycle:a1", "state", { state: "spawning" });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "merged",
    });
    expect(result.transitioned).toBe(false);
    expect(result.reason).toContain("Invalid transition");
  });

  it("rejects transitions from terminal states", async () => {
    seedKv("lifecycle:a1", "state", { state: "done" });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(result.transitioned).toBe(false);
    expect(result.reason).toContain("terminal state");
  });

  it("fires hook on transition", async () => {
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(result.transitioned).toBe(true);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "hook::fire",
      expect.objectContaining({
        type: "SessionStateChange",
        agentId: "a1",
        from: "spawning",
        to: "working",
      }),
    );
  });

  it("fires matching reactions", async () => {
    seedKv("lifecycle_reactions:a1", "rxn_1", {
      id: "rxn_1",
      from: "spawning",
      to: "working",
      action: "notify",
      payload: { msg: "started" },
      escalateAfter: 3,
      attempts: 0,
    });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(result.transitioned).toBe(true);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "hook::fire",
      expect.objectContaining({ type: "LifecycleNotification" }),
    );
  });

  it("transitions working to blocked", async () => {
    seedKv("lifecycle:a1", "state", { state: "working" });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "blocked",
      reason: "stuck",
    });
    expect(result.transitioned).toBe(true);
    expect(result.from).toBe("working");
    expect(result.to).toBe("blocked");
  });
});

describe("lifecycle::get_state", () => {
  it("returns spawning for unknown agent", async () => {
    const result = await call("lifecycle::get_state", { agentId: "unknown" });
    expect(result.state).toBe("spawning");
  });

  it("returns stored state", async () => {
    seedKv("lifecycle:a1", "state", {
      state: "working",
      transitionedAt: 123,
    });
    const result = await call("lifecycle::get_state", { agentId: "a1" });
    expect(result.state).toBe("working");
  });
});

describe("lifecycle::add_reaction", () => {
  it("registers a reaction rule", async () => {
    const result = await call("lifecycle::add_reaction", {
      agentId: "a1",
      from: "working",
      to: "blocked",
      action: "notify",
    });
    expect(result.registered).toBe(true);
    expect(result.id).toBeDefined();
  });

  it("clamps escalateAfter to minimum 1", async () => {
    const result = await call("lifecycle::add_reaction", {
      agentId: "a1",
      from: "working",
      to: "blocked",
      action: "send_to_agent",
      escalateAfter: 0,
    });
    expect(result.registered).toBe(true);
    const stored = getScope("lifecycle_reactions:a1").get(result.id) as any;
    expect(stored.escalateAfter).toBe(1);
  });
});

describe("lifecycle::list_reactions", () => {
  it("returns empty array when no reactions", async () => {
    const result = await call("lifecycle::list_reactions", {});
    expect(result).toEqual([]);
  });

  it("returns stored reactions", async () => {
    seedKv("lifecycle_reactions:a1", "r1", {
      id: "r1",
      from: "working",
      to: "blocked",
      action: "notify",
    });
    const result = await call("lifecycle::list_reactions", { agentId: "a1" });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("r1");
  });
});

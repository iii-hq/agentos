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
      else if (op.type === "merge")
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "guard::stats") return { circuitBroken: false, totalCalls: 0 };
  if (fnId === "lifecycle::transition") {
    const handler = handlers["lifecycle::transition"];
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
      reason: "Agent started",
    });
    expect(result.transitioned).toBe(true);
    expect(result.from).toBe("spawning");
    expect(result.to).toBe("working");
  });

  it("rejects invalid transition", async () => {
    getScope("lifecycle:a1").set("state", {
      state: "done",
      transitionedAt: Date.now(),
    });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(result.transitioned).toBe(false);
    expect(result.reason).toContain("terminal state");
  });

  it("rejects transition to disallowed state", async () => {
    getScope("lifecycle:a1").set("state", {
      state: "working",
      transitionedAt: Date.now(),
    });
    const result = await call("lifecycle::transition", {
      agentId: "a1",
      newState: "merged",
    });
    expect(result.transitioned).toBe(false);
    expect(result.reason).toContain("Invalid transition");
  });

  it("fires hook on successful transition", async () => {
    await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "hook::fire",
      expect.objectContaining({
        type: "SessionStateChange",
        from: "spawning",
        to: "working",
      }),
    );
  });

  it("fires matching reactions on transition", async () => {
    getScope("lifecycle_reactions").set("rxn1", {
      id: "rxn1",
      from: "spawning",
      to: "working",
      action: "send_to_agent",
      payload: { message: "Welcome!" },
      escalateAfter: 3,
      attempts: 0,
    });
    await call("lifecycle::transition", {
      agentId: "a1",
      newState: "working",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "tool::agent_send",
      expect.objectContaining({ targetAgentId: "a1" }),
    );
  });
});

describe("lifecycle::get_state", () => {
  it("returns spawning for new agent", async () => {
    const result = await call("lifecycle::get_state", { agentId: "new" });
    expect(result.state).toBe("spawning");
  });

  it("returns stored state", async () => {
    getScope("lifecycle:a1").set("state", {
      state: "working",
      transitionedAt: 12345,
    });
    const result = await call("lifecycle::get_state", { agentId: "a1" });
    expect(result.state).toBe("working");
  });
});

describe("lifecycle::add_reaction", () => {
  it("registers a reaction rule", async () => {
    const result = await call("lifecycle::add_reaction", {
      from: "working",
      to: "blocked",
      action: "send_to_agent",
      payload: { message: "You seem stuck" },
    });
    expect(result.registered).toBe(true);
    expect(result.id).toBeDefined();
  });
});

describe("lifecycle::list_reactions", () => {
  it("lists all reactions", async () => {
    getScope("lifecycle_reactions").set("r1", {
      id: "r1",
      from: "working",
      to: "blocked",
      action: "notify",
    });
    const result = await call("lifecycle::list_reactions", {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r1");
  });
});

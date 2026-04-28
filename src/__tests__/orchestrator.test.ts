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

function defaultMockImpl(fnId: string, data?: any): any {
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
  if (fnId === "llm::chat") {
    return {
      content: JSON.stringify({
        complexity: "medium",
        agents: ["planner", "coder"],
        reactions: [{ from: "working", to: "blocked", action: "notify", payload: {} }],
        summary: "Build feature",
      }),
    };
  }
  if (fnId === "task::decompose") {
    return { rootId: "decomposed-root-1", subtasks: [] };
  }
  if (fnId === "task::spawn_workers") {
    return { rootId: data.rootId, spawned: ["worker-1"] };
  }
  return null;
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  return defaultMockImpl(fnId, data);
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
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("@agentos/shared/config", () => ({
  ENGINE_URL: "ws://localhost:3111",
  OTEL_CONFIG: {},
  registerShutdown: vi.fn(),
}));
vi.mock("@agentos/shared/metrics", () => ({
  recordMetric: vi.fn(),
}));
vi.mock("@agentos/shared/errors", () => ({
  safeCall: async (fn: Function, fallback: any, _context?: any) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));
vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  stripCodeFences: (s: string) => s.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, ""),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
    return defaultMockImpl(fnId, data);
  });
});

beforeAll(async () => {
  await import("../orchestrator.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("orchestrator::plan", () => {
  it("creates a plan from description", async () => {
    const result = await call("orchestrator::plan", {
      description: "Build a REST API with auth",
    });
    expect(result.id).toBeDefined();
    expect(result.complexity).toBe("medium");
    expect(result.agents).toContain("planner");
    expect(result.status).toBe("planned");
  });

  it("requires description", async () => {
    await expect(
      call("orchestrator::plan", {}),
    ).rejects.toThrow("description is required");
  });

  it("stores plan in KV", async () => {
    const result = await call("orchestrator::plan", {
      description: "Build feature X",
    });
    const stored = getScope("orchestrator_plans").get(result.id);
    expect(stored).toBeDefined();
  });

  it("falls back to defaults on LLM failure", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "llm::chat") return { content: "not json" };
      if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") {
        getScope(data.scope).set(data.key, data.value);
        return { ok: true };
      }
      return null;
    });

    const result = await call("orchestrator::plan", {
      description: "Test fallback",
    });
    expect(result.complexity).toBe("medium");
    expect(result.agents).toContain("general");
  });
});

describe("orchestrator::execute", () => {
  it("decomposes tasks and spawns workers", async () => {
    const plan = {
      id: "plan-1",
      description: "Build feature",
      complexity: "medium",
      agents: ["coder"],
      reactions: [],
      createdAt: Date.now(),
      status: "planned",
    };
    seedKv("orchestrator_plans", "plan-1", plan);

    const result = await call("orchestrator::execute", { planId: "plan-1" });
    expect(result.planId).toBe("plan-1");
    expect(result.rootId).toBe("decomposed-root-1");
    expect(result.spawned.length).toBe(1);

    const updatedPlan = getScope("orchestrator_plans").get("plan-1") as any;
    expect(updatedPlan.status).toBe("executing");
  });

  it("requires planId", async () => {
    await expect(
      call("orchestrator::execute", {}),
    ).rejects.toThrow("planId is required");
  });

  it("throws for non-existent plan", async () => {
    await expect(
      call("orchestrator::execute", { planId: "missing" }),
    ).rejects.toThrow("Plan not found");
  });

  it("rejects executing an already executing plan", async () => {
    seedKv("orchestrator_plans", "plan-2", {
      id: "plan-2",
      status: "executing",
    });

    await expect(
      call("orchestrator::execute", { planId: "plan-2" }),
    ).rejects.toThrow("Cannot execute plan in status");
  });
});

describe("orchestrator::status", () => {
  it("lists all plans when no planId", async () => {
    seedKv("orchestrator_plans", "p1", {
      id: "p1",
      status: "planned",
      complexity: "low",
      createdAt: 1,
    });
    seedKv("orchestrator_plans", "p2", {
      id: "p2",
      status: "executing",
      complexity: "high",
      createdAt: 2,
    });

    const result = await call("orchestrator::status", {});
    expect(result.count).toBe(2);
    expect(result.plans.length).toBe(2);
  });

  it("returns plan with progress for specific planId", async () => {
    seedKv("orchestrator_plans", "p1", { id: "p1", status: "executing" });
    seedKv("orchestrator_runs", "p1", {
      planId: "p1",
      rootId: "r1",
      status: "running",
    });
    seedKv("tasks:r1", "t1", { id: "t1", status: "complete" });
    seedKv("tasks:r1", "t2", { id: "t2", status: "pending" });

    const result = await call("orchestrator::status", { planId: "p1" });
    expect(result.plan).toBeDefined();
    expect(result.progress.total).toBe(2);
    expect(result.progress.completed).toBe(1);
    expect(result.progress.percentage).toBe(50);
  });

  it("throws for non-existent plan", async () => {
    await expect(
      call("orchestrator::status", { planId: "missing" }),
    ).rejects.toThrow("Plan not found");
  });
});

describe("orchestrator::intervene", () => {
  it("cancels a plan", async () => {
    seedKv("orchestrator_plans", "p1", { id: "p1", status: "executing" });
    seedKv("orchestrator_runs", "p1", {
      planId: "p1",
      rootId: "r1",
      status: "running",
    });

    const result = await call("orchestrator::intervene", {
      planId: "p1",
      action: "cancel",
    });
    expect(result.newStatus).toBe("cancelled");
  });

  it("pauses a plan", async () => {
    seedKv("orchestrator_plans", "p1", { id: "p1", status: "executing" });

    const result = await call("orchestrator::intervene", {
      planId: "p1",
      action: "pause",
    });
    expect(result.newStatus).toBe("paused");
  });

  it("redirects a plan", async () => {
    seedKv("orchestrator_plans", "p1", {
      id: "p1",
      status: "executing",
      description: "old",
    });
    seedKv("orchestrator_runs", "p1", { planId: "p1", status: "running" });

    const result = await call("orchestrator::intervene", {
      planId: "p1",
      action: "redirect",
      redirectTo: "Build a different feature",
    });
    expect(result.newStatus).toBe("planned");

    const plan = getScope("orchestrator_plans").get("p1") as any;
    expect(plan.description).toBe("Build a different feature");
  });

  it("requires planId and action", async () => {
    await expect(
      call("orchestrator::intervene", {}),
    ).rejects.toThrow("planId and action are required");
  });

  it("rejects invalid action", async () => {
    seedKv("orchestrator_plans", "p1", { id: "p1", status: "executing" });
    await expect(
      call("orchestrator::intervene", {
        planId: "p1",
        action: "destroy",
      }),
    ).rejects.toThrow("Invalid action");
  });

  it("requires redirectTo for redirect action", async () => {
    seedKv("orchestrator_plans", "p1", { id: "p1", status: "executing" });
    await expect(
      call("orchestrator::intervene", {
        planId: "p1",
        action: "redirect",
      }),
    ).rejects.toThrow("redirectTo is required");
  });
});

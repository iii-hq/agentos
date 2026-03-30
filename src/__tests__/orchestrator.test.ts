import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

let llmResponse: any = {
  content: JSON.stringify({
    summary: "Build auth system",
    complexity: "medium",
    estimatedAgents: 2,
    parallelizable: true,
    decompositionPrompt: "Build a user authentication system with OAuth",
    reactions: [],
  }),
};

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
  if (fnId === "llm::complete") return llmResponse;
  if (fnId === "task::decompose")
    return {
      rootId: "root_123",
      tasks: [
        { id: "1", name: "Task 1", status: "pending" },
        { id: "2", name: "Task 2", status: "pending" },
      ],
    };
  if (fnId === "task::list")
    return [
      { id: "1", status: "completed" },
      { id: "2", status: "pending" },
    ];
  if (fnId === "task::spawn_workers") return { spawned: 2 };
  if (fnId === "lifecycle::add_reaction") return { id: "rxn1", registered: true };
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
  llmResponse = {
    content: JSON.stringify({
      summary: "Build auth system",
      complexity: "medium",
      estimatedAgents: 2,
      parallelizable: true,
      decompositionPrompt: "Build a user auth system with OAuth",
      reactions: [],
    }),
  };
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
  it("creates a plan from feature description", async () => {
    const result = await call("orchestrator::plan", {
      description: "Build a user authentication system",
    });
    expect(result.planId).toBeDefined();
    expect(result.plan.status).toBe("planning");
    expect(result.analysis.complexity).toBe("medium");
  });

  it("auto-executes when flag is set", async () => {
    const result = await call("orchestrator::plan", {
      description: "Quick fix",
      autoExecute: true,
    });
    expect(result.plan.status).toBe("approved");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "orchestrator::execute",
      expect.objectContaining({ planId: result.planId }),
    );
  });
});

describe("orchestrator::execute", () => {
  it("executes a plan: decomposes, spawns workers", async () => {
    const { planId } = await call("orchestrator::plan", {
      description: "Build feature",
    });
    getScope("orchestrator_plans").get(planId)!;

    const plan: any = getScope("orchestrator_plans").get(planId);
    plan.status = "approved";
    getScope("orchestrator_plans").set(planId, plan);

    const result = await call("orchestrator::execute", { planId });
    expect(result.executed).toBe(true);
    expect(result.rootTaskId).toBe("root_123");
    expect(result.workersSpawned).toBe(2);
  });

  it("fails for non-existent plan", async () => {
    const result = await call("orchestrator::execute", { planId: "fake" });
    expect(result.executed).toBe(false);
  });
});

describe("orchestrator::status", () => {
  it("returns status for a specific plan", async () => {
    const { planId } = await call("orchestrator::plan", {
      description: "Test",
    });
    const plan: any = getScope("orchestrator_plans").get(planId);
    plan.rootTaskId = "root_123";
    getScope("orchestrator_plans").set(planId, plan);

    const result = await call("orchestrator::status", { planId });
    expect(result.found).toBe(true);
    expect(result.progress.total).toBe(2);
    expect(result.progress.completed).toBe(1);
    expect(result.progress.percentage).toBe(50);
  });

  it("lists all plans when no planId given", async () => {
    await call("orchestrator::plan", { description: "Plan A" });
    await call("orchestrator::plan", { description: "Plan B" });
    const result = await call("orchestrator::status", {});
    expect(result.plans.length).toBe(2);
  });
});

describe("orchestrator::intervene", () => {
  it("cancels an executing plan", async () => {
    const { planId } = await call("orchestrator::plan", {
      description: "To cancel",
    });
    const plan: any = getScope("orchestrator_plans").get(planId);
    plan.status = "executing";
    getScope("orchestrator_plans").set(planId, plan);

    const result = await call("orchestrator::intervene", {
      planId,
      action: "cancel",
    });
    expect(result.success).toBe(true);
    const updated: any = getScope("orchestrator_plans").get(planId);
    expect(updated.status).toBe("failed");
  });

  it("pauses an executing plan", async () => {
    const { planId } = await call("orchestrator::plan", {
      description: "To pause",
    });
    const plan: any = getScope("orchestrator_plans").get(planId);
    plan.status = "executing";
    getScope("orchestrator_plans").set(planId, plan);

    const result = await call("orchestrator::intervene", {
      planId,
      action: "pause",
    });
    expect(result.success).toBe(true);
    const updated: any = getScope("orchestrator_plans").get(planId);
    expect(updated.status).toBe("approved");
  });

  it("redirects with a message", async () => {
    const { planId } = await call("orchestrator::plan", {
      description: "To redirect",
    });
    const result = await call("orchestrator::intervene", {
      planId,
      action: "redirect",
      message: "Focus on security first",
    });
    expect(result.success).toBe(true);
    const updated: any = getScope("orchestrator_plans").get(planId);
    expect(updated.analysis.redirectionNote).toBe("Focus on security first");
  });
});

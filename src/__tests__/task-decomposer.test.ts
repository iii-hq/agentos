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

function defaultMockTrigger(fnId: string, data?: any): any {
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
    const parentId = data?.messages?.[0]?.content?.match(/Parent ID is "([^"]+)"/)?.[1] || "root";
    return {
      content: JSON.stringify({
        subtasks: [
          { id: `${parentId}.1`, description: "First subtask" },
          { id: `${parentId}.2`, description: "Second subtask" },
        ],
      }),
    };
  }
  return null;
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  return defaultMockTrigger(fnId, data);
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
vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  stripCodeFences: (s: string) => s.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, ""),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
    return defaultMockTrigger(fnId, data);
  });
});

beforeAll(async () => {
  await import("../task-decomposer.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("task::decompose", () => {
  it("creates subtasks from LLM response", async () => {
    const result = await call("task::decompose", {
      description: "Build a REST API with auth",
    });
    expect(result.rootId).toBeDefined();
    expect(result.subtasks.length).toBe(2);
    expect(result.subtasks[0].description).toBe("First subtask");
  });

  it("uses hierarchical IDs", async () => {
    const result = await call("task::decompose", {
      description: "Complex feature",
    });
    const ids = result.subtasks.map((s: any) => s.id);
    expect(ids[0]).toMatch(/\.1$/);
    expect(ids[1]).toMatch(/\.2$/);
  });

  it("returns fallback when max depth reached", async () => {
    const result = await call("task::decompose", {
      description: "Deep task",
      depth: 3,
    });
    expect(result.decomposed).toBe(false);
    expect(result.reason).toContain("Max depth");
  });

  it("handles LLM failure gracefully", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "llm::chat") return { content: "not json" };
      return defaultMockTrigger(fnId, data);
    });

    const result = await call("task::decompose", {
      description: "Test LLM failure",
    });
    expect(result.decomposed).toBe(false);
    expect(result.reason).toContain("LLM parse failure");
  });

  it("requires description", async () => {
    await expect(
      call("task::decompose", {}),
    ).rejects.toThrow("description is required");
  });
});

describe("task::update_status", () => {
  it("updates task status", async () => {
    const rootId = "root-1";
    seedKv(`tasks:${rootId}`, "t1", {
      id: "t1",
      rootId,
      parentId: null,
      status: "pending",
      children: [],
      updatedAt: 0,
    });

    const result = await call("task::update_status", {
      rootId,
      taskId: "t1",
      status: "in_progress",
    });
    expect(result.status).toBe("in_progress");
  });

  it("rejects invalid status", async () => {
    seedKv("tasks:root-1", "t1", {
      id: "t1",
      rootId: "root-1",
      status: "pending",
      children: [],
    });

    await expect(
      call("task::update_status", {
        rootId: "root-1",
        taskId: "t1",
        status: "invalid",
      }),
    ).rejects.toThrow("Invalid status");
  });

  it("throws when task not found", async () => {
    await expect(
      call("task::update_status", {
        rootId: "root-1",
        taskId: "missing",
        status: "complete",
      }),
    ).rejects.toThrow("Task not found");
  });
});

describe("task::list", () => {
  it("lists all tasks for a root", async () => {
    seedKv("tasks:root-1", "t1", { id: "t1", status: "pending" });
    seedKv("tasks:root-1", "t2", { id: "t2", status: "complete" });

    const result = await call("task::list", { rootId: "root-1" });
    expect(result.count).toBe(2);
    expect(result.rootId).toBe("root-1");
  });

  it("filters by status", async () => {
    seedKv("tasks:root-1", "t1", { id: "t1", status: "pending" });
    seedKv("tasks:root-1", "t2", { id: "t2", status: "complete" });

    const result = await call("task::list", {
      rootId: "root-1",
      status: "complete",
    });
    expect(result.count).toBe(1);
    expect(result.tasks[0].id).toBe("t2");
  });

  it("requires rootId", async () => {
    await expect(call("task::list", {})).rejects.toThrow("rootId is required");
  });
});

describe("task::spawn_workers", () => {
  it("spawns workers for pending leaf tasks", async () => {
    seedKv("tasks:root-1", "t1", {
      id: "t1",
      status: "pending",
      children: [],
      description: "leaf task",
    });
    seedKv("tasks:root-1", "t2", {
      id: "t2",
      status: "complete",
      children: [],
      description: "done task",
    });

    const result = await call("task::spawn_workers", { rootId: "root-1" });
    expect(result.spawned).toBe(1);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "tool::agent_spawn",
      expect.objectContaining({
        template: "task-worker",
        message: "leaf task",
      }),
    );
  });

  it("skips tasks with children", async () => {
    seedKv("tasks:root-1", "parent", {
      id: "parent",
      status: "pending",
      children: ["child-1"],
      description: "parent task",
    });

    const result = await call("task::spawn_workers", { rootId: "root-1" });
    expect(result.spawned).toBe(0);
  });

  it("requires rootId", async () => {
    await expect(
      call("task::spawn_workers", {}),
    ).rejects.toThrow("rootId is required");
  });
});

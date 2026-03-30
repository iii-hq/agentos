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
  content: JSON.stringify([
    { name: "Setup database", description: "Create schema", dependencies: [] },
    { name: "Build API", description: "Create endpoints", dependencies: ["Setup database"] },
  ]),
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
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") current[op.path] = op.value;
      else if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
      else if (op.type === "merge")
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "llm::complete") return llmResponse;
  if (fnId === "task::update_status") {
    const handler = handlers["task::update_status"];
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

function defaultMockTrigger(fnId: string, data?: any): Promise<any> {
  if (fnId === "state::get") return Promise.resolve(getScope(data.scope).get(data.key) ?? null);
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return Promise.resolve({ ok: true });
  }
  if (fnId === "state::list") {
    return Promise.resolve(
      [...getScope(data.scope).entries()].map(([key, value]) => ({
        key,
        value,
      })),
    );
  }
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") current[op.path] = op.value;
      else if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
      else if (op.type === "merge")
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
    }
    scope.set(data.key, current);
    return Promise.resolve(current);
  }
  if (fnId === "llm::complete") return Promise.resolve(llmResponse);
  if (fnId === "task::update_status") {
    const handler = handlers["task::update_status"];
    if (handler) return handler(data);
  }
  return Promise.resolve(null);
}

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  mockTrigger.mockImplementation(defaultMockTrigger);
  llmResponse = {
    content: JSON.stringify([
      { name: "Setup database", description: "Create schema", dependencies: [] },
      { name: "Build API", description: "Create endpoints", dependencies: ["Setup database"] },
    ]),
  };
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
  it("decomposes a task into subtasks via LLM", async () => {
    const result = await call("task::decompose", {
      description: "Build a user authentication system",
    });
    expect(result.rootId).toBeDefined();
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].name).toBe("Setup database");
    expect(result.tasks[1].id).toBe("2");
  });

  it("assigns hierarchical IDs with parent prefix", async () => {
    const result = await call("task::decompose", {
      description: "Child task",
      parentId: "1",
    });
    expect(result.tasks[0].id).toBe("1.1");
    expect(result.tasks[1].id).toBe("1.2");
  });

  it("creates atomic task at max depth", async () => {
    const result = await call("task::decompose", {
      description: "Leaf task",
      depth: 3,
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe("pending");
  });

  it("falls back to single task when LLM fails", async () => {
    const original = mockTrigger.getMockImplementation();
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "llm::complete") throw new Error("LLM down");
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
      return null;
    });

    const result = await call("task::decompose", {
      description: "Should fallback",
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].description).toBe("Should fallback");

    if (original) mockTrigger.mockImplementation(original);
  });
});

describe("task::update_status", () => {
  it("updates task status", async () => {
    getScope("tasks:root1").set("1", {
      id: "1",
      parentId: null,
      status: "pending",
      updatedAt: 0,
    });
    const result = await call("task::update_status", {
      rootId: "root1",
      taskId: "1",
      status: "completed",
    });
    expect(result.updated).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("returns error for missing task", async () => {
    const result = await call("task::update_status", {
      rootId: "root1",
      taskId: "missing",
      status: "completed",
    });
    expect(result.updated).toBe(false);
  });
});

describe("task::list", () => {
  it("lists all tasks for a root", async () => {
    getScope("tasks:root1").set("1", { id: "1", status: "pending" });
    getScope("tasks:root1").set("2", { id: "2", status: "completed" });
    const result = await call("task::list", { rootId: "root1" });
    expect(result).toHaveLength(2);
  });

  it("filters by status", async () => {
    getScope("tasks:root1").set("1", { id: "1", status: "pending" });
    getScope("tasks:root1").set("2", { id: "2", status: "completed" });
    const result = await call("task::list", {
      rootId: "root1",
      status: "completed",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });
});

describe("task::spawn_workers", () => {
  it("spawns agents for leaf tasks", async () => {
    getScope("tasks:root1").set("1", {
      id: "1",
      parentId: null,
      name: "Build API",
      description: "Create endpoints",
      status: "pending",
    });
    const result = await call("task::spawn_workers", { rootId: "root1" });
    expect(result.spawned).toBe(1);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "tool::agent_spawn",
      expect.objectContaining({ template: "task-worker" }),
    );
  });

  it("skips non-pending tasks", async () => {
    getScope("tasks:root1").set("1", {
      id: "1",
      status: "completed",
    });
    const result = await call("task::spawn_workers", { rootId: "root1" });
    expect(result.spawned).toBe(0);
  });
});

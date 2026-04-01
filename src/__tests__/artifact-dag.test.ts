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
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
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
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  sanitizeId: (id: string) => {
    if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id))
      throw new Error(`Invalid ID: ${id}`);
    return id;
  },
}));


vi.mock("../shared/metrics.js", () => ({
  createRecordMetric: () => vi.fn(),
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
  await import("../artifact-dag.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("artifact::push", () => {
  it("pushes a root artifact with no parents", async () => {
    const result = await call(
      "artifact::push",
      authReq({ agentId: "agent-1", content: { code: "x+1" }, label: "v1" }),
    );
    expect(result.nodeId).toBeDefined();
    expect(result.contentHash).toBeDefined();
    expect(result.parentIds).toEqual([]);

    const stored: any = getScope("artifacts").get(result.nodeId);
    expect(stored.agentId).toBe("agent-1");
    expect(stored.label).toBe("v1");
    expect(stored.content).toEqual({ code: "x+1" });
  });

  it("pushes artifact with parent references", async () => {
    seedKv("artifacts", "parent-1", {
      id: "parent-1",
      agentId: "agent-1",
      parentIds: [],
      content: "base",
      label: "root",
    });

    const result = await call(
      "artifact::push",
      authReq({
        agentId: "agent-2",
        content: "improved",
        label: "child",
        parentIds: ["parent-1"],
      }),
    );
    expect(result.parentIds).toEqual(["parent-1"]);
  });

  it("rejects missing parent", async () => {
    await expect(
      call(
        "artifact::push",
        authReq({
          agentId: "agent-1",
          content: "test",
          label: "test",
          parentIds: ["nonexistent"],
        }),
      ),
    ).rejects.toThrow("Parent artifact nonexistent not found");
  });

  it("rejects missing required fields", async () => {
    await expect(
      call("artifact::push", authReq({ agentId: "agent-1" })),
    ).rejects.toThrow("agentId, content, and label are required");
  });

  it("publishes event for swarm artifacts", async () => {
    await call(
      "artifact::push",
      authReq({
        agentId: "agent-1",
        content: "data",
        label: "shared",
        swarmId: "swarm-1",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({
        topic: "artifact:swarm-1",
      }),
    );
  });
});

describe("artifact::fetch", () => {
  it("fetches existing artifact", async () => {
    seedKv("artifacts", "node-1", {
      id: "node-1",
      agentId: "agent-1",
      content: "hello",
      label: "test",
    });

    const result = await call(
      "artifact::fetch",
      authReq({ nodeId: "node-1" }),
    );
    expect(result.id).toBe("node-1");
    expect(result.content).toBe("hello");
  });

  it("rejects missing nodeId", async () => {
    await expect(
      call("artifact::fetch", authReq({})),
    ).rejects.toThrow("nodeId is required");
  });

  it("rejects nonexistent artifact", async () => {
    await expect(
      call("artifact::fetch", authReq({ nodeId: "nope" })),
    ).rejects.toThrow("Artifact not found");
  });
});

describe("artifact::children", () => {
  it("returns child nodes", async () => {
    seedKv("artifacts", "root-1", {
      id: "root-1",
      agentId: "agent-1",
      parentIds: [],
      content: "root",
    });
    seedKv("artifacts", "child-1", {
      id: "child-1",
      agentId: "agent-2",
      parentIds: ["root-1"],
      content: "child",
    });
    seedKv("artifacts", "child-2", {
      id: "child-2",
      agentId: "agent-3",
      parentIds: ["root-1"],
      content: "child2",
    });
    seedKv("artifacts", "unrelated", {
      id: "unrelated",
      agentId: "agent-4",
      parentIds: [],
      content: "other",
    });

    const result = await call(
      "artifact::children",
      authReq({ nodeId: "root-1" }),
    );
    expect(result).toHaveLength(2);
  });

  it("returns empty for leaf node", async () => {
    seedKv("artifacts", "leaf-1", {
      id: "leaf-1",
      agentId: "agent-1",
      parentIds: [],
      content: "leaf",
    });

    const result = await call(
      "artifact::children",
      authReq({ nodeId: "leaf-1" }),
    );
    expect(result).toHaveLength(0);
  });
});

describe("artifact::leaves", () => {
  it("finds frontier nodes", async () => {
    seedKv("artifacts", "a1", {
      id: "a1",
      agentId: "agent-1",
      parentIds: [],
      content: "root",
    });
    seedKv("artifacts", "a2", {
      id: "a2",
      agentId: "agent-1",
      parentIds: ["a1"],
      content: "mid",
    });
    seedKv("artifacts", "a3", {
      id: "a3",
      agentId: "agent-1",
      parentIds: ["a2"],
      content: "leaf",
    });
    seedKv("artifacts", "a4", {
      id: "a4",
      agentId: "agent-2",
      parentIds: ["a1"],
      content: "branch",
    });

    const result = await call("artifact::leaves", authReq({}));
    expect(result).toHaveLength(2);
    const ids = result.map((n: any) => n.id);
    expect(ids).toContain("a3");
    expect(ids).toContain("a4");
  });

  it("filters by swarmId", async () => {
    seedKv("artifacts", "s1", {
      id: "s1",
      agentId: "agent-1",
      swarmId: "swarm-x",
      parentIds: [],
      content: "a",
    });
    seedKv("artifacts", "s2", {
      id: "s2",
      agentId: "agent-1",
      swarmId: "swarm-y",
      parentIds: [],
      content: "b",
    });

    const result = await call(
      "artifact::leaves",
      authReq({ swarmId: "swarm-x" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });
});

describe("artifact::diff", () => {
  it("compares two artifacts", async () => {
    seedKv("artifacts", "d1", {
      id: "d1",
      agentId: "agent-1",
      content: "hello world",
      contentHash: "abc123",
      createdAt: 1000,
    });
    seedKv("artifacts", "d2", {
      id: "d2",
      agentId: "agent-2",
      content: "goodbye world",
      contentHash: "def456",
      createdAt: 2000,
    });

    const result = await call(
      "artifact::diff",
      authReq({ nodeIdA: "d1", nodeIdB: "d2" }),
    );
    expect(result.contentMatch).toBe(false);
    expect(result.agentA).toBe("agent-1");
    expect(result.agentB).toBe("agent-2");
    expect(result.sizeA).toBeGreaterThan(0);
    expect(result.sizeB).toBeGreaterThan(0);
  });

  it("detects matching content", async () => {
    seedKv("artifacts", "m1", {
      id: "m1",
      agentId: "agent-1",
      content: "same",
      contentHash: "aaa",
      createdAt: 1000,
    });
    seedKv("artifacts", "m2", {
      id: "m2",
      agentId: "agent-2",
      content: "same",
      contentHash: "aaa",
      createdAt: 2000,
    });

    const result = await call(
      "artifact::diff",
      authReq({ nodeIdA: "m1", nodeIdB: "m2" }),
    );
    expect(result.contentMatch).toBe(true);
  });

  it("rejects missing nodeIdB", async () => {
    await expect(
      call("artifact::diff", authReq({ nodeIdA: "x" })),
    ).rejects.toThrow("nodeIdA and nodeIdB are required");
  });
});

describe("artifact::history", () => {
  it("returns artifacts sorted by recency", async () => {
    seedKv("artifacts", "h1", {
      id: "h1",
      agentId: "agent-1",
      label: "first",
      contentHash: "a",
      parentIds: [],
      createdAt: 1000,
    });
    seedKv("artifacts", "h2", {
      id: "h2",
      agentId: "agent-1",
      label: "second",
      contentHash: "b",
      parentIds: [],
      createdAt: 2000,
    });
    seedKv("artifacts", "h3", {
      id: "h3",
      agentId: "agent-2",
      label: "other",
      contentHash: "c",
      parentIds: [],
      createdAt: 3000,
    });

    const result = await call(
      "artifact::history",
      authReq({ agentId: "agent-1" }),
    );
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("second");
    expect(result[1].label).toBe("first");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      seedKv("artifacts", `lim-${i}`, {
        id: `lim-${i}`,
        agentId: "agent-1",
        label: `item-${i}`,
        contentHash: `h${i}`,
        parentIds: [],
        createdAt: i * 1000,
      });
    }

    const result = await call(
      "artifact::history",
      authReq({ agentId: "agent-1", limit: 2 }),
    );
    expect(result).toHaveLength(2);
  });
});

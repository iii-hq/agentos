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
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") current[op.path] = op.value;
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../knowledge-graph.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("kg::add_temporal", () => {
  it("stores entity and latest pointer", async () => {
    const result = await call("kg::add_temporal", {
      entity: "nodeA",
      type: "concept",
      properties: { lang: "ts" },
      relations: [],
      agentId: "agent-1",
    });
    expect(result.stored).toBe(true);
    expect(result.entity).toBe("nodeA");
    expect(result.version).toBe(1);

    const latest = getScope("kg_temporal:agent-1").get("nodeA:latest") as any;
    expect(latest.version).toBe(1);
    expect(latest.key).toBe("nodeA:1");

    const entry = getScope("kg_temporal:agent-1").get("nodeA:1") as any;
    expect(entry.entity).toBe("nodeA");
    expect(entry.type).toBe("concept");
    expect(entry.properties.lang).toBe("ts");
  });

  it("increments version", async () => {
    await call("kg::add_temporal", {
      entity: "nodeB",
      type: "concept",
      properties: { v: 1 },
      relations: [],
      agentId: "agent-1",
    });
    const r2 = await call("kg::add_temporal", {
      entity: "nodeB",
      type: "concept",
      properties: { v: 2 },
      relations: [],
      agentId: "agent-1",
    });
    expect(r2.version).toBe(2);

    const latest = getScope("kg_temporal:agent-1").get("nodeB:latest") as any;
    expect(latest.version).toBe(2);
    expect(latest.key).toBe("nodeB:2");
  });

  it("returns error for missing entity", async () => {
    const result = await call("kg::add_temporal", {
      entity: "",
      type: "concept",
      properties: {},
      relations: [],
      agentId: "agent-1",
    });
    expect(result.error).toBe("entity and agentId required");
  });

  it("returns error for missing agentId", async () => {
    const result = await call("kg::add_temporal", {
      entity: "nodeC",
      type: "concept",
      properties: {},
      relations: [],
      agentId: "",
    });
    expect(result.error).toBe("entity and agentId required");
  });
});

describe("kg::timeline", () => {
  it("returns versions sorted by createdAt", async () => {
    const scope = "kg_temporal:agent-1";
    seedKv(scope, "nodeX:1", {
      entity: "nodeX",
      type: "concept",
      properties: {},
      relations: [],
      validFrom: 1000,
      validUntil: null,
      createdAt: 3000,
      version: 1,
      agentId: "agent-1",
    });
    seedKv(scope, "nodeX:2", {
      entity: "nodeX",
      type: "concept",
      properties: {},
      relations: [],
      validFrom: 2000,
      validUntil: null,
      createdAt: 1000,
      version: 2,
      agentId: "agent-1",
    });
    seedKv(scope, "nodeX:3", {
      entity: "nodeX",
      type: "concept",
      properties: {},
      relations: [],
      validFrom: 3000,
      validUntil: null,
      createdAt: 2000,
      version: 3,
      agentId: "agent-1",
    });
    seedKv(scope, "nodeX:latest", { version: 3, key: "nodeX:3" });

    const result = await call("kg::timeline", {
      entity: "nodeX",
      agentId: "agent-1",
    });
    expect(result).toHaveLength(3);
    expect(result[0].createdAt).toBe(1000);
    expect(result[1].createdAt).toBe(2000);
    expect(result[2].createdAt).toBe(3000);
  });
});

describe("kg::diff", () => {
  it("detects added entities", async () => {
    const scope = "kg_temporal:agent-1";
    seedKv(scope, "nodeD:1", {
      entity: "nodeD",
      type: "concept",
      properties: { a: 1 },
      relations: [],
      validFrom: 1000,
      validUntil: null,
      createdAt: 1000,
      version: 1,
      agentId: "agent-1",
    });
    seedKv(scope, "nodeD:2", {
      entity: "nodeD",
      type: "concept",
      properties: { a: 2 },
      relations: [],
      validFrom: 2000,
      validUntil: null,
      createdAt: 5000,
      version: 2,
      agentId: "agent-1",
    });
    seedKv(scope, "nodeD:latest", { version: 2, key: "nodeD:2" });

    const result = await call("kg::diff", {
      entity: "nodeD",
      agentId: "agent-1",
      timestamp1: 2000,
      timestamp2: 6000,
    });
    expect(result.added).toHaveLength(1);
    expect(result.added[0].version).toBe(2);
  });
});

describe("kg::stats", () => {
  it("counts entities and relations", async () => {
    const scope = "kg_temporal:agent-1";
    seedKv(scope, "e1:1", {
      entity: "e1",
      type: "concept",
      properties: {},
      relations: [{ target: "e2", type: "link" }],
      validFrom: 1000,
      validUntil: null,
      createdAt: 1000,
      version: 1,
      agentId: "agent-1",
    });
    seedKv(scope, "e2:1", {
      entity: "e2",
      type: "concept",
      properties: {},
      relations: [],
      validFrom: 1000,
      validUntil: null,
      createdAt: 1000,
      version: 1,
      agentId: "agent-1",
    });
    seedKv(scope, "e1:latest", { version: 1, key: "e1:1" });
    seedKv(scope, "e2:latest", { version: 1, key: "e2:1" });

    const result = await call("kg::stats", { agentId: "agent-1" });
    expect(result.totalEntities).toBe(2);
    expect(result.totalRelations).toBe(1);
    expect(result.connectedComponents).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 for empty graph", async () => {
    const result = await call("kg::stats", { agentId: "empty-agent" });
    expect(result.totalEntities).toBe(0);
    expect(result.totalRelations).toBe(0);
    expect(result.avgDegree).toBe(0);
    expect(result.connectedComponents).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";

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
  if (fnId === "swarm::collect") {
    const handler = handlers["swarm::collect"];
    if (handler) return handler(data);
    return { totalMessages: 0, agents: {} };
  }
  if (fnId === "publish") return null;
  if (fnId === "security::audit") return null;
  if (fnId === "memory::store") return null;
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

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  sanitizeId: (id: string) => {
    if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id)) {
      throw Object.assign(new Error(`Invalid ID format: ${id}`), {
        statusCode: 400,
      });
    }
    return id;
  },
}));

const originalEnv = process.env.AGENTOS_API_KEY;

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  process.env.AGENTOS_API_KEY = "test-key";
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env.AGENTOS_API_KEY = originalEnv;
  } else {
    delete process.env.AGENTOS_API_KEY;
  }
});

beforeAll(async () => {
  await import("../swarm.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test-key" }, body, ...body };
}

describe("swarm::create", () => {
  it("creates swarm with UUID", async () => {
    const result = await call("swarm::create", authReq({
      goal: "find bugs",
      agentIds: ["a1", "a2"],
    }));
    expect(result.swarmId).toBeDefined();
    expect(result.swarmId.length).toBeGreaterThan(0);
    expect(result.agents).toEqual(["a1", "a2"]);
    expect(result.createdAt).toBeDefined();

    const stored = getScope("swarms").get(result.swarmId) as any;
    expect(stored.goal).toBe("find bugs");
    expect(stored.status).toBe("active");
  });

  it("rejects missing goal", async () => {
    await expect(
      call("swarm::create", authReq({ agentIds: ["a1"] })),
    ).rejects.toThrow("goal and agentIds are required");
  });

  it("rejects missing agentIds", async () => {
    await expect(
      call("swarm::create", authReq({ goal: "test" })),
    ).rejects.toThrow("goal and agentIds are required");
  });

  it("rejects too many agents", async () => {
    const agentIds = Array.from({ length: 21 }, (_, i) => `agent-${i}`);
    await expect(
      call("swarm::create", authReq({ goal: "test", agentIds })),
    ).rejects.toThrow("Maximum 20 agents per swarm");
  });
});

describe("swarm::broadcast", () => {
  const swarmId = "swarm-abc";

  beforeEach(() => {
    seedKv("swarms", swarmId, {
      id: swarmId,
      goal: "test goal",
      agentIds: ["a1", "a2", "a3"],
      maxDurationMs: 600000,
      consensusThreshold: 0.66,
      createdAt: Date.now(),
      status: "active",
    });
  });

  it("stores message in swarm", async () => {
    const result = await call("swarm::broadcast", {
      swarmId,
      agentId: "a1",
      message: "found a bug",
      type: "observation",
    });
    expect(result.messageId).toBeDefined();
    expect(result.swarmId).toBe(swarmId);

    const messages = [...getScope(`swarm_messages:${swarmId}`).values()] as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("found a bug");
    expect(messages[0].type).toBe("observation");
  });

  it("rejects non-member agent", async () => {
    await expect(
      call("swarm::broadcast", {
        swarmId,
        agentId: "outsider",
        message: "hello",
        type: "observation",
      }),
    ).rejects.toThrow("is not a member of swarm");
  });

  it("rejects inactive swarm", async () => {
    seedKv("swarms", "dissolved-swarm", {
      id: "dissolved-swarm",
      goal: "done",
      agentIds: ["a1"],
      maxDurationMs: 600000,
      consensusThreshold: 0.66,
      createdAt: Date.now(),
      status: "dissolved",
    });
    await expect(
      call("swarm::broadcast", {
        swarmId: "dissolved-swarm",
        agentId: "a1",
        message: "test",
        type: "observation",
      }),
    ).rejects.toThrow("not found or not active");
  });
});

describe("swarm::collect", () => {
  it("returns grouped messages", async () => {
    const swarmId = "swarm-collect";
    seedKv(`swarm_messages:${swarmId}`, "msg-1", {
      id: "msg-1",
      swarmId,
      agentId: "a1",
      message: "observation from a1",
      type: "observation",
      timestamp: 1000,
    });
    seedKv(`swarm_messages:${swarmId}`, "msg-2", {
      id: "msg-2",
      swarmId,
      agentId: "a2",
      message: "proposal from a2",
      type: "proposal",
      timestamp: 2000,
    });
    seedKv(`swarm_messages:${swarmId}`, "msg-3", {
      id: "msg-3",
      swarmId,
      agentId: "a1",
      message: "vote from a1",
      type: "vote",
      vote: "for",
      timestamp: 3000,
    });

    const result = await call("swarm::collect", { swarmId });
    expect(result.totalMessages).toBe(3);
    expect(result.agents["a1"]).toHaveLength(2);
    expect(result.agents["a2"]).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.votes).toHaveLength(1);
  });
});

describe("swarm::consensus", () => {
  const swarmId = "swarm-vote";

  beforeEach(() => {
    seedKv("swarms", swarmId, {
      id: swarmId,
      goal: "decide",
      agentIds: ["a1", "a2", "a3"],
      maxDurationMs: 600000,
      consensusThreshold: 0.66,
      createdAt: Date.now(),
      status: "active",
    });
  });

  it("detects consensus reached", async () => {
    seedKv(`swarm_messages:${swarmId}`, "v1", {
      id: "v1",
      swarmId,
      agentId: "a1",
      message: "I vote for deploy-now",
      type: "vote",
      vote: "for",
      timestamp: 1000,
    });
    seedKv(`swarm_messages:${swarmId}`, "v2", {
      id: "v2",
      swarmId,
      agentId: "a2",
      message: "I vote for deploy-now",
      type: "vote",
      vote: "for",
      timestamp: 2000,
    });
    seedKv(`swarm_messages:${swarmId}`, "v3", {
      id: "v3",
      swarmId,
      agentId: "a3",
      message: "I vote against deploy-now",
      type: "vote",
      vote: "against",
      timestamp: 3000,
    });

    const result = await call("swarm::consensus", {
      swarmId,
      proposal: "deploy-now",
    });
    expect(result.hasConsensus).toBe(true);
    expect(result.votesFor).toBe(2);
    expect(result.votesAgainst).toBe(1);
  });

  it("detects no consensus", async () => {
    seedKv(`swarm_messages:${swarmId}`, "v1", {
      id: "v1",
      swarmId,
      agentId: "a1",
      message: "I vote for rollback",
      type: "vote",
      vote: "for",
      timestamp: 1000,
    });
    seedKv(`swarm_messages:${swarmId}`, "v2", {
      id: "v2",
      swarmId,
      agentId: "a2",
      message: "I vote against rollback",
      type: "vote",
      vote: "against",
      timestamp: 2000,
    });
    seedKv(`swarm_messages:${swarmId}`, "v3", {
      id: "v3",
      swarmId,
      agentId: "a3",
      message: "I vote against rollback",
      type: "vote",
      vote: "against",
      timestamp: 3000,
    });

    const result = await call("swarm::consensus", {
      swarmId,
      proposal: "rollback",
    });
    expect(result.hasConsensus).toBe(false);
    expect(result.votesFor).toBe(1);
    expect(result.votesAgainst).toBe(2);
  });
});

describe("swarm::dissolve", () => {
  it("marks swarm as dissolved", async () => {
    const swarmId = "swarm-dissolve";
    seedKv("swarms", swarmId, {
      id: swarmId,
      goal: "done",
      agentIds: ["a1"],
      maxDurationMs: 600000,
      consensusThreshold: 0.66,
      createdAt: Date.now(),
      status: "active",
    });

    const result = await call("swarm::dissolve", authReq({ swarmId }));
    expect(result.dissolved).toBe(true);
    expect(result.swarmId).toBe(swarmId);

    const swarm = getScope("swarms").get(swarmId) as any;
    expect(swarm.status).toBe("dissolved");
    expect(swarm.dissolvedAt).toBeDefined();
  });
});

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
  if (fnId === "agent::list_tools") {
    return [{ function_id: "tool::test" }];
  }
  if (fnId === "a2a::generate_card") {
    const handler = handlers["a2a::generate_card"];
    if (handler) return handler(data);
    return null;
  }
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
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../a2a-cards.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("a2a::generate_card", () => {
  it("creates card from agent config", async () => {
    seedKv("agents", "agent-1", {
      name: "Test Agent",
      description: "A test agent",
    });
    seedKv("skills", "s1", {
      id: "s1",
      name: "Recall",
      description: "Memory recall",
    });

    const result = await call("a2a::generate_card", { agentId: "agent-1" });
    expect(result.name).toBe("Test Agent");
    expect(result.description).toBe("A test agent");
    expect(result.capabilities.tools).toContain("tool::test");
    expect(result.capabilities.streaming).toBe(true);
    expect(result.authentication.schemes).toContain("bearer");
    expect(result.skills.length).toBe(1);
    expect(result.skills[0].id).toBe("s1");
  });

  it("throws on missing agent", async () => {
    await expect(
      call("a2a::generate_card", { agentId: "nonexistent" }),
    ).rejects.toThrow("Agent not found: nonexistent");
  });

  it("stores generated card in a2a_cards scope", async () => {
    seedKv("agents", "agent-2", { name: "Agent Two" });

    await call("a2a::generate_card", { agentId: "agent-2" });
    const stored = getScope("a2a_cards").get("agent-2") as any;
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Agent Two");
  });

  it("uses agentId as fallback name", async () => {
    seedKv("agents", "agent-3", {});

    const result = await call("a2a::generate_card", { agentId: "agent-3" });
    expect(result.name).toBe("agent-3");
    expect(result.description).toBe("Agent agent-3");
  });

  it("includes default input and output modes", async () => {
    seedKv("agents", "agent-4", { name: "Agent Four" });

    const result = await call("a2a::generate_card", { agentId: "agent-4" });
    expect(result.defaultInputModes).toEqual(["text"]);
    expect(result.defaultOutputModes).toEqual(["text"]);
  });
});

describe("a2a::list_cards", () => {
  it("returns cards for all agents", async () => {
    seedKv("agents", "agent-1", {
      id: "agent-1",
      name: "Agent One",
    });
    seedKv("agents", "agent-2", {
      id: "agent-2",
      name: "Agent Two",
    });

    const result = await call("a2a::list_cards", authReq({}));
    expect(result.length).toBe(2);
  });

  it("skips agents without id in value", async () => {
    seedKv("agents", "agent-1", { id: "agent-1", name: "Agent One" });
    seedKv("agents", "agent-bad", { name: "No ID" });

    const result = await call("a2a::list_cards", authReq({}));
    expect(result.length).toBe(1);
  });

  it("works without auth headers", async () => {
    seedKv("agents", "agent-1", { id: "agent-1", name: "Agent One" });

    const result = await call("a2a::list_cards", {});
    expect(result.length).toBe(1);
  });
});

describe("a2a::well_known", () => {
  it("returns cached card if exists", async () => {
    const cachedCard = {
      name: "cached-agent",
      description: "Cached",
      url: "http://localhost:3111/api/a2a/agents/orchestrator",
      capabilities: { tools: ["tool::cached"], streaming: true, pushNotifications: false },
      skills: [],
      authentication: { schemes: ["bearer"] },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };
    seedKv("a2a_cards", "orchestrator", cachedCard);

    const result = await call("a2a::well_known", {});
    expect(result.name).toBe("cached-agent");
    expect(result.capabilities.tools).toContain("tool::cached");
  });

  it("returns default card when no cache", async () => {
    const result = await call("a2a::well_known", {});
    expect(result.name).toBe("agentos");
    expect(result.description).toContain("AI agent operating system");
    expect(result.capabilities.streaming).toBe(true);
    expect(result.capabilities.pushNotifications).toBe(false);
    expect(result.capabilities.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});

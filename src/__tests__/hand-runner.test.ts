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
  if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
  if (fnId === "state::list") return [...getScope(data.scope).entries()].map(([key, value]) => ({ key, value }));
  if (fnId === "state::update") return { ok: true };
  if (fnId === "security::set_capabilities") return { ok: true };
  if (fnId === "agent::create") return { id: data.id };
  if (fnId === "agent::chat") return { content: "Hand completed tasks", iterations: 3, usage: { total: 500 } };
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

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../hand-runner.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

const makeHand = (overrides?: any) => ({
  id: "hand-1",
  name: "daily-check",
  description: "Daily health check",
  tools: ["tool::shell_exec", "tool::web_fetch"],
  schedule: "0 9 * * *",
  agentConfig: {
    model: "claude-sonnet-4-6",
    maxIterations: 10,
    temperature: 0.7,
    systemPrompt: "You are a daily checker",
  },
  settings: { checkUrl: "https://example.com" },
  metrics: [{ label: "Checks", key: "checks" }],
  enabled: true,
  ...overrides,
});

describe("hand::register", () => {
  it("registers a hand and returns id", async () => {
    const result = await call("hand::register", {
      body: makeHand(),
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.id).toBe("hand-1");
    expect(result.registered).toBe(true);
  });

  it("stores hand in state", async () => {
    await call("hand::register", {
      body: makeHand(),
      headers: { authorization: "Bearer test-key" },
    });
    const setCalls = mockTrigger.mock.calls.filter(c => c[0] === "state::set");
    expect(setCalls.some(c => c[1].scope === "hands")).toBe(true);
  });

  it("sets capabilities for hand agent", async () => {
    await call("hand::register", {
      body: makeHand(),
      headers: { authorization: "Bearer test-key" },
    });
    const capCalls = mockTrigger.mock.calls.filter(c => c[0] === "security::set_capabilities");
    expect(capCalls.length).toBe(1);
    expect(capCalls[0][1].agentId).toContain("hand:");
  });

  it("creates agent for hand", async () => {
    await call("hand::register", {
      body: makeHand(),
      headers: { authorization: "Bearer test-key" },
    });
    const createCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::create");
    expect(createCalls.length).toBe(1);
  });

  it("generates id when not provided", async () => {
    const result = await call("hand::register", {
      body: makeHand({ id: undefined }),
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.id).toBeDefined();
    expect(result.registered).toBe(true);
  });

  it("sets tools in capabilities", async () => {
    await call("hand::register", {
      body: makeHand({ tools: ["tool::web_fetch"] }),
      headers: { authorization: "Bearer test-key" },
    });
    const capCalls = mockTrigger.mock.calls.filter(c => c[0] === "security::set_capabilities");
    expect(capCalls[0][1].capabilities.tools).toEqual(["tool::web_fetch"]);
  });

  it("sets memory scopes for hand", async () => {
    await call("hand::register", {
      body: makeHand({ id: "my-hand" }),
      headers: { authorization: "Bearer test-key" },
    });
    const capCalls = mockTrigger.mock.calls.filter(c => c[0] === "security::set_capabilities");
    expect(capCalls[0][1].capabilities.memoryScopes).toContain("memory:hand:my-hand");
  });

  it("includes shared memory scope", async () => {
    await call("hand::register", {
      body: makeHand(),
      headers: { authorization: "Bearer test-key" },
    });
    const capCalls = mockTrigger.mock.calls.filter(c => c[0] === "security::set_capabilities");
    expect(capCalls[0][1].capabilities.memoryScopes).toContain("shared.*");
  });

  it("uses default model when not specified", async () => {
    await call("hand::register", {
      body: makeHand({ agentConfig: { ...makeHand().agentConfig, model: undefined } }),
      headers: { authorization: "Bearer test-key" },
    });
    const createCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::create");
    expect(createCalls[0][1].model.model).toBe("claude-sonnet-4-6");
  });
});

describe("hand::execute", () => {
  it("executes a specific hand by id", async () => {
    getScope("hands").set("hand-1", makeHand());
    const result = await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("completed");
  });

  it("records run start in state", async () => {
    getScope("hands").set("hand-1", makeHand());
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const setCalls = mockTrigger.mock.calls.filter(c => c[0] === "state::set" && c[1].scope?.includes("hand_runs"));
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][1].value.status).toBe("running");
  });

  it("calls agent::chat for hand execution", async () => {
    getScope("hands").set("hand-1", makeHand());
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].agentId).toContain("hand:");
  });

  it("updates metrics after execution", async () => {
    getScope("hands").set("hand-1", makeHand());
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const updateCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "state::update" && c[1].scope === "hand_metrics");
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it("records completed status", async () => {
    getScope("hands").set("hand-1", makeHand());
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const updateCalls = mockTrigger.mock.calls.filter(c => c[0] === "state::update" && c[1].scope?.includes("hand_runs"));
    const completedUpdate = updateCalls.find(c => c[1].operations?.some((op: any) => op.path === "status" && op.value === "completed"));
    expect(completedUpdate).toBeDefined();
  });

  it("handles execution failure", async () => {
    getScope("hands").set("hand-1", makeHand());
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
      if (fnId === "state::update") return { ok: true };
      if (fnId === "agent::chat") throw new Error("Agent failed");
      return null;
    });
    const result = await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].error).toContain("Agent failed");
  });

  it("executes all enabled hands when no handId", async () => {
    getScope("hands").set("h1", { ...makeHand({ id: "h1" }), value: makeHand({ id: "h1" }) });
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
      if (fnId === "state::list") {
        return [
          { key: "h1", value: makeHand({ id: "h1" }) },
          { key: "h2", value: makeHand({ id: "h2", enabled: false }) },
        ];
      }
      if (fnId === "state::update") return { ok: true };
      if (fnId === "agent::chat") return { content: "Done", iterations: 1 };
      return null;
    });
    const result = await call("hand::execute", {
      body: {},
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.results.length).toBe(1);
  });

  it("includes prompt with hand name", async () => {
    getScope("hands").set("hand-1", makeHand({ name: "my-check" }));
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].message).toContain("my-check");
  });

  it("includes tools in prompt", async () => {
    getScope("hands").set("hand-1", makeHand());
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].message).toContain("tool::shell_exec");
  });

  it("includes settings in prompt", async () => {
    getScope("hands").set("hand-1", makeHand({ settings: { target: "prod" } }));
    await call("hand::execute", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].message).toContain("target");
    expect(chatCalls[0][1].message).toContain("prod");
  });
});

describe("hand::list", () => {
  it("returns hands from state", async () => {
    const result = await call("hand::list", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result).toBeDefined();
  });

  it("calls state::list with hands scope", async () => {
    await call("hand::list", {
      headers: { authorization: "Bearer test-key" },
    });
    const listCalls = mockTrigger.mock.calls.filter(c => c[0] === "state::list");
    expect(listCalls[0][1].scope).toBe("hands");
  });
});

describe("hand::metrics", () => {
  it("returns metrics for hand", async () => {
    const result = await call("hand::metrics", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.metrics).toBeDefined();
    expect(result.recentRuns).toBeDefined();
  });

  it("limits recent runs to 10", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::get") return {};
      if (fnId === "state::list") {
        return Array(15).fill(null).map((_, i) => ({
          value: { startedAt: Date.now() - i * 1000, status: "completed" },
        }));
      }
      return null;
    });
    const result = await call("hand::metrics", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.recentRuns.length).toBeLessThanOrEqual(10);
  });

  it("sorts recent runs by startedAt descending", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "state::get") return {};
      if (fnId === "state::list") {
        return [
          { value: { startedAt: 1000, status: "completed" } },
          { value: { startedAt: 3000, status: "completed" } },
          { value: { startedAt: 2000, status: "completed" } },
        ];
      }
      return null;
    });
    const result = await call("hand::metrics", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.recentRuns[0].startedAt).toBe(3000);
    expect(result.recentRuns[2].startedAt).toBe(1000);
  });

  it("handles empty metrics", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "state::get") throw new Error("not found");
      if (fnId === "state::list") throw new Error("not found");
      return null;
    });
    const result = await call("hand::metrics", {
      body: { handId: "hand-1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.metrics).toBeDefined();
  });
});

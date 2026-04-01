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
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list")
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  if (fnId === "agent::chat")
    return {
      content: "Hello from agent",
      model: "claude-sonnet-4-6",
      usage: { input: 10, output: 20, total: 30 },
    };
  if (fnId === "agent::list") return { agents: [{ name: "default" }] };
  if (fnId === "agent::create") return { id: data.id || "new-agent" };
  if (fnId === "agent::delete") return { deleted: true };
  if (fnId === "rate::check") return { allowed: true };
  if (fnId === "memory::recall") return [{ role: "system", content: "memory" }];
  if (fnId === "engine::workers::list")
    return [{ name: "api" }, { name: "agent-core" }];
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

vi.mock("../shared/validate.js", () => ({
  safeInt: vi.fn((val: any, min: number, max: number, def: number) => {
    const n = parseInt(val, 10);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }),
}));


vi.mock("../shared/errors.js", () => ({
  safeCall: vi.fn(async (fn: Function, fallback: any) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }),
}));

vi.mock("../shared/shutdown.js", () => ({
  shutdownManager: {
    initShutdown: vi.fn(),
    isShuttingDown: vi.fn(() => false),
    inFlightCount: vi.fn(() => 0),
    register: vi.fn(),
    complete: vi.fn(),
    registerIIIShutdown: vi.fn(),
  },
}));

vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  sanitizeId: vi.fn((id: string) => id?.replace(/[^a-zA-Z0-9_-]/g, "")),
}));

vi.mock("../security-headers.js", () => ({
  SECURITY_HEADERS: { "X-Frame-Options": "DENY" },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: "1.0.0" })),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTriggerVoid.mockClear();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "state::get")
        return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") {
        getScope(data.scope).set(data.key, data.value);
        return { ok: true };
      }
      if (fnId === "state::delete") {
        getScope(data.scope).delete(data.key);
        return { ok: true };
      }
      if (fnId === "state::list")
        return [...getScope(data.scope).entries()].map(([key, value]) => ({
          key,
          value,
        }));
      if (fnId === "agent::chat")
        return {
          content: "Hello from agent",
          model: "claude-sonnet-4-6",
          usage: { input: 10, output: 20, total: 30 },
        };
      if (fnId === "agent::list") return { agents: [{ name: "default" }] };
      if (fnId === "agent::create") return { id: data.id || "new-agent" };
      if (fnId === "agent::delete") return { deleted: true };
      if (fnId === "rate::check") return { allowed: true };
      if (fnId === "memory::recall")
        return [{ role: "system", content: "memory" }];
      if (fnId === "engine::workers::list")
        return [{ name: "api" }, { name: "agent-core" }];
      return null;
    },
  );
  process.env.AGENTOS_API_KEY = "test-key";
});

beforeAll(async () => {
  await import("../api.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

const authReq = (body?: any, extra?: any) => ({
  headers: { authorization: "Bearer test-key" },
  body,
  ...extra,
});

describe("api::chat_completions", () => {
  it("returns 200 with OpenAI-compatible response", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    );
    expect(result.status_code).toBe(200);
    expect(result.body.object).toBe("chat.completion");
  });

  it("returns choices array", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.choices).toHaveLength(1);
    expect(result.body.choices[0].message.role).toBe("assistant");
  });

  it("returns finish_reason stop", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.choices[0].finish_reason).toBe("stop");
  });

  it("returns usage information", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.usage).toBeDefined();
    expect(result.body.usage.prompt_tokens).toBe(10);
    expect(result.body.usage.completion_tokens).toBe(20);
    expect(result.body.usage.total_tokens).toBe(30);
  });

  it("returns created timestamp", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.created).toBeGreaterThan(0);
  });

  it("returns chatcmpl id prefix", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.id).toMatch(/^chatcmpl-/);
  });

  it("includes model in response", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.body.model).toBeDefined();
  });

  it("includes security headers", async () => {
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.headers).toBeDefined();
  });

  it("uses last message content for agent chat", async () => {
    await call(
      "api::chat_completions",
      authReq({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      }),
    );
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("second");
  });

  it("returns 401 when auth fails", async () => {
    const { requireAuth } = await import("../shared/utils.js");
    vi.mocked(requireAuth).mockImplementationOnce(() => {
      const err: any = new Error("Unauthorized");
      err.statusCode = 401;
      throw err;
    });
    const result = await call("api::chat_completions", { headers: {} });
    expect(result.status_code).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "rate::check") return { allowed: false, retryAfter: 60 };
      return null;
    });
    const result = await call(
      "api::chat_completions",
      authReq({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(result.status_code).toBe(429);
    expect(result.body.retryAfter).toBe(60);
  });
});

describe("api::agent_message", () => {
  it("returns 200 with agent response", async () => {
    const result = await call("api::agent_message", {
      ...authReq({ message: "Hello", sessionId: "s1" }),
      path_params: { id: "test-agent" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.content).toBeDefined();
  });

  it("passes sanitized agentId to trigger", async () => {
    await call("api::agent_message", {
      ...authReq({ message: "Hello" }),
      path_params: { id: "my-agent" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].agentId).toBe("my-agent");
  });

  it("passes sessionId to trigger", async () => {
    await call("api::agent_message", {
      ...authReq({ message: "Hello", sessionId: "sess-1" }),
      path_params: { id: "agent1" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("sess-1");
  });
});

describe("api::list_agents", () => {
  it("returns 200 with agent list", async () => {
    const result = await call("api::list_agents", authReq());
    expect(result.status_code).toBe(200);
    expect(result.body.agents).toBeDefined();
  });

  it("calls agent::list trigger", async () => {
    await call("api::list_agents", authReq());
    const calls = mockTrigger.mock.calls.filter((c) => c[0] === "agent::list");
    expect(calls.length).toBe(1);
  });
});

describe("api::create_agent", () => {
  it("returns 201 with created agent", async () => {
    const result = await call(
      "api::create_agent",
      authReq({
        name: "new-agent",
        model: { model: "claude-sonnet-4-6" },
      }),
    );
    expect(result.status_code).toBe(201);
  });

  it("calls agent::create trigger", async () => {
    await call("api::create_agent", authReq({ name: "a" }));
    const calls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::create",
    );
    expect(calls.length).toBe(1);
  });
});

describe("api::get_agent", () => {
  it("returns 200 when agent exists", async () => {
    getScope("agents").set("test-agent", { name: "test-agent" });
    const result = await call("api::get_agent", {
      ...authReq(),
      path_params: { id: "test-agent" },
    });
    expect(result.status_code).toBe(200);
  });

  it("returns 404 when agent not found", async () => {
    const result = await call("api::get_agent", {
      ...authReq(),
      path_params: { id: "nonexistent" },
    });
    expect(result.status_code).toBe(404);
    expect(result.body.error).toContain("not found");
  });
});

describe("api::delete_agent", () => {
  it("returns 204 on successful delete", async () => {
    const result = await call("api::delete_agent", {
      ...authReq(),
      path_params: { id: "to-delete" },
    });
    expect(result.status_code).toBe(204);
    expect(result.body).toBeNull();
  });

  it("calls agent::delete trigger", async () => {
    await call("api::delete_agent", {
      ...authReq(),
      path_params: { id: "to-delete" },
    });
    const calls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::delete",
    );
    expect(calls.length).toBe(1);
  });
});

describe("api::agent_sessions", () => {
  it("returns 200 with sessions list", async () => {
    const result = await call("api::agent_sessions", {
      ...authReq(),
      path_params: { id: "agent1" },
    });
    expect(result.status_code).toBe(200);
  });

  it("queries sessions scoped to agent", async () => {
    await call("api::agent_sessions", {
      ...authReq(),
      path_params: { id: "agent1" },
    });
    const calls = mockTrigger.mock.calls.filter((c) => c[0] === "state::list");
    expect(calls[0][1].scope).toContain("agent1");
  });
});

describe("api::health", () => {
  it("returns 200 with health status", async () => {
    const result = await call("api::health", authReq());
    expect(result.status_code).toBe(200);
    expect(result.body.status).toBe("healthy");
  });

  it("returns version", async () => {
    const result = await call("api::health", authReq());
    expect(result.body.version).toBeDefined();
  });

  it("returns worker count", async () => {
    const result = await call("api::health", authReq());
    expect(result.body.workers).toBeDefined();
  });

  it("returns uptime", async () => {
    const result = await call("api::health", authReq());
    expect(result.body.uptime).toBeGreaterThan(0);
  });

  it("handles worker list failure", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "engine::workers::list") throw new Error("fail");
      if (fnId === "rate::check") return { allowed: true };
      return null;
    });
    const result = await call("api::health", authReq());
    expect(result.status_code).toBe(200);
    expect(result.body.workers).toBe(0);
  });
});

describe("api::costs", () => {
  it("returns 200 with cost data", async () => {
    const result = await call("api::costs", authReq());
    expect(result.status_code).toBe(200);
  });

  it("returns zero cost when no data", async () => {
    const result = await call("api::costs", authReq());
    expect(result.body.totalCost).toBe(0);
  });

  it("returns cost data when available", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getScope("costs").set(today, { totalCost: 5.5, breakdown: {} });
    const result = await call("api::costs", authReq());
    expect(result.body.totalCost).toBe(5.5);
  });
});

describe("api::memory_query", () => {
  it("returns 200 with memory results", async () => {
    const result = await call("api::memory_query", {
      ...authReq(),
      path_params: { id: "agent1" },
      query_params: { query: "test", limit: 5 },
    });
    expect(result.status_code).toBe(200);
  });

  it("calls memory::recall with correct params", async () => {
    await call("api::memory_query", {
      ...authReq(),
      path_params: { id: "agent1" },
      query_params: { query: "search term", limit: 10 },
    });
    const recallCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "memory::recall",
    );
    expect(recallCalls.length).toBe(1);
    expect(recallCalls[0][1].agentId).toBe("agent1");
  });

  it("uses body params when query_params absent", async () => {
    await call("api::memory_query", {
      ...authReq({ query: "from body", limit: 3 }),
      path_params: { id: "agent1" },
    });
    const recallCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "memory::recall",
    );
    expect(recallCalls.length).toBe(1);
  });
});

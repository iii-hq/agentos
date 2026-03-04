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
  if (fnId === "skill::list")
    return [
      {
        id: "s1",
        name: "recall",
        description: "Memory recall",
        tags: ["memory"],
      },
    ];
  if (fnId === "agent::chat")
    return {
      content: "Agent response",
      model: "claude-sonnet-4-6",
      usage: { total: 30 },
    };
  return null;
});
const mockTriggerVoid = vi.fn((fnId: string, data?: any) => {
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
  }
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
  }
});

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

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  assertNoSsrf: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (
      ["127.0.0.1", "localhost", "169.254.169.254"].includes(parsed.hostname)
    ) {
      throw new Error(`SSRF blocked: ${parsed.hostname}`);
    }
  }),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
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
      if (fnId === "skill::list")
        return [
          {
            id: "s1",
            name: "recall",
            description: "Memory recall",
            tags: ["memory"],
          },
        ];
      if (fnId === "agent::chat")
        return {
          content: "Agent response",
          model: "claude-sonnet-4-6",
          usage: { total: 30 },
        };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../a2a.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("a2a::agent_card", () => {
  it("returns agent card with default values", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
    });
    expect(result.name).toBe("agentsos");
    expect(result.url).toBe("https://example.com");
    expect(result.version).toBe("0.1.0");
  });

  it("includes capabilities", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
    });
    expect(result.capabilities.stateTransitionHistory).toBe(true);
    expect(result.capabilities.streaming).toBe(false);
    expect(result.capabilities.pushNotifications).toBe(false);
  });

  it("uses custom name and description", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
      name: "Custom Agent",
      description: "Custom description",
    });
    expect(result.name).toBe("Custom Agent");
    expect(result.description).toBe("Custom description");
  });

  it("includes skills from skill::list", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
    });
    expect(result.skills).toBeDefined();
    expect(result.skills.length).toBeGreaterThan(0);
  });

  it("uses provided skills when given", async () => {
    const skills = [
      {
        id: "s1",
        name: "test",
        description: "Test skill",
        tags: [],
        examples: [],
      },
    ];
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
      skills,
    });
    expect(result.skills).toEqual(skills);
  });

  it("includes bearer authentication", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
    });
    expect(result.authentication.schemes).toContain("bearer");
  });

  it("includes default input/output modes", async () => {
    const result = await call("a2a::agent_card", {
      baseUrl: "https://example.com",
    });
    expect(result.defaultInputModes).toContain("text/plain");
    expect(result.defaultOutputModes).toContain("text/plain");
  });

  it("stores card in state", async () => {
    await call("a2a::agent_card", { baseUrl: "https://example.com" });
    const setCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set",
    );
    expect(
      setCalls.some((c) => c[1].scope === "a2a" && c[1].key === "agent_card"),
    ).toBe(true);
  });
});

describe("a2a::handle_task", () => {
  it("rejects invalid JSON-RPC", async () => {
    const result = await call("a2a::handle_task", {
      body: { jsonrpc: "1.0", id: "1", method: "tasks/send", params: {} },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32600);
  });

  it("handles tasks/send method", async () => {
    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "tasks/send",
        params: {
          id: "task-1",
          sessionId: "sess-1",
          message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.jsonrpc).toBe("2.0");
    expect(result.id).toBe("rpc-1");
    expect(result.result).toBeDefined();
    expect(result.result.status.state).toBe("completed");
  });

  it("routes tasks/send to agent::chat", async () => {
    await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "rpc-2",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "Do something" }],
          },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toBe("Do something");
  });

  it("includes agent response in history", async () => {
    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "rpc-3",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "Hi" }] },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.result.history.length).toBeGreaterThanOrEqual(2);
    expect(result.result.history[1].role).toBe("agent");
  });

  it("handles tasks/send failure gracefully", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "agent::chat") throw new Error("Agent crashed");
      if (fnId === "state::get")
        return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") {
        getScope(data.scope).set(data.key, data.value);
        return { ok: true };
      }
      return null;
    });
    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "rpc-err",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "Fail" }] },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.result.status.state).toBe("failed");
  });

  it("handles tasks/get for existing task", async () => {
    const sendResult = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "send-1",
        method: "tasks/send",
        params: {
          id: "get-task-1",
          message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });

    const getResult = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "get-1",
        method: "tasks/get",
        params: { id: "get-task-1" },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(getResult.result).toBeDefined();
    expect(getResult.result.id).toBe("get-task-1");
  });

  it("returns error for tasks/get with unknown task", async () => {
    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "get-2",
        method: "tasks/get",
        params: { id: "nonexistent" },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32001);
  });

  it("handles tasks/cancel", async () => {
    await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "send-c",
        method: "tasks/send",
        params: {
          id: "cancel-task-1",
          message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
        },
      },
      headers: { authorization: "Bearer test-key" },
    });

    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "tasks/cancel",
        params: { id: "cancel-task-1" },
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.result.status.state).toBe("cancelled");
  });

  it("returns error for unknown method", async () => {
    const result = await call("a2a::handle_task", {
      body: {
        jsonrpc: "2.0",
        id: "unknown-1",
        method: "tasks/unknown",
        params: {},
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32601);
  });
});

describe("a2a::get_task", () => {
  it("throws for nonexistent local task", async () => {
    await expect(
      call("a2a::get_task", { taskId: "nonexistent" }),
    ).rejects.toThrow("Task not found");
  });
});

describe("a2a::cancel_task", () => {
  it("throws for nonexistent local task", async () => {
    await expect(
      call("a2a::cancel_task", { taskId: "nonexistent" }),
    ).rejects.toThrow("Task not found");
  });
});

describe("handler registration", () => {
  it("registers a2a::agent_card", () => {
    expect(handlers["a2a::agent_card"]).toBeDefined();
  });

  it("registers a2a::send_task", () => {
    expect(handlers["a2a::send_task"]).toBeDefined();
  });

  it("registers a2a::get_task", () => {
    expect(handlers["a2a::get_task"]).toBeDefined();
  });

  it("registers a2a::cancel_task", () => {
    expect(handlers["a2a::cancel_task"]).toBeDefined();
  });

  it("registers a2a::handle_task", () => {
    expect(handlers["a2a::handle_task"]).toBeDefined();
  });

  it("registers a2a::discover", () => {
    expect(handlers["a2a::discover"]).toBeDefined();
  });
});

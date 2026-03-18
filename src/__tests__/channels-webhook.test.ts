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
  if (fnId === "agent::chat") return { content: "Webhook reply" };
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
  splitMessage: vi.fn((text: string, limit: number) => [text]),
  resolveAgent: vi.fn(async () => "default-agent"),
  assertNoSsrf: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (
      ["127.0.0.1", "localhost", "169.254.169.254"].includes(parsed.hostname)
    ) {
      throw new Error(`SSRF blocked: ${parsed.hostname}`);
    }
  }),
}));

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

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
      if (fnId === "agent::chat") return { content: "Webhook reply" };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
});

beforeAll(async () => {
  await import("../channels/webhook.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::webhook::inbound", () => {
  it("registers the handler", () => {
    expect(handlers["channel::webhook::inbound"]).toBeDefined();
  });

  it("processes webhook with message field", async () => {
    const result = await call("channel::webhook::inbound", {
      body: { message: "Hello" },
      headers: {},
      query_params: {},
      path_params: { channelId: "ch-1" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.response).toBe("Webhook reply");
  });

  it("processes webhook with text field", async () => {
    const result = await call("channel::webhook::inbound", {
      body: { text: "Text field" },
      headers: {},
      query_params: {},
      path_params: { channelId: "ch-2" },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes webhook with content field", async () => {
    const result = await call("channel::webhook::inbound", {
      body: { content: "Content field" },
      headers: {},
      query_params: {},
      path_params: { channelId: "ch-3" },
    });
    expect(result.status_code).toBe(200);
  });

  it("uses channelId from path_params", async () => {
    await call("channel::webhook::inbound", {
      body: { message: "Path param" },
      headers: {},
      query_params: {},
      path_params: { channelId: "my-channel" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("webhook:my-channel");
  });

  it("uses channel from query_params when no path param", async () => {
    await call("channel::webhook::inbound", {
      body: { message: "Query param" },
      headers: {},
      query_params: { channel: "query-ch" },
      path_params: {},
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("webhook:query-ch");
  });

  it("uses default channelId when none provided", async () => {
    await call("channel::webhook::inbound", {
      body: { message: "Default" },
      headers: {},
      query_params: {},
      path_params: {},
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("webhook:default");
  });

  it("calls callback_url when provided", async () => {
    await call("channel::webhook::inbound", {
      body: {
        message: "With callback",
        callback_url: "https://example.com/callback",
      },
      headers: {},
      query_params: {},
      path_params: { channelId: "cb-test" },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/callback",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("calls response_url when provided", async () => {
    await call("channel::webhook::inbound", {
      body: {
        message: "With response_url",
        response_url: "https://example.com/response",
      },
      headers: {},
      query_params: {},
      path_params: { channelId: "resp-test" },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/response",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("blocks SSRF on callback_url", async () => {
    await expect(
      call("channel::webhook::inbound", {
        body: { message: "SSRF", callback_url: "http://localhost/evil" },
        headers: {},
        query_params: {},
        path_params: { channelId: "ssrf-test" },
      }),
    ).rejects.toThrow("SSRF blocked");
  });

  it("handles unrecognized payload", async () => {
    await call("channel::webhook::inbound", {
      body: { something_else: "unknown" },
      headers: {},
      query_params: {},
      path_params: { channelId: "unknown" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("[Unrecognized webhook payload]");
  });
});

describe("channel::webhook::configure", () => {
  it("registers the handler", () => {
    expect(handlers["channel::webhook::configure"]).toBeDefined();
  });

  it("configures a webhook channel", async () => {
    const result = await call("channel::webhook::configure", {
      channelId: "new-channel",
      agentId: "agent-1",
    });
    expect(result.configured).toBe(true);
    expect(result.channelId).toBe("new-channel");
  });

  it("stores configuration in state", async () => {
    await call("channel::webhook::configure", {
      channelId: "stored-ch",
      agentId: "agent-2",
    });
    const setCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set",
    );
    expect(
      setCalls.some(
        (c) =>
          c[1].scope === "channel_agents" && c[1].key === "webhook:stored-ch",
      ),
    ).toBe(true);
  });

  it("stores callback URL when provided", async () => {
    await call("channel::webhook::configure", {
      channelId: "cb-ch",
      agentId: "agent-3",
      callbackUrl: "https://example.com/hook",
    });
    const setCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set",
    );
    const storeCall = setCalls.find((c) => c[1].key === "webhook:cb-ch");
    expect(storeCall?.[1].value.callbackUrl).toBe("https://example.com/hook");
  });

  it("includes configuredAt timestamp", async () => {
    const before = Date.now();
    await call("channel::webhook::configure", {
      channelId: "ts-ch",
      agentId: "agent-4",
    });
    const setCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set",
    );
    const storeCall = setCalls.find((c) => c[1].key === "webhook:ts-ch");
    expect(storeCall?.[1].value.configuredAt).toBeGreaterThanOrEqual(before);
  });
});

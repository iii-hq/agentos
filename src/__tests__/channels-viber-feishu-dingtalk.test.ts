// @ts-nocheck
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "agent::chat") return { content: "Reply" };
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
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  splitMessage: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit)
      chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

vi.mock("crypto", async () => {
  const actual = await vi.importActual("crypto");
  return {
    ...actual,
      createHmac: (algo: string, key: string) => ({
      update: (data: string) => ({
        digest: (enc: string) => "mock-signature-base64",
      }),
    }),
  };
});

const mockFetch = vi.fn(
  async () =>
    ({
      ok: true,
      json: async () => ({ code: 0, tenant_access_token: "mock-tenant-token" }),
    }) as any,
);
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "agent::chat") return { content: "Reply" };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
  mockFetch.mockImplementation(
    async () =>
      ({
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: "mock-tenant-token",
        }),
      }) as any,
  );
});

beforeAll(async () => {
  process.env.VIBER_TOKEN = "test-viber-token";
  process.env.FEISHU_APP_ID = "test-feishu-app-id";
  process.env.FEISHU_APP_SECRET = "test-feishu-secret";
  process.env.DINGTALK_TOKEN = "test-dingtalk-token";
  process.env.DINGTALK_SECRET = "test-dingtalk-secret";
  await import("../channels/viber.js");
  await import("../channels/feishu.js");
  await import("../channels/dingtalk.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::viber::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::viber::webhook"]).toBeDefined();
  });

  it("ignores non-message events", async () => {
    const result = await call("channel::viber::webhook", {
      body: { event: "conversation_started" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores messages without text", async () => {
    const result = await call("channel::viber::webhook", {
      body: { event: "message", sender: { id: "v1" }, message: {} },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores messages without sender id", async () => {
    const result = await call("channel::viber::webhook", {
      body: { event: "message", sender: {}, message: { text: "Hi" } },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes message event", async () => {
    const result = await call("channel::viber::webhook", {
      body: {
        event: "message",
        sender: { id: "viber-u1" },
        message: { text: "Hello Viber" },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with viber session", async () => {
    await call("channel::viber::webhook", {
      body: {
        event: "message",
        sender: { id: "viber-u2" },
        message: { text: "Route test" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("viber:viber-u2");
    expect(chatCalls[0][1].message).toBe("Route test");
  });

  it("sends reply via Viber API", async () => {
    await call("channel::viber::webhook", {
      body: {
        event: "message",
        sender: { id: "viber-u3" },
        message: { text: "API test" },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("chatapi.viber.com"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses correct Viber auth header", async () => {
    await call("channel::viber::webhook", {
      body: {
        event: "message",
        sender: { id: "viber-u4" },
        message: { text: "Auth test" },
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const headers = (fetchCall[1] as any).headers;
    expect(headers["X-Viber-Auth-Token"]).toBe("test-viber-token");
  });

  it("emits audit event", async () => {
    await call("channel::viber::webhook", {
      body: {
        event: "message",
        sender: { id: "viber-u5" },
        message: { text: "Audit" },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "viber",
          userId: "viber-u5",
        }),
      }),
    );
  });
});

describe("channel::feishu::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::feishu::webhook"]).toBeDefined();
  });

  it("handles challenge verification", async () => {
    const result = await call("channel::feishu::webhook", {
      body: { challenge: "feishu-challenge-123" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.challenge).toBe("feishu-challenge-123");
  });

  it("ignores events without message content", async () => {
    const result = await call("channel::feishu::webhook", {
      body: { event: { message: {} } },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes message event", async () => {
    const result = await call("channel::feishu::webhook", {
      body: {
        event: {
          message: {
            chat_id: "chat-1",
            content: JSON.stringify({ text: "Hello Feishu" }),
          },
          sender: { sender_id: { user_id: "feishu-u1" } },
        },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with feishu session", async () => {
    await call("channel::feishu::webhook", {
      body: {
        event: {
          message: {
            chat_id: "chat-2",
            content: JSON.stringify({ text: "Route test" }),
          },
          sender: { sender_id: { user_id: "feishu-u2" } },
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("feishu:chat-2");
    expect(chatCalls[0][1].message).toBe("Route test");
  });

  it("fetches tenant token for API calls", async () => {
    await call("channel::feishu::webhook", {
      body: {
        event: {
          message: {
            chat_id: "chat-3",
            content: JSON.stringify({ text: "Token test" }),
          },
          sender: { sender_id: { user_id: "feishu-u3" } },
        },
      },
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  it("sends reply via Feishu API", async () => {
    await call("channel::feishu::webhook", {
      body: {
        event: {
          message: {
            chat_id: "chat-4",
            content: JSON.stringify({ text: "API test" }),
          },
          sender: { sender_id: { user_id: "feishu-u4" } },
        },
      },
    });
    const apiCalls = mockFetch.mock.calls.filter((c) =>
      (c[0] as string).includes("feishu.cn"),
    );
    expect(apiCalls.length).toBeGreaterThan(0);
  });

  it("emits audit event", async () => {
    await call("channel::feishu::webhook", {
      body: {
        event: {
          message: {
            chat_id: "chat-5",
            content: JSON.stringify({ text: "Audit" }),
          },
          sender: { sender_id: { user_id: "feishu-u5" } },
        },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "feishu",
          chatId: "chat-5",
          userId: "feishu-u5",
        }),
      }),
    );
  });

  it("ignores events with no event field", async () => {
    const result = await call("channel::feishu::webhook", {
      body: {},
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });
});

describe("channel::dingtalk::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::dingtalk::webhook"]).toBeDefined();
  });

  it("ignores empty text content", async () => {
    const result = await call("channel::dingtalk::webhook", {
      body: { text: {}, conversationId: "conv-1", senderId: "s1" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores whitespace-only text", async () => {
    const result = await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "   " },
        conversationId: "conv-2",
        senderId: "s2",
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes text message", async () => {
    const result = await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "Hello DingTalk" },
        conversationId: "conv-3",
        senderId: "ding-s1",
        senderNick: "TestUser",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with dingtalk session", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "Route test" },
        conversationId: "conv-4",
        senderId: "ding-s2",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("dingtalk:conv-4");
    expect(chatCalls[0][1].message).toBe("Route test");
  });

  it("sends reply via DingTalk API", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "API test" },
        conversationId: "conv-5",
        senderId: "ding-s3",
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("oapi.dingtalk.com"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes access_token in API URL", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "Token test" },
        conversationId: "conv-6",
        senderId: "ding-s4",
      },
    });
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("access_token=test-dingtalk-token");
  });

  it("includes signature in API URL", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "Sign test" },
        conversationId: "conv-7",
        senderId: "ding-s5",
      },
    });
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("sign=");
  });

  it("emits audit event", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "Audit" },
        conversationId: "conv-8",
        senderId: "ding-s6",
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "dingtalk",
          conversationId: "conv-8",
          senderId: "ding-s6",
        }),
      }),
    );
  });

  it("trims content whitespace", async () => {
    await call("channel::dingtalk::webhook", {
      body: {
        text: { content: "  trimmed  " },
        conversationId: "conv-9",
        senderId: "ding-s7",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("trimmed");
  });
});

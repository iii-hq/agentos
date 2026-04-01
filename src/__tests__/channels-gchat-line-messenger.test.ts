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

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
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
});

beforeAll(async () => {
  process.env.GOOGLE_CHAT_TOKEN = "test-gchat-token";
  process.env.LINE_CHANNEL_TOKEN = "test-line-token";
  process.env.MESSENGER_PAGE_TOKEN = "test-page-token";
  process.env.MESSENGER_VERIFY_TOKEN = "test-verify-token";
  await import("../channels/google-chat.js");
  await import("../channels/line.js");
  await import("../channels/messenger.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::google-chat::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::google-chat::webhook"]).toBeDefined();
  });

  it("ignores non-MESSAGE events", async () => {
    const result = await call("channel::google-chat::webhook", {
      body: { type: "ADDED_TO_SPACE" },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes MESSAGE event", async () => {
    const result = await call("channel::google-chat::webhook", {
      body: {
        type: "MESSAGE",
        space: { name: "spaces/abc" },
        message: { text: "Hello Google Chat" },
        user: { name: "users/u1" },
      },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.text).toBe("Reply");
  });

  it("routes to agent::chat with google-chat session", async () => {
    await call("channel::google-chat::webhook", {
      body: {
        type: "MESSAGE",
        space: { name: "spaces/room-1" },
        message: { text: "Routing test" },
        user: { name: "users/u2" },
      },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("google-chat:spaces/room-1");
    expect(chatCalls[0][1].message).toBe("Routing test");
  });

  it("emits audit event", async () => {
    await call("channel::google-chat::webhook", {
      body: {
        type: "MESSAGE",
        space: { name: "spaces/audit" },
        message: { text: "Audit" },
        user: { name: "users/u3" },
      },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "google-chat",
          spaceId: "spaces/audit",
          userId: "users/u3",
        }),
      }),
    );
  });

  it("returns response text in body", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "agent::chat") return { content: "Custom response" };
      return null;
    });
    const result = await call("channel::google-chat::webhook", {
      body: {
        type: "MESSAGE",
        space: { name: "spaces/resp" },
        message: { text: "Get response" },
        user: { name: "users/u4" },
      },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    expect(result.body.text).toBe("Custom response");
  });

  it("handles missing message text gracefully", async () => {
    const result = await call("channel::google-chat::webhook", {
      body: {
        type: "MESSAGE",
        space: { name: "spaces/empty" },
        message: {},
        user: { name: "users/u5" },
      },
      headers: { Authorization: "Bearer test-gchat-token" },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("");
  });
});

describe("channel::line::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::line::webhook"]).toBeDefined();
  });

  it("ignores non-message events", async () => {
    const result = await call("channel::line::webhook", {
      body: { events: [{ type: "follow" }] },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores non-text message types", async () => {
    const result = await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "image" },
            source: { userId: "u1" },
            replyToken: "rt-1",
          },
        ],
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(0);
  });

  it("processes text message event", async () => {
    const result = await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "Hello LINE" },
            source: { userId: "line-user-1" },
            replyToken: "rt-2",
          },
        ],
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with line session", async () => {
    await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "Route test" },
            source: { userId: "line-u2" },
            replyToken: "rt-3",
          },
        ],
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("line:line-u2");
    expect(chatCalls[0][1].message).toBe("Route test");
  });

  it("sends reply via LINE API", async () => {
    await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "API test" },
            source: { userId: "line-u3" },
            replyToken: "rt-4",
          },
        ],
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.line.me/v2/bot/message/reply"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses correct LINE auth header", async () => {
    await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "Auth test" },
            source: { userId: "line-u4" },
            replyToken: "rt-5",
          },
        ],
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const headers = (fetchCall[1] as any).headers;
    expect(headers.Authorization).toBe("Bearer test-line-token");
  });

  it("uses groupId when userId is absent", async () => {
    await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "Group msg" },
            source: { groupId: "group-g1" },
            replyToken: "rt-6",
          },
        ],
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("line:group-g1");
  });

  it("emits audit event", async () => {
    await call("channel::line::webhook", {
      body: {
        events: [
          {
            type: "message",
            message: { type: "text", text: "Audit" },
            source: { userId: "line-u5" },
            replyToken: "rt-7",
          },
        ],
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "line",
          userId: "line-u5",
        }),
      }),
    );
  });

  it("handles empty events array", async () => {
    const result = await call("channel::line::webhook", {
      body: { events: [] },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });
});

describe("channel::messenger::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::messenger::webhook"]).toBeDefined();
  });

  it("handles subscription verification", async () => {
    const result = await call("channel::messenger::webhook", {
      body: {
        "hub.mode": "subscribe",
        "hub.verify_token": "test-verify-token",
        "hub.challenge": "challenge-abc",
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body).toBe("challenge-abc");
  });

  it("rejects incorrect verify token", async () => {
    const result = await call("channel::messenger::webhook", {
      body: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-xyz",
      },
    });
    expect(result.status_code).toBe(403);
  });

  it("ignores messages without text", async () => {
    const result = await call("channel::messenger::webhook", {
      body: {
        entry: [{ messaging: [{ sender: { id: "s1" }, message: {} }] }],
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes text message", async () => {
    const result = await call("channel::messenger::webhook", {
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: "sender-1" },
                message: { text: "Hello Messenger" },
              },
            ],
          },
        ],
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with messenger session", async () => {
    await call("channel::messenger::webhook", {
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: "sender-2" },
                message: { text: "Route test" },
              },
            ],
          },
        ],
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("messenger:sender-2");
    expect(chatCalls[0][1].message).toBe("Route test");
  });

  it("sends reply via Graph API", async () => {
    await call("channel::messenger::webhook", {
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: "sender-3" },
                message: { text: "API test" },
              },
            ],
          },
        ],
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("graph.facebook.com"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends page token in Authorization header", async () => {
    await call("channel::messenger::webhook", {
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: "sender-4" },
                message: { text: "Token test" },
              },
            ],
          },
        ],
      },
    });
    const fetchOpts = mockFetch.mock.calls[0][1] as any;
    expect(fetchOpts.headers.Authorization).toBe("Bearer test-page-token");
  });

  it("emits audit event", async () => {
    await call("channel::messenger::webhook", {
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: "sender-5" },
                message: { text: "Audit" },
              },
            ],
          },
        ],
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "messenger",
          senderId: "sender-5",
        }),
      }),
    );
  });

  it("handles empty entry array", async () => {
    const result = await call("channel::messenger::webhook", {
      body: { entry: [] },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });
});

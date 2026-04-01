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
    shutdown: vi.fn(),
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
  process.env.TWITCH_TOKEN = "test-twitch-token";
  process.env.TWITCH_CLIENT_ID = "test-client-id";
  process.env.LINKEDIN_TOKEN = "test-linkedin-token";
  await import("../channels/twitch.js");
  await import("../channels/linkedin.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::twitch::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::twitch::webhook"]).toBeDefined();
  });

  it("handles EventSub challenge", async () => {
    const result = await call("channel::twitch::webhook", {
      body: { challenge: "twitch-challenge-xyz" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body).toBe("twitch-challenge-xyz");
  });

  it("ignores events without message text", async () => {
    const result = await call("channel::twitch::webhook", {
      body: { event: { broadcaster_user_id: "123" } },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("processes chat message", async () => {
    const result = await call("channel::twitch::webhook", {
      body: {
        event: {
          broadcaster_user_id: "broadcaster-1",
          user_id: "user-1",
          message: { text: "Hello Twitch" },
        },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with twitch session", async () => {
    await call("channel::twitch::webhook", {
      body: {
        event: {
          broadcaster_user_id: "bc-2",
          user_id: "u-2",
          message: { text: "Twitch msg" },
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("twitch:bc-2");
    expect(chatCalls[0][1].message).toBe("Twitch msg");
  });

  it("sends reply via Twitch Helix API", async () => {
    await call("channel::twitch::webhook", {
      body: {
        event: {
          broadcaster_user_id: "bc-3",
          user_id: "u-3",
          message: { text: "Reply test" },
        },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.twitch.tv/helix/chat/messages"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses correct auth headers", async () => {
    await call("channel::twitch::webhook", {
      body: {
        event: {
          broadcaster_user_id: "bc-4",
          user_id: "u-4",
          message: { text: "Auth" },
        },
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const headers = (fetchCall[1] as any).headers;
    expect(headers.Authorization).toBe("Bearer test-twitch-token");
    expect(headers["Client-Id"]).toBe("test-client-id");
  });

  it("emits audit event", async () => {
    await call("channel::twitch::webhook", {
      body: {
        event: {
          broadcaster_user_id: "bc-5",
          user_id: "u-5",
          message: { text: "Audit" },
        },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({
          channel: "twitch",
          channelId: "bc-5",
          userId: "u-5",
        }),
      }),
    );
  });

  it("ignores empty body", async () => {
    const result = await call("channel::twitch::webhook", { body: {} });
    expect(result.status_code).toBe(200);
  });
});

describe("channel::linkedin::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::linkedin::webhook"]).toBeDefined();
  });

  it("ignores non-message events", async () => {
    const result = await call("channel::linkedin::webhook", {
      body: { elements: [{ event: {} }] },
    });
    expect(result.status_code).toBe(200);
  });

  it("ignores empty elements", async () => {
    const result = await call("channel::linkedin::webhook", {
      body: { elements: [] },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes LinkedIn message event", async () => {
    const result = await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:123",
            from: "urn:li:person:456",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                messageBody: { text: "LinkedIn msg" },
              },
            },
          },
        ],
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with linkedin session", async () => {
    await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:abc",
            from: "urn:li:person:def",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                messageBody: { text: "Test LI" },
              },
            },
          },
        ],
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("linkedin:urn:li:thread:abc");
  });

  it("handles attributedBody text fallback", async () => {
    await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:fallback",
            from: "urn:li:person:x",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                attributedBody: { text: "Attributed text" },
              },
            },
          },
        ],
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("Attributed text");
  });

  it("ignores message without text in either body", async () => {
    const result = await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:notext",
            from: "urn:li:person:y",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {},
            },
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

  it("sends reply via LinkedIn API", async () => {
    await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:reply",
            from: "urn:li:person:z",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                messageBody: { text: "Reply me" },
              },
            },
          },
        ],
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.linkedin.com/v2/messages"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses correct LinkedIn auth headers", async () => {
    await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:auth",
            from: "urn:li:person:auth",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                messageBody: { text: "Auth check" },
              },
            },
          },
        ],
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const headers = (fetchCall[1] as any).headers;
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(headers.Authorization).toBe("Bearer test-linkedin-token");
  });

  it("emits audit event", async () => {
    await call("channel::linkedin::webhook", {
      body: {
        elements: [
          {
            entityUrn: "urn:li:thread:audit",
            from: "urn:li:person:audit",
            event: {
              "com.linkedin.voyager.messaging.event.MessageEvent": {
                messageBody: { text: "Audit LI" },
              },
            },
          },
        ],
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "linkedin" }),
      }),
    );
  });
});

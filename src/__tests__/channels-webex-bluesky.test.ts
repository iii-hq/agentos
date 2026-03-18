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
  splitMessage: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit)
      chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

const mockFetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    text: "Fetched message",
    id: "msg-1",
    accessJwt: "jwt",
    did: "did:plc:test",
  }),
}));
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
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      text: "Fetched message",
      id: "msg-1",
      accessJwt: "jwt",
      did: "did:plc:test",
    }),
  }));
});

beforeAll(async () => {
  process.env.WEBEX_TOKEN = "test-webex-token";
  process.env.BLUESKY_HANDLE = "test.bsky.social";
  process.env.BLUESKY_PASSWORD = "test-password";
  await import("../channels/webex.js");
  await import("../channels/bluesky.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::webex::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::webex::webhook"]).toBeDefined();
  });

  it("ignores non-messages resources", async () => {
    const result = await call("channel::webex::webhook", {
      body: { resource: "rooms", event: "created" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores non-created events", async () => {
    const result = await call("channel::webex::webhook", {
      body: { resource: "messages", event: "deleted" },
    });
    expect(result.status_code).toBe(200);
  });

  it("fetches message content from Webex API", async () => {
    await call("channel::webex::webhook", {
      body: {
        resource: "messages",
        event: "created",
        data: { id: "msg-123", roomId: "room-1", personId: "person-1" },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("webexapis.com/v1/messages/msg-123"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-webex-token",
        }),
      }),
    );
  });

  it("routes to agent::chat with webex session", async () => {
    await call("channel::webex::webhook", {
      body: {
        resource: "messages",
        event: "created",
        data: { id: "msg-456", roomId: "room-2", personId: "p-1" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("webex:room-2");
  });

  it("sends reply to Webex room", async () => {
    await call("channel::webex::webhook", {
      body: {
        resource: "messages",
        event: "created",
        data: { id: "msg-789", roomId: "room-3", personId: "p-2" },
      },
    });
    const sendCalls = mockFetch.mock.calls.filter(
      (c) => (c[1] as any)?.method === "POST",
    );
    expect(sendCalls.length).toBeGreaterThan(0);
  });

  it("emits audit event", async () => {
    await call("channel::webex::webhook", {
      body: {
        resource: "messages",
        event: "created",
        data: { id: "msg-a", roomId: "r-a", personId: "p-a" },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "webex" }),
      }),
    );
  });

  it("handles empty text response", async () => {
    mockFetch.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ text: "" }),
    }));
    const result = await call("channel::webex::webhook", {
      body: {
        resource: "messages",
        event: "created",
        data: { id: "msg-empty", roomId: "r-e", personId: "p-e" },
      },
    });
    expect(result.status_code).toBe(200);
  });
});

describe("channel::bluesky::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::bluesky::webhook"]).toBeDefined();
  });

  it("ignores messages without text", async () => {
    const result = await call("channel::bluesky::webhook", {
      body: { did: "did:plc:user1" },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes valid mention", async () => {
    const result = await call("channel::bluesky::webhook", {
      body: {
        did: "did:plc:user2",
        text: "Hello Bluesky",
        uri: "at://did:plc:user2/post/1",
        cid: "bafyrei1",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with bluesky session", async () => {
    await call("channel::bluesky::webhook", {
      body: {
        did: "did:plc:user3",
        text: "Bluesky msg",
        uri: "at://x/post/2",
        cid: "bafyrei2",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("bluesky:did:plc:user3");
  });

  it("calls Bluesky API to send reply", async () => {
    await call("channel::bluesky::webhook", {
      body: {
        did: "did:plc:user4",
        text: "Auth test",
        uri: "at://x/post/3",
        cid: "bafyrei3",
      },
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  it("sends reply as post via AT Protocol", async () => {
    await call("channel::bluesky::webhook", {
      body: {
        did: "did:plc:user5",
        text: "Post test",
        uri: "at://x/post/4",
        cid: "bafyrei4",
      },
    });
    const createCalls = (mockFetch.mock.calls as any[][]).filter((c) =>
      (c[0] as string).includes("createRecord"),
    );
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("emits audit event", async () => {
    await call("channel::bluesky::webhook", {
      body: {
        did: "did:plc:user6",
        text: "Audit bsky",
        uri: "at://x/post/5",
        cid: "bafyrei5",
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "bluesky" }),
      }),
    );
  });
});

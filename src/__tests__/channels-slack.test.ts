import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "agent::chat") return { content: "Agent reply" };
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

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  splitMessage: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit)
      chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  resolveAgent: vi.fn(async () => "default-agent"),
  verifySlackSignature: vi.fn(),
}));

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = "test-secret";
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "agent::chat") return { content: "Agent reply" };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
});

beforeAll(async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.SLACK_SIGNING_SECRET = "";
  await import("../channels/slack.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::slack::events", () => {
  it("registers the handler", () => {
    expect(handlers["channel::slack::events"]).toBeDefined();
  });

  it("handles url_verification challenge", async () => {
    const result = await call("channel::slack::events", {
      body: { type: "url_verification", challenge: "test-challenge-123" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.challenge).toBe("test-challenge-123");
  });

  it("processes message event", async () => {
    const result = await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          text: "Hello bot",
          channel: "C123",
          ts: "1234.5678",
        },
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("routes message to agent::chat", async () => {
    await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          text: "Test message",
          channel: "C456",
          ts: "9999.0000",
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toBe("Test message");
  });

  it("uses thread_ts for session ID when available", async () => {
    await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          text: "Threaded",
          channel: "C789",
          ts: "1.1",
          thread_ts: "0.9",
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("slack:C789:0.9");
  });

  it("uses ts when no thread_ts", async () => {
    await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          text: "Top-level",
          channel: "Cxyz",
          ts: "5.5",
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("slack:Cxyz:5.5");
  });

  it("ignores bot messages", async () => {
    const result = await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          text: "Bot msg",
          channel: "C1",
          ts: "1.0",
          bot_id: "B123",
        },
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(0);
  });

  it("sends reply via Slack API", async () => {
    await call("channel::slack::events", {
      body: {
        type: "event_callback",
        event: { type: "message", text: "Hi", channel: "C-reply", ts: "2.0" },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 500 when signing secret not configured", async () => {
    process.env.SLACK_SIGNING_SECRET = ""; // override beforeEach
    const result = await call("channel::slack::events", {
      body: { type: "event_callback", event: { type: "other" } },
    });
    expect(result.status_code).toBe(500);
    expect(result.body.error).toContain("SLACK_SIGNING_SECRET");
  });

  it("returns 200 for non-message events with signing secret", async () => {
    const result = await call("channel::slack::events", {
      body: { type: "event_callback", event: { type: "reaction_added" } },
    });
    expect(result.status_code).toBe(200);
  });

  it("handles missing event object with signing secret", async () => {
    const result = await call("channel::slack::events", {
      body: { type: "event_callback" },
    });
    expect(result.status_code).toBe(200);
  });
});

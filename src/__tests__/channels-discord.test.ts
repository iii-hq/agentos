// @ts-nocheck
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "agent::chat") return { content: "Discord reply" };
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => { handlers[config.id] = handler; },
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
    for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
    if (fnId === "agent::chat") return { content: "Discord reply" };
    return null;
  });
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
});

beforeAll(async () => {
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";
  await import("../channels/discord.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::discord::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::discord::webhook"]).toBeDefined();
  });

  it("handles MESSAGE_CREATE event", async () => {
    const result = await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Hello Discord", channel_id: "ch-1", author: { id: "u1", bot: false } },
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("routes message to agent::chat", async () => {
    await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Test msg", channel_id: "ch-2", author: { id: "u2" } },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toBe("Test msg");
  });

  it("sets session ID with discord prefix", async () => {
    await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Sess", channel_id: "ch-sess", author: { id: "u3" } },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].sessionId).toBe("discord:ch-sess");
  });

  it("ignores bot messages", async () => {
    const result = await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Bot msg", channel_id: "ch-3", author: { id: "b1", bot: true } },
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("ignores non-MESSAGE_CREATE events", async () => {
    const result = await call("channel::discord::webhook", {
      body: { t: "GUILD_CREATE", d: {} },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("sends reply via Discord API", async () => {
    await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Ping", channel_id: "ch-reply", author: { id: "u4" } },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("discord.com/api/v10/channels/ch-reply/messages"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends Bot token in authorization header", async () => {
    await call("channel::discord::webhook", {
      body: {
        t: "MESSAGE_CREATE",
        d: { content: "Auth", channel_id: "ch-auth", author: { id: "u5" } },
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers.Authorization).toBe("Bot test-discord-token");
  });

  it("handles missing author gracefully", async () => {
    const result = await call("channel::discord::webhook", {
      body: { t: "MESSAGE_CREATE", d: { content: "No author", channel_id: "ch-x" } },
    });
    expect(result.status_code).toBe(200);
  });

  it("handles event with req.body wrapper", async () => {
    const result = await call("channel::discord::webhook", {
      body: { t: "TYPING_START", d: {} },
    });
    expect(result.status_code).toBe(200);
  });
});

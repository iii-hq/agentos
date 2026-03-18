// @ts-nocheck
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "agent::chat") return { content: "Telegram reply" };
  if (fnId === "vault::get" && data?.key === "TELEGRAM_SECRET_TOKEN")
    return { value: "test-secret" };
  if (fnId === "vault::get" && data?.key === "TELEGRAM_BOT_TOKEN")
    return { value: "test-tg-token" };
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
  splitMessage: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit)
      chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  TriggerAction: { Void: () => ({}) },
  resolveAgent: vi.fn(async () => "default-agent"),
  verifyTelegramUpdate: vi.fn(() => true),
}));

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "agent::chat") return { content: "Telegram reply" };
      if (fnId === "vault::get" && data?.key === "TELEGRAM_SECRET_TOKEN")
        return { value: "test-secret" };
      if (fnId === "vault::get" && data?.key === "TELEGRAM_BOT_TOKEN")
        return { value: "test-tg-token" };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
});

beforeAll(async () => {
  await import("../channels/telegram.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::telegram::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::telegram::webhook"]).toBeDefined();
  });

  it("processes message update", async () => {
    const result = await call("channel::telegram::webhook", {
      body: {
        message: { text: "Hello TG", chat: { id: 12345 }, from: { id: 1 } },
      },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("routes to agent::chat", async () => {
    await call("channel::telegram::webhook", {
      body: {
        message: { text: "Test", chat: { id: 999 }, from: { id: 2 } },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toBe("Test");
  });

  it("uses chat ID for session", async () => {
    await call("channel::telegram::webhook", {
      body: {
        message: { text: "Session", chat: { id: 555 }, from: { id: 3 } },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("telegram:555");
  });

  it("handles edited_message", async () => {
    const result = await call("channel::telegram::webhook", {
      body: {
        edited_message: {
          text: "Edited msg",
          chat: { id: 777 },
          from: { id: 4 },
        },
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
  });

  it("ignores updates without text", async () => {
    const result = await call("channel::telegram::webhook", {
      body: {
        message: { photo: [], chat: { id: 111 }, from: { id: 5 } },
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(0);
  });

  it("ignores updates without message", async () => {
    const result = await call("channel::telegram::webhook", {
      body: { callback_query: { id: "cb1" } },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(0);
  });

  it("sends reply via Telegram API", async () => {
    await call("channel::telegram::webhook", {
      body: {
        message: { text: "Reply", chat: { id: 222 }, from: { id: 6 } },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/sendMessage"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends with Markdown parse_mode", async () => {
    await call("channel::telegram::webhook", {
      body: {
        message: { text: "MD", chat: { id: 333 }, from: { id: 7 } },
      },
    });
    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.parse_mode).toBe("Markdown");
    expect(body.chat_id).toBe(333);
  });

  it("audits channel message", async () => {
    await call("channel::telegram::webhook", {
      body: {
        message: { text: "Audit", chat: { id: 444 }, from: { id: 8 } },
      },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "security::audit",
    );
    expect(auditCalls.some((c) => c[1].type === "channel_message")).toBe(true);
    expect(auditCalls.some((c) => c[1].detail.channel === "telegram")).toBe(
      true,
    );
  });

  it("returns 401 when signature verification fails", async () => {
    const { verifyTelegramUpdate } = await import("../shared/utils.js");
    (verifyTelegramUpdate as any).mockReturnValue(false);
    const result = await call("channel::telegram::webhook", {
      body: {
        message: { text: "Bad sig", chat: { id: 123 }, from: { id: 9 } },
      },
    });
    expect(result.status_code).toBe(401);
    (verifyTelegramUpdate as any).mockReturnValue(true);
  });

  it("returns 401 when secret token is missing", async () => {
    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "agent::chat") return { content: "Telegram reply" };
        if (fnId === "vault::get" && data?.key === "TELEGRAM_SECRET_TOKEN")
          return { value: "" };
        if (fnId === "vault::get" && data?.key === "TELEGRAM_BOT_TOKEN")
          return { value: "test-tg-token" };
        return null;
      },
    );
    const result = await call("channel::telegram::webhook", {
      body: {
        message: { text: "No secret", chat: { id: 456 }, from: { id: 10 } },
      },
    });
    expect(result.status_code).toBe(401);
  });
});

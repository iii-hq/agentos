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

vi.mock("@agentos/shared/utils", () => ({
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
  process.env.WHATSAPP_TOKEN = "test-wa-token";
  process.env.WHATSAPP_PHONE_ID = "123456";
  process.env.SIGNAL_API_URL = "http://signal-api:8080";
  process.env.SIGNAL_PHONE = "+1234567890";
  await import("../channels/whatsapp.js");
  await import("../channels/signal.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::whatsapp::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::whatsapp::webhook"]).toBeDefined();
  });

  it("ignores non-whatsapp_business_account objects", async () => {
    const result = await call("channel::whatsapp::webhook", {
      body: { object: "page" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("ignores messages without text body", async () => {
    const result = await call("channel::whatsapp::webhook", {
      body: {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ value: { messages: [{ from: "+1" }] } }] }],
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes valid text message", async () => {
    const result = await call("channel::whatsapp::webhook", {
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { from: "+15551234567", text: { body: "Hello WA" } },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes message to agent::chat", async () => {
    await call("channel::whatsapp::webhook", {
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "+100", text: { body: "WA msg" } }],
                },
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
    expect(chatCalls[0][1].message).toBe("WA msg");
    expect(chatCalls[0][1].sessionId).toBe("whatsapp:+100");
  });

  it("sends reply via WhatsApp API", async () => {
    await call("channel::whatsapp::webhook", {
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "+200", text: { body: "Test" } }],
                },
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

  it("emits audit event", async () => {
    await call("channel::whatsapp::webhook", {
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "+300", text: { body: "Audit" } }],
                },
              },
            ],
          },
        ],
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "channel_message" }),
    );
  });

  it("ignores missing entry array", async () => {
    const result = await call("channel::whatsapp::webhook", {
      body: { object: "whatsapp_business_account" },
    });
    expect(result.status_code).toBe(200);
  });

  it("ignores empty changes array", async () => {
    const result = await call("channel::whatsapp::webhook", {
      body: { object: "whatsapp_business_account", entry: [{ changes: [] }] },
    });
    expect(result.status_code).toBe(200);
  });
});

describe("channel::signal::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::signal::webhook"]).toBeDefined();
  });

  it("ignores messages without dataMessage", async () => {
    const result = await call("channel::signal::webhook", {
      body: { envelope: {} },
    });
    expect(result.status_code).toBe(200);
  });

  it("ignores messages without text content", async () => {
    const result = await call("channel::signal::webhook", {
      body: { envelope: { dataMessage: {} } },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes direct message", async () => {
    const result = await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+15550001111",
          dataMessage: { message: "Hello Signal" },
        },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with signal session", async () => {
    await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+15559998888",
          dataMessage: { message: "Signal test" },
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].sessionId).toBe("signal:+15559998888");
  });

  it("uses groupId for session when available", async () => {
    await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+1555",
          dataMessage: {
            message: "Group msg",
            groupInfo: { groupId: "grp-123" },
          },
        },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("signal:grp-123");
  });

  it("sends reply via Signal API", async () => {
    await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+1000",
          dataMessage: { message: "Reply test" },
        },
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v2/send"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends group reply with group_id", async () => {
    await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+2000",
          dataMessage: {
            message: "Group reply",
            groupInfo: { groupId: "g-abc" },
          },
        },
      },
    });
    const fetchBody = JSON.parse(
      (mockFetch.mock.calls[0] as any[])[1].body as string,
    );
    expect(fetchBody.group_id).toBe("g-abc");
  });

  it("emits audit event for signal messages", async () => {
    await call("channel::signal::webhook", {
      body: {
        envelope: {
          source: "+3000",
          dataMessage: { message: "Audit signal" },
        },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "signal" }),
      }),
    );
  });
});

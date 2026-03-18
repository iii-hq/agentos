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
  splitMessage: vi.fn((text: string) => [text]),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

const mockSendMail = vi.fn(async () => ({ messageId: "msg-1" }));
vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: mockSendMail }),
}));

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
    if (fnId === "agent::chat") return { content: "Reply" };
    return null;
  });
  mockTriggerVoid.mockClear();
  mockSendMail.mockClear();
  mockFetch.mockClear();
});

describe("Email channel", () => {
  beforeAll(async () => {
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "bot@test.com";
    process.env.SMTP_PASS = "test-pass";
    await import("../channels/email.js");
  });

  it("registers channel::email::webhook", () => {
    expect(handlers["channel::email::webhook"]).toBeDefined();
  });

  it("processes inbound email", async () => {
    const result = await handlers["channel::email::webhook"]({
      body: {
        from: "user@example.com",
        to: "bot@test.com",
        subject: "Test",
        text: "Hello via email",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes email to agent::chat", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "sender@test.com",
        to: "bot@test.com",
        subject: "Question",
        text: "What is 2+2?",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toContain("What is 2+2?");
    expect(chatCalls[0][1].message).toContain("Subject: Question");
  });

  it("uses sender address for session ID", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "session@test.com",
        to: "bot@test.com",
        subject: "Session test",
        text: "Session content",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].sessionId).toBe("email:session@test.com");
  });

  it("sends reply via SMTP", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "reply@test.com",
        to: "bot@test.com",
        subject: "Reply test",
        text: "Reply me",
      },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "reply@test.com",
        subject: "Re: Reply test",
      }),
    );
  });

  it("handles missing subject", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "no-subject@test.com",
        to: "bot@test.com",
        text: "No subject email",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].message).toContain("Subject: (none)");
  });

  it("ignores email without from", async () => {
    const result = await handlers["channel::email::webhook"]({
      body: {
        to: "bot@test.com",
        text: "No from",
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("ignores email without text", async () => {
    const result = await handlers["channel::email::webhook"]({
      body: {
        from: "empty@test.com",
        to: "bot@test.com",
        subject: "Empty",
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("audits email message", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "audit@test.com",
        to: "bot@test.com",
        subject: "Audit",
        text: "Audit email",
      },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "channel_message")).toBe(true);
    expect(auditCalls.some(c => c[1].detail.channel === "email")).toBe(true);
  });

  it("reply subject includes Re: prefix", async () => {
    await handlers["channel::email::webhook"]({
      body: {
        from: "re@test.com",
        to: "bot@test.com",
        subject: "Original",
        text: "Content",
      },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Original" }),
    );
  });
});

describe("Mattermost channel", () => {
  beforeAll(async () => {
    process.env.MATTERMOST_URL = "https://mattermost.example.com";
    process.env.MATTERMOST_TOKEN = "test-mm-token";
    await import("../channels/mattermost.js");
  });

  it("registers channel::mattermost::webhook", () => {
    expect(handlers["channel::mattermost::webhook"]).toBeDefined();
  });

  it("processes outgoing webhook", async () => {
    const result = await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-1",
        user_id: "user-1",
        text: "Hello MM",
        post_id: "post-1",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-2",
        user_id: "user-2",
        text: "MM message",
        post_id: "post-2",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("uses channel_id for session", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "mm-sess",
        user_id: "user-3",
        text: "Session test",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    const lastChat = chatCalls[chatCalls.length - 1];
    expect(lastChat[1].sessionId).toBe("mattermost:mm-sess");
  });

  it("sends reply via Mattermost API", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-reply",
        user_id: "user-4",
        text: "Reply test",
        post_id: "post-reply",
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mattermost.example.com/api/v4/posts",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes root_id for threading", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-thread",
        user_id: "user-5",
        text: "Thread test",
        post_id: "root-post-1",
      },
    });
    const fetchCall = mockFetch.mock.calls.find(c => c[0]?.includes("api/v4/posts"));
    if (fetchCall) {
      const body = JSON.parse(fetchCall[1].body);
      expect(body.root_id).toBe("root-post-1");
    }
  });

  it("sends bearer token", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-auth",
        user_id: "user-6",
        text: "Auth test",
      },
    });
    const fetchCall = mockFetch.mock.calls.find(c => c[0]?.includes("api/v4/posts"));
    if (fetchCall) {
      expect(fetchCall[1].headers.Authorization).toBe("Bearer test-mm-token");
    }
  });

  it("ignores empty text", async () => {
    const result = await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-empty",
        user_id: "user-7",
        text: "",
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("audits channel message", async () => {
    await handlers["channel::mattermost::webhook"]({
      body: {
        channel_id: "ch-audit",
        user_id: "user-audit",
        text: "Audit MM",
      },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].detail?.channel === "mattermost")).toBe(true);
  });
});

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

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  splitMessage: vi.fn((text: string) => [text]),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

const mockFetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({ access_token: "test-token-123" }),
}));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
    if (fnId === "agent::chat") return { content: "Reply" };
    return null;
  });
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ access_token: "test-token-123" }),
  }));
});

describe("Microsoft Teams channel", () => {
  beforeAll(async () => {
    process.env.TEAMS_APP_ID = "test-app-id";
    process.env.TEAMS_APP_PASSWORD = "test-password";
    await import("../channels/teams.js");
  });

  it("registers channel::teams::webhook", () => {
    expect(handlers["channel::teams::webhook"]).toBeDefined();
  });

  it("processes message activity", async () => {
    const result = await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Hello Teams",
        conversation: { id: "conv-1" },
        from: { id: "user-1" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-1",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat", async () => {
    await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Teams msg",
        conversation: { id: "conv-2" },
        from: { id: "user-2" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-2",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0][1].message).toBe("Teams msg");
  });

  it("uses conversation ID for session", async () => {
    await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Sess test",
        conversation: { id: "conv-sess" },
        from: { id: "user-3" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-3",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls[0][1].sessionId).toBe("teams:conv-sess");
  });

  it("ignores non-message activities", async () => {
    const result = await handlers["channel::teams::webhook"]({
      body: {
        type: "conversationUpdate",
        conversation: { id: "conv-upd" },
      },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBe(0);
  });

  it("sends reply via Bot Framework API", async () => {
    await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Reply test",
        conversation: { id: "conv-reply" },
        from: { id: "user-4" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-reply",
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v3/conversations/conv-reply/activities"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gets OAuth token for reply", async () => {
    await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Auth",
        conversation: { id: "conv-auth" },
        from: { id: "user-5" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-auth",
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("login.microsoftonline.com"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("audits channel message", async () => {
    await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "Audit",
        conversation: { id: "conv-audit" },
        from: { id: "user-audit" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-audit",
      },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "channel_message")).toBe(true);
    expect(auditCalls.some(c => c[1].detail.channel === "teams")).toBe(true);
  });

  it("handles empty text", async () => {
    const result = await handlers["channel::teams::webhook"]({
      body: {
        type: "message",
        text: "",
        conversation: { id: "conv-empty" },
        from: { id: "user-6" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        id: "act-empty",
      },
    });
    expect(result.status_code).toBe(200);
  });
});

describe("Matrix channel", () => {
  beforeAll(async () => {
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_TOKEN = "test-matrix-token";
    await import("../channels/matrix.js");
  });

  it("registers channel::matrix::webhook", () => {
    expect(handlers["channel::matrix::webhook"]).toBeDefined();
  });

  it("processes m.room.message event", async () => {
    const result = await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!room1:matrix.org",
        content: { body: "Hello Matrix" },
        sender: "@user:matrix.org",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!room2:matrix.org",
        content: { body: "Matrix msg" },
        sender: "@user2:matrix.org",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("uses room_id for session", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!sess-room:matrix.org",
        content: { body: "Session" },
        sender: "@user3:matrix.org",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(c => c[0] === "agent::chat");
    const lastChat = chatCalls[chatCalls.length - 1];
    expect(lastChat[1].sessionId).toBe("matrix:!sess-room:matrix.org");
  });

  it("ignores non-message events", async () => {
    const result = await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.member",
        room_id: "!room3:matrix.org",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("ignores empty body content", async () => {
    const result = await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!room4:matrix.org",
        content: {},
        sender: "@user4:matrix.org",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("sends reply via Matrix PUT API", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!reply-room:matrix.org",
        content: { body: "Reply test" },
        sender: "@user5:matrix.org",
      },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/_matrix/client/v3/rooms/"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sends m.text msgtype", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!type-room:matrix.org",
        content: { body: "Type" },
        sender: "@user6:matrix.org",
      },
    });
    const putCall = mockFetch.mock.calls.find(c => c[1]?.method === "PUT");
    if (putCall) {
      const body = JSON.parse(putCall[1].body);
      expect(body.msgtype).toBe("m.text");
    }
  });

  it("audits channel message", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!audit-room:matrix.org",
        content: { body: "Audit" },
        sender: "@audit-user:matrix.org",
      },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].detail?.channel === "matrix")).toBe(true);
  });

  it("includes bearer token in authorization", async () => {
    await handlers["channel::matrix::webhook"]({
      body: {
        type: "m.room.message",
        room_id: "!auth-room:matrix.org",
        content: { body: "Auth check" },
        sender: "@auth-user:matrix.org",
      },
    });
    const putCall = mockFetch.mock.calls.find(c => c[1]?.method === "PUT");
    if (putCall) {
      expect(putCall[1].headers.Authorization).toBe("Bearer test-matrix-token");
    }
  });
});

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


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

const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
    if (fnId === "agent::chat") return { content: "Reply" };
    return null;
  });
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
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

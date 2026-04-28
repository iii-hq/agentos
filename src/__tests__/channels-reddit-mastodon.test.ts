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
  json: async () => ({ access_token: "test-token", id: "status-1" }),
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
    json: async () => ({ access_token: "test-token", id: "status-1" }),
  }));
});

beforeAll(async () => {
  process.env.REDDIT_CLIENT_ID = "test-client";
  process.env.REDDIT_SECRET = "test-secret";
  process.env.REDDIT_REFRESH_TOKEN = "test-refresh";
  process.env.MASTODON_INSTANCE = "https://mastodon.social";
  process.env.MASTODON_TOKEN = "test-masto-token";
  await import("../channels/reddit.js");
  await import("../channels/mastodon.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::reddit::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::reddit::webhook"]).toBeDefined();
  });

  it("ignores messages without text", async () => {
    const result = await call("channel::reddit::webhook", {
      body: { subreddit: "test", author: "user1" },
    });
    expect(result.status_code).toBe(200);
  });

  it("ignores deleted author", async () => {
    const result = await call("channel::reddit::webhook", {
      body: { subreddit: "test", author: "[deleted]", body: "deleted msg" },
    });
    expect(result.status_code).toBe(200);
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBe(0);
  });

  it("processes valid reddit comment", async () => {
    const result = await call("channel::reddit::webhook", {
      body: {
        subreddit: "programming",
        author: "user2",
        body: "Interesting post",
        name: "t1_abc123",
        link_id: "t3_xyz",
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("routes to agent::chat with reddit session using link_id", async () => {
    await call("channel::reddit::webhook", {
      body: {
        subreddit: "ai",
        author: "user3",
        body: "Reddit msg",
        name: "t1_comment",
        link_id: "t3_post123",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("reddit:t3_post123");
  });

  it("uses name as fallback session when no link_id", async () => {
    await call("channel::reddit::webhook", {
      body: {
        subreddit: "test",
        author: "user4",
        body: "No link",
        name: "t1_fallback",
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("reddit:t1_fallback");
  });

  it("calls Reddit API endpoints", async () => {
    await call("channel::reddit::webhook", {
      body: {
        subreddit: "test",
        author: "user5",
        body: "OAuth test",
        name: "t1_oauth",
      },
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  it("sends reply as reddit comment", async () => {
    await call("channel::reddit::webhook", {
      body: {
        subreddit: "test",
        author: "user6",
        body: "Reply test",
        name: "t1_reply",
      },
    });
    const commentCalls = mockFetch.mock.calls.filter((c) =>
      (c[0] as string).includes("api/comment"),
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("emits audit event", async () => {
    await call("channel::reddit::webhook", {
      body: {
        subreddit: "devops",
        author: "user7",
        body: "Audit",
        name: "t1_audit",
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "reddit" }),
      }),
    );
  });
});

describe("channel::mastodon::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::mastodon::webhook"]).toBeDefined();
  });

  it("ignores messages without status content", async () => {
    const result = await call("channel::mastodon::webhook", {
      body: { account: { acct: "user@masto.social" } },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes valid mention", async () => {
    const result = await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "tester@masto.social" },
        status: { content: "<p>Hello Mastodon</p>", id: "111222" },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("strips HTML tags from content", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "html@masto.social" },
        status: { content: "<p>Plain <b>text</b> here</p>", id: "333" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("Plain text here");
  });

  it("routes to agent::chat with mastodon session", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "session@masto.social" },
        status: { content: "<p>Session test</p>", id: "444" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("mastodon:session@masto.social");
  });

  it("uses account.id as fallback for session", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { id: "12345" },
        status: { content: "<p>ID fallback</p>", id: "555" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("mastodon:12345");
  });

  it("sends reply as mastodon status", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "reply@masto.social" },
        status: { content: "<p>Reply</p>", id: "666" },
      },
    });
    const statusCalls = mockFetch.mock.calls.filter(
      (c) =>
        (c[0] as string).includes("api/v1/statuses") &&
        (c[1] as any)?.method === "POST",
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sends reply as reply to original status", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "thread@masto.social" },
        status: { content: "<p>Thread reply</p>", id: "777" },
      },
    });
    const body = JSON.parse(
      mockFetch.mock.calls.find(
        (c) =>
          (c[1] as any)?.method === "POST" &&
          (c[0] as string).includes("statuses"),
      )?.[1]?.body as string,
    );
    expect(body.in_reply_to_id).toBe("777");
  });

  it("emits audit event", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "audit@masto.social" },
        status: { content: "<p>Audit</p>", id: "888" },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "mastodon" }),
      }),
    );
  });
});

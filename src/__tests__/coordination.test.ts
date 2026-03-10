import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}
function seedKv(scope: string, key: string, value: unknown) {
  getScope(scope).set(key, value);
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  sanitizeId: (id: string) => {
    if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id))
      throw new Error(`Invalid ID: ${id}`);
    return id;
  },
}));

vi.mock("../shared/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../shared/metrics.js", () => ({
  createRecordMetric: () => vi.fn(),
}));

vi.mock("../shared/errors.js", () => ({
  safeCall: async (fn: Function, fallback: any, _context?: any) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../coordination.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("coord::create_channel", () => {
  it("creates a channel", async () => {
    const result = await call(
      "coord::create_channel",
      authReq({ name: "planning", agentId: "agent-1", topic: "Sprint goals" }),
    );
    expect(result.channelId).toBeDefined();
    expect(result.name).toBe("planning");

    const stored: any = getScope("coord_channels").get(result.channelId);
    expect(stored.topic).toBe("Sprint goals");
    expect(stored.createdBy).toBe("agent-1");
    expect(stored.pinned).toEqual([]);
  });

  it("rejects missing name", async () => {
    await expect(
      call("coord::create_channel", authReq({ agentId: "agent-1" })),
    ).rejects.toThrow("name and agentId are required");
  });

  it("rejects missing agentId", async () => {
    await expect(
      call("coord::create_channel", authReq({ name: "test" })),
    ).rejects.toThrow("name and agentId are required");
  });
});

describe("coord::post", () => {
  const channelId = "ch-1";

  beforeEach(() => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "general",
      topic: "",
      createdBy: "agent-1",
      createdAt: Date.now(),
      pinned: [],
    });
  });

  it("posts a message to channel", async () => {
    const result = await call("coord::post", {
      channelId,
      agentId: "agent-1",
      content: "Hello team",
    });
    expect(result.postId).toBeDefined();
    expect(result.channelId).toBe(channelId);

    const posts = [...getScope(`coord_posts:${channelId}`).values()] as any[];
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toBe("Hello team");
    expect(posts[0].parentId).toBeUndefined();
  });

  it("rejects post to nonexistent channel", async () => {
    await expect(
      call("coord::post", {
        channelId: "nope",
        agentId: "agent-1",
        content: "hello",
      }),
    ).rejects.toThrow("Channel not found");
  });

  it("rejects missing fields", async () => {
    await expect(
      call("coord::post", { channelId }),
    ).rejects.toThrow("channelId, agentId, and content are required");
  });

  it("rejects when channel reaches post limit", async () => {
    for (let i = 0; i < 1000; i++) {
      seedKv(`coord_posts:${channelId}`, `post-${i}`, {
        id: `post-${i}`,
        channelId,
        agentId: "agent-1",
        content: `msg ${i}`,
        createdAt: i,
      });
    }

    await expect(
      call("coord::post", {
        channelId,
        agentId: "agent-1",
        content: "one too many",
      }),
    ).rejects.toThrow("Channel has reached the post limit");
  });
});

describe("coord::reply", () => {
  const channelId = "ch-reply";

  beforeEach(() => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "threads",
      topic: "",
      createdBy: "agent-1",
      createdAt: Date.now(),
      pinned: [],
    });
    seedKv(`coord_posts:${channelId}`, "post-1", {
      id: "post-1",
      channelId,
      agentId: "agent-1",
      content: "Original post",
      createdAt: 1000,
    });
  });

  it("creates a threaded reply", async () => {
    const result = await call("coord::reply", {
      channelId,
      parentId: "post-1",
      agentId: "agent-2",
      content: "I agree",
    });
    expect(result.postId).toBeDefined();
    expect(result.parentId).toBe("post-1");
    expect(result.channelId).toBe(channelId);

    const reply: any = getScope(`coord_posts:${channelId}`).get(result.postId);
    expect(reply.parentId).toBe("post-1");
    expect(reply.content).toBe("I agree");
  });

  it("rejects reply to nonexistent parent", async () => {
    await expect(
      call("coord::reply", {
        channelId,
        parentId: "ghost",
        agentId: "agent-2",
        content: "reply",
      }),
    ).rejects.toThrow("Parent post not found");
  });

  it("rejects missing fields", async () => {
    await expect(
      call("coord::reply", { channelId, agentId: "agent-2" }),
    ).rejects.toThrow("channelId, parentId, agentId, and content are required");
  });
});

describe("coord::list_channels", () => {
  it("returns all channels sorted by recency", async () => {
    seedKv("coord_channels", "ch-a", {
      id: "ch-a",
      name: "alpha",
      createdAt: 1000,
    });
    seedKv("coord_channels", "ch-b", {
      id: "ch-b",
      name: "beta",
      createdAt: 2000,
    });

    const result = await call("coord::list_channels", authReq({}));
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("beta");
    expect(result[1].name).toBe("alpha");
  });

  it("returns empty when no channels", async () => {
    const result = await call("coord::list_channels", authReq({}));
    expect(result).toHaveLength(0);
  });
});

describe("coord::read", () => {
  const channelId = "ch-read";

  beforeEach(() => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "readable",
      createdAt: Date.now(),
    });
    seedKv(`coord_posts:${channelId}`, "p1", {
      id: "p1",
      channelId,
      agentId: "agent-1",
      content: "First",
      createdAt: 1000,
    });
    seedKv(`coord_posts:${channelId}`, "p2", {
      id: "p2",
      channelId,
      agentId: "agent-2",
      content: "Second",
      createdAt: 2000,
    });
    seedKv(`coord_posts:${channelId}`, "p3", {
      id: "p3",
      channelId,
      agentId: "agent-1",
      content: "Reply to First",
      parentId: "p1",
      createdAt: 3000,
    });
  });

  it("reads all posts in chronological order", async () => {
    const result = await call(
      "coord::read",
      authReq({ channelId }),
    );
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("First");
    expect(result[2].content).toBe("Reply to First");
  });

  it("filters by threadId", async () => {
    const result = await call(
      "coord::read",
      authReq({ channelId, threadId: "p1" }),
    );
    expect(result).toHaveLength(2);
    const contents = result.map((p: any) => p.content);
    expect(contents).toContain("First");
    expect(contents).toContain("Reply to First");
  });

  it("respects limit", async () => {
    const result = await call(
      "coord::read",
      authReq({ channelId, limit: 1 }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Reply to First");
  });

  it("rejects missing channelId", async () => {
    await expect(
      call("coord::read", authReq({})),
    ).rejects.toThrow("channelId is required");
  });
});

describe("coord::pin", () => {
  const channelId = "ch-pin";

  beforeEach(() => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "pinnable",
      createdAt: Date.now(),
      pinned: [],
    });
    seedKv(`coord_posts:${channelId}`, "pin-post", {
      id: "pin-post",
      channelId,
      agentId: "agent-1",
      content: "Important",
      createdAt: 1000,
    });
  });

  it("pins a post", async () => {
    const result = await call(
      "coord::pin",
      authReq({ channelId, postId: "pin-post" }),
    );
    expect(result.pinned).toContain("pin-post");

    const ch: any = getScope("coord_channels").get(channelId);
    expect(ch.pinned).toContain("pin-post");
  });

  it("unpins a post", async () => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "pinnable",
      createdAt: Date.now(),
      pinned: ["pin-post"],
    });

    const result = await call(
      "coord::pin",
      authReq({ channelId, postId: "pin-post", unpin: true }),
    );
    expect(result.pinned).not.toContain("pin-post");
  });

  it("is idempotent for already pinned post", async () => {
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "pinnable",
      createdAt: Date.now(),
      pinned: ["pin-post"],
    });

    const result = await call(
      "coord::pin",
      authReq({ channelId, postId: "pin-post" }),
    );
    expect(result.pinned).toEqual(["pin-post"]);
  });

  it("rejects pinning nonexistent post", async () => {
    await expect(
      call("coord::pin", authReq({ channelId, postId: "ghost" })),
    ).rejects.toThrow("Post not found");
  });

  it("rejects pin in nonexistent channel", async () => {
    await expect(
      call("coord::pin", authReq({ channelId: "nope", postId: "pin-post" })),
    ).rejects.toThrow("Channel not found");
  });

  it("rejects missing fields", async () => {
    await expect(
      call("coord::pin", authReq({ channelId })),
    ).rejects.toThrow("channelId and postId are required");
  });

  it("rejects pin when max pinned reached", async () => {
    const pinnedIds = Array.from({ length: 25 }, (_, i) => `pin-${i}`);
    seedKv("coord_channels", channelId, {
      id: channelId,
      name: "pinnable",
      createdAt: Date.now(),
      pinned: pinnedIds,
    });
    seedKv(`coord_posts:${channelId}`, "new-post", {
      id: "new-post",
      channelId,
      agentId: "agent-1",
      content: "26th pin attempt",
      createdAt: 9999,
    });

    await expect(
      call("coord::pin", authReq({ channelId, postId: "new-post" })),
    ).rejects.toThrow("Maximum 25 pinned posts per channel");
  });
});

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { createHash } from "crypto";

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
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "merge") {
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
      } else if (op.type === "set") {
        current[op.path] = op.value;
      } else if (op.type === "increment") {
        current[op.path] = (current[op.path] || 0) + op.value;
      }
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "memory::embed") {
    const words = data.text.toLowerCase().split(/\s+/);
    const dim = 128;
    const vec = new Array(dim).fill(0);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < dim; i++) {
        vec[i] += Math.sin(hash * (i + 1)) / words.length;
      }
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return norm > 0 ? vec.map((v: number) => v / norm) : vec;
  }
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
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("@agentos/shared/config", () => ({
  ENGINE_URL: "ws://localhost:3111",
  OTEL_CONFIG: {},
  registerShutdown: vi.fn(),
}));
vi.mock("@agentos/shared/metrics", () => ({
  recordMetric: vi.fn(),
}));
vi.mock("@agentos/shared/errors", () => ({
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
  await import("../memory.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("memory::store - SHA256 dedup", () => {
  it("stores a new memory entry", async () => {
    const result = await call("memory::store", {
      agentId: "a1",
      content: "Hello world",
      role: "user",
    });
    expect(result.stored).toBe(true);
    expect(result.id).toBeDefined();
  });

  it("deduplicates identical content", async () => {
    const r1 = await call("memory::store", {
      agentId: "a1",
      content: "duplicate content here",
      role: "user",
    });
    const r2 = await call("memory::store", {
      agentId: "a1",
      content: "duplicate content here",
      role: "user",
    });
    expect(r2.deduplicated).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  it("stores different content as separate entries", async () => {
    const r1 = await call("memory::store", {
      agentId: "a1",
      content: "content A",
      role: "user",
    });
    const r2 = await call("memory::store", {
      agentId: "a1",
      content: "content B",
      role: "user",
    });
    expect(r2.stored).toBe(true);
    expect(r2.id).not.toBe(r1.id);
  });

  it("uses SHA256 hash (first 16 hex chars) for dedup key", async () => {
    const content = "test content";
    const expectedHash = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);
    await call("memory::store", {
      agentId: "a1",
      content,
      role: "user",
    });
    const entry = getScope("memory:a1").get(expectedHash);
    expect(entry).toBeDefined();
  });

  it("scopes dedup by agentId", async () => {
    const r1 = await call("memory::store", {
      agentId: "a1",
      content: "same content",
      role: "user",
    });
    const r2 = await call("memory::store", {
      agentId: "a2",
      content: "same content",
      role: "user",
    });
    expect(r1.stored).toBe(true);
    expect(r2.stored).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });

  it("assigns session messages when sessionId provided", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "session entry",
      role: "user",
      sessionId: "s1",
    });
    const session = getScope("sessions:a1").get("s1") as any;
    expect(session.messages).toBeDefined();
    expect(session.messages.length).toBe(1);
  });

  it("tracks token usage when provided", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "with tokens",
      role: "assistant",
      sessionId: "s1",
      tokenUsage: { total: 500 },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "state::update",
      expect.objectContaining({
        scope: "sessions:a1",
        key: "s1",
        operations: expect.arrayContaining([
          expect.objectContaining({
            type: "increment",
            path: "totalTokens",
            value: 500,
          }),
        ]),
      }),
    );
  });
});

describe("memory::store - importance estimation", () => {
  it("gives higher importance to assistant messages", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "short msg",
      role: "assistant",
    });
    const entries = [...getScope("memory:a1").values()] as any[];
    const entry = entries.find((e) => e.content === "short msg");
    expect(entry.importance).toBeGreaterThan(0.5);
  });

  it("gives higher importance to long content", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "x".repeat(600),
      role: "user",
    });
    const entries = [...getScope("memory:a1").values()] as any[];
    const entry = entries.find((e) => e.content?.length === 600);
    expect(entry.importance).toBeGreaterThanOrEqual(0.6);
  });

  it("boosts importance for error-related content", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "There was a critical error in the system",
      role: "user",
    });
    const entries = [...getScope("memory:a1").values()] as any[];
    const entry = entries.find((e) => e.content?.includes("critical error"));
    expect(entry.importance).toBeGreaterThanOrEqual(0.65);
  });

  it("boosts importance for code blocks", async () => {
    await call("memory::store", {
      agentId: "a1",
      content: "```\nconst x = 1;\n```",
      role: "user",
    });
    const entries = [...getScope("memory:a1").values()] as any[];
    const entry = entries.find((e) => e.content?.includes("```"));
    expect(entry.importance).toBeGreaterThanOrEqual(0.6);
  });

  it("caps importance at 1.0", async () => {
    await call("memory::store", {
      agentId: "a1",
      content:
        "```\n" +
        "x".repeat(600) +
        "\n```\nThis is a critical error bug fix important",
      role: "assistant",
    });
    const entries = [...getScope("memory:a1").values()] as any[];
    const entry = entries.find(
      (e) => e.role === "assistant" && e.content?.includes("critical"),
    );
    expect(entry.importance).toBeLessThanOrEqual(1);
  });
});

describe("memory::recall - scoring weights", () => {
  it("returns empty array when no memories exist", async () => {
    const result = await call("memory::recall", {
      agentId: "empty",
      query: "test",
    });
    expect(result).toEqual([]);
  });

  it("returns scored results sorted by relevance", async () => {
    await call("memory::store", {
      agentId: "a2",
      content: "React component lifecycle methods",
      role: "user",
    });
    await call("memory::store", {
      agentId: "a2",
      content: "How to deploy to AWS Lambda",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "a2",
      query: "React lifecycle",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("React");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await call("memory::store", {
        agentId: "a3",
        content: `Memory entry ${i}`,
        role: "user",
      });
    }
    const results = await call("memory::recall", {
      agentId: "a3",
      query: "Memory entry",
      limit: 3,
    });
    expect(results.length).toBe(3);
  });

  it("includes keyword match score (0.25 weight)", async () => {
    await call("memory::store", {
      agentId: "a4",
      content: "kubernetes deployment strategy",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "a4",
      query: "kubernetes deployment",
    });
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns content, role, score, and timestamp in results", async () => {
    await call("memory::store", {
      agentId: "a5",
      content: "test result shape",
      role: "assistant",
    });
    const results = await call("memory::recall", {
      agentId: "a5",
      query: "test",
    });
    expect(results[0]).toHaveProperty("content");
    expect(results[0]).toHaveProperty("role");
    expect(results[0]).toHaveProperty("score");
    expect(results[0]).toHaveProperty("timestamp");
  });

  it("defaults limit to 10", async () => {
    for (let i = 0; i < 15; i++) {
      await call("memory::store", {
        agentId: "a6",
        content: `Entry number ${i} unique`,
        role: "user",
      });
    }
    const results = await call("memory::recall", {
      agentId: "a6",
      query: "Entry number",
    });
    expect(results.length).toBe(10);
  });
});

describe("memory::embed", () => {
  it("generates a 128-dimensional vector", async () => {
    const result = await call("memory::embed", { text: "hello world" });
    expect(result).toHaveLength(128);
  });

  it("returns normalized vector (unit length)", async () => {
    const result = await call("memory::embed", { text: "test normalization" });
    const norm = Math.sqrt(
      result.reduce((s: number, v: number) => s + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 3);
  });

  it("produces similar embeddings for similar text", async () => {
    const e1 = await call("memory::embed", { text: "hello world" });
    const e2 = await call("memory::embed", { text: "hello world again" });
    const dot = e1.reduce(
      (s: number, v: number, i: number) => s + v * e2[i],
      0,
    );
    expect(dot).toBeGreaterThan(0.5);
  });
});

describe("memory::kg::add - knowledge graph", () => {
  it("stores an entity", async () => {
    const result = await call("memory::kg::add", {
      agentId: "a1",
      entity: {
        id: "e1",
        name: "Node",
        type: "concept",
        properties: { runtime: "v8" },
        relations: [],
      },
    });
    expect(result.stored).toBe(true);
  });

  it("creates back-references for relations", async () => {
    seedKv("kg:a1", "target-1", {
      id: "target-1",
      name: "Target",
      type: "concept",
      properties: {},
      relations: [],
    });
    await call("memory::kg::add", {
      agentId: "a1",
      entity: {
        id: "source-1",
        name: "Source",
        type: "concept",
        properties: {},
        relations: [{ target: "target-1", type: "depends_on" }],
      },
    });
    const calls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::update" && c[1]?.scope === "kg:a1",
    );
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("memory::kg::query - traversal", () => {
  it("returns entity at depth 1", async () => {
    seedKv("kg:a1", "root", {
      id: "root",
      name: "Root",
      type: "node",
      properties: {},
      relations: [],
    });
    const results = await call("memory::kg::query", {
      agentId: "a1",
      entityId: "root",
      depth: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("root");
  });

  it("traverses related entities at depth 2", async () => {
    seedKv("kg:a1", "n1", {
      id: "n1",
      name: "N1",
      type: "node",
      properties: {},
      relations: [{ target: "n2", type: "link" }],
    });
    seedKv("kg:a1", "n2", {
      id: "n2",
      name: "N2",
      type: "node",
      properties: {},
      relations: [],
    });
    const results = await call("memory::kg::query", {
      agentId: "a1",
      entityId: "n1",
      depth: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("does not revisit already visited nodes", async () => {
    seedKv("kg:a1", "c1", {
      id: "c1",
      name: "C1",
      type: "node",
      properties: {},
      relations: [{ target: "c2", type: "link" }],
    });
    seedKv("kg:a1", "c2", {
      id: "c2",
      name: "C2",
      type: "node",
      properties: {},
      relations: [{ target: "c1", type: "link" }],
    });
    const results = await call("memory::kg::query", {
      agentId: "a1",
      entityId: "c1",
      depth: 5,
    });
    expect(results).toHaveLength(2);
  });

  it("returns empty array for non-existent entity", async () => {
    const results = await call("memory::kg::query", {
      agentId: "a1",
      entityId: "missing",
      depth: 2,
    });
    expect(results).toHaveLength(0);
  });

  it("respects depth limit", async () => {
    seedKv("kg:a1", "d1", {
      id: "d1",
      relations: [{ target: "d2", type: "link" }],
    });
    seedKv("kg:a1", "d2", {
      id: "d2",
      relations: [{ target: "d3", type: "link" }],
    });
    seedKv("kg:a1", "d3", {
      id: "d3",
      relations: [],
    });
    const results = await call("memory::kg::query", {
      agentId: "a1",
      entityId: "d1",
      depth: 1,
    });
    expect(results).toHaveLength(1);
  });
});

describe("memory::evict - eviction rules", () => {
  it("evicts stale AND low-importance entries", async () => {
    const old = Date.now() - 40 * 86_400_000;
    seedKv("memory:a1", "old-low", {
      id: "old-low",
      content: "old and low",
      role: "user",
      timestamp: old,
      importance: 0.1,
      hash: "h1",
    });
    seedKv("memory:a1", "h1", { id: "old-low" });
    const result = await call("memory::evict", { agentId: "a1" });
    expect(result.evicted).toBe(1);
  });

  it("preserves recent low-importance entries", async () => {
    seedKv("memory:a1", "recent-low", {
      id: "recent-low",
      content: "recent but low",
      role: "user",
      timestamp: Date.now() - 1000,
      importance: 0.1,
      hash: "h2",
    });
    const result = await call("memory::evict", { agentId: "a1" });
    expect(result.evicted).toBe(0);
  });

  it("preserves stale high-importance entries", async () => {
    const old = Date.now() - 40 * 86_400_000;
    seedKv("memory:a1", "old-high", {
      id: "old-high",
      content: "old but important",
      role: "user",
      timestamp: old,
      importance: 0.8,
      hash: "h3",
    });
    const result = await call("memory::evict", { agentId: "a1" });
    expect(result.evicted).toBe(0);
  });

  it("enforces cap by removing lowest importance entries", async () => {
    for (let i = 0; i < 5; i++) {
      seedKv("memory:a1", `entry-${i}`, {
        id: `entry-${i}`,
        content: `content ${i}`,
        role: "user",
        timestamp: Date.now(),
        importance: 0.1 + i * 0.1,
        hash: `hash-${i}`,
      });
    }
    const result = await call("memory::evict", {
      agentId: "a1",
      cap: 3,
    });
    expect(result.evicted).toBe(2);
  });

  it("respects custom maxAge parameter", async () => {
    const age = Date.now() - 5 * 86_400_000;
    seedKv("memory:a1", "custom-age", {
      id: "custom-age",
      content: "5 days old",
      role: "user",
      timestamp: age,
      importance: 0.1,
      hash: "h4",
    });
    const result = await call("memory::evict", {
      agentId: "a1",
      maxAge: 3 * 86_400_000,
    });
    expect(result.evicted).toBe(1);
  });

  it("respects custom minImportance parameter", async () => {
    const old = Date.now() - 40 * 86_400_000;
    seedKv("memory:a1", "min-imp", {
      id: "min-imp",
      content: "moderate importance",
      role: "user",
      timestamp: old,
      importance: 0.3,
      hash: "h5",
    });
    const result = await call("memory::evict", {
      agentId: "a1",
      minImportance: 0.5,
    });
    expect(result.evicted).toBe(1);
  });
});

describe("memory::user_profile::update", () => {
  it("creates a new profile", async () => {
    const result = await call("memory::user_profile::update", {
      agentId: "a1",
      updates: { name: "Alice", preferences: { theme: "dark" } },
    });
    expect(result.updated).toBe(true);
    expect(result.profile.name).toBe("Alice");
    expect(result.profile.preferences.theme).toBe("dark");
    expect(result.profile.updatedAt).toBeDefined();
  });

  it("deep-merges objects", async () => {
    seedKv("user:profile:a1", "profile", {
      preferences: { theme: "dark", lang: "en" },
    });
    const result = await call("memory::user_profile::update", {
      agentId: "a1",
      updates: { preferences: { theme: "light" } },
    });
    expect(result.profile.preferences.theme).toBe("light");
    expect(result.profile.preferences.lang).toBe("en");
  });

  it("concatenates arrays", async () => {
    seedKv("user:profile:a1", "profile", {
      skills: ["typescript"],
    });
    const result = await call("memory::user_profile::update", {
      agentId: "a1",
      updates: { skills: ["rust"] },
    });
    expect(result.profile.skills).toEqual(["typescript", "rust"]);
  });

  it("skips null/undefined values", async () => {
    seedKv("user:profile:a1", "profile", { name: "Alice" });
    const result = await call("memory::user_profile::update", {
      agentId: "a1",
      updates: { name: null, age: undefined, role: "dev" },
    });
    expect(result.profile.name).toBe("Alice");
    expect(result.profile.role).toBe("dev");
  });
});

describe("memory::user_profile::get", () => {
  it("returns null for non-existent profile", async () => {
    const result = await call("memory::user_profile::get", {
      agentId: "missing",
    });
    expect(result).toBeNull();
  });

  it("returns stored profile", async () => {
    seedKv("user:profile:a1", "profile", { name: "Bob", updatedAt: 123 });
    const result = await call("memory::user_profile::get", { agentId: "a1" });
    expect(result.name).toBe("Bob");
  });
});

describe("memory::session_search", () => {
  it("returns empty for no matches", async () => {
    const result = await call("memory::session_search", {
      agentId: "a1",
      query: "nonexistent",
    });
    expect(result).toEqual([]);
  });

  it("groups results by sessionId", async () => {
    seedKv("memory:a1", "m1", {
      id: "m1",
      content: "kubernetes deployment config",
      role: "user",
      sessionId: "s1",
      timestamp: Date.now(),
    });
    seedKv("memory:a1", "m2", {
      id: "m2",
      content: "kubernetes pod scaling",
      role: "assistant",
      sessionId: "s1",
      timestamp: Date.now(),
    });
    seedKv("memory:a1", "m3", {
      id: "m3",
      content: "react component design",
      role: "user",
      sessionId: "s2",
      timestamp: Date.now(),
    });

    const result = await call("memory::session_search", {
      agentId: "a1",
      query: "kubernetes",
    });
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s1");
    expect(result[0].matchCount).toBe(2);
  });

  it("returns highlights", async () => {
    seedKv("memory:a1", "m1", {
      id: "m1",
      content: "debugging auth middleware issue",
      role: "user",
      sessionId: "s1",
      timestamp: Date.now(),
    });

    const result = await call("memory::session_search", {
      agentId: "a1",
      query: "auth middleware",
    });
    expect(result[0].highlights.length).toBeGreaterThan(0);
    expect(result[0].highlights[0]).toContain("auth");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      seedKv("memory:a1", `m${i}`, {
        id: `m${i}`,
        content: `test query match ${i}`,
        role: "user",
        sessionId: `s${i}`,
        timestamp: Date.now() - i * 1000,
      });
    }
    const result = await call("memory::session_search", {
      agentId: "a1",
      query: "test query",
      limit: 2,
    });
    expect(result.length).toBe(2);
  });

  it("skips entries without sessionId", async () => {
    seedKv("memory:a1", "m1", {
      id: "m1",
      content: "no session entry",
      role: "user",
      timestamp: Date.now(),
    });
    const result = await call("memory::session_search", {
      agentId: "a1",
      query: "session entry",
    });
    expect(result).toEqual([]);
  });
});

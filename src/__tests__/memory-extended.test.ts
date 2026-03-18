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

describe("memory::store extended", () => {
  it("generates embeddings when available", async () => {
    const result = await call("memory::store", {
      agentId: "emb-agent",
      content: "Embedding content test",
      role: "user",
    });
    expect(result.stored).toBe(true);
    const entries = [...getScope("memory:emb-agent").values()] as any[];
    const entry = entries.find((e) => e.content === "Embedding content test");
    expect(entry.embedding).toBeDefined();
    expect(entry.embedding.length).toBe(128);
  });

  it("stores hash reference for dedup lookup", async () => {
    const content = "dedup lookup test";
    const hash = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);
    const r = await call("memory::store", {
      agentId: "dedup-agent",
      content,
      role: "user",
    });
    const hashEntry = getScope("memory:dedup-agent").get(hash) as any;
    expect(hashEntry.id).toBe(r.id);
  });

  it("accumulates multiple session messages", async () => {
    await call("memory::store", {
      agentId: "multi",
      content: "First",
      role: "user",
      sessionId: "s-multi",
    });
    await call("memory::store", {
      agentId: "multi",
      content: "Second",
      role: "assistant",
      sessionId: "s-multi",
    });
    await call("memory::store", {
      agentId: "multi",
      content: "Third",
      role: "user",
      sessionId: "s-multi",
    });
    const session = getScope("sessions:multi").get("s-multi") as any;
    expect(session.messages.length).toBe(3);
  });

  it("tracks updatedAt on session", async () => {
    const before = Date.now();
    await call("memory::store", {
      agentId: "ts-agent",
      content: "Timestamp test",
      role: "user",
      sessionId: "s-ts",
    });
    const session = getScope("sessions:ts-agent").get("s-ts") as any;
    expect(session.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("uses default session when no sessionId for token tracking", async () => {
    await call("memory::store", {
      agentId: "def-session",
      content: "No session",
      role: "user",
      tokenUsage: { total: 100 },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "state::update",
      expect.objectContaining({
        key: "default",
      }),
    );
  });

  it("handles zero token usage", async () => {
    await call("memory::store", {
      agentId: "zero-tok",
      content: "Zero tokens",
      role: "user",
      sessionId: "s-zero",
      tokenUsage: { total: 0 },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "state::update",
      expect.objectContaining({
        operations: expect.arrayContaining([
          expect.objectContaining({ value: 0 }),
        ]),
      }),
    );
  });
});

describe("memory::recall extended", () => {
  it("scores keyword matches proportionally", async () => {
    await call("memory::store", {
      agentId: "kw-score",
      content: "kubernetes helm chart deployment",
      role: "user",
    });
    await call("memory::store", {
      agentId: "kw-score",
      content: "random unrelated content here",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "kw-score",
      query: "kubernetes deployment",
    });
    expect(results[0].content).toContain("kubernetes");
  });

  it("boosts recently stored memories via recency", async () => {
    seedKv("memory:recency", "old-entry", {
      content: "old matching entry",
      role: "user",
      timestamp: Date.now() - 7 * 24 * 3600 * 1000,
      importance: 0.5,
      hash: "h-old",
    });
    await call("memory::store", {
      agentId: "recency",
      content: "new matching entry",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "recency",
      query: "matching entry",
    });
    expect(results[0].content).toContain("new");
  });

  it("handles single-word query", async () => {
    await call("memory::store", {
      agentId: "single",
      content: "Docker containers orchestration",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "single",
      query: "Docker",
    });
    expect(results.length).toBe(1);
  });

  it("returns results with importance component", async () => {
    await call("memory::store", {
      agentId: "imp-score",
      content: "There was a critical error in production",
      role: "assistant",
    });
    const results = await call("memory::recall", {
      agentId: "imp-score",
      query: "critical error",
    });
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("handles query with no keyword overlap", async () => {
    await call("memory::store", {
      agentId: "no-overlap",
      content: "alpha beta gamma",
      role: "user",
    });
    const results = await call("memory::recall", {
      agentId: "no-overlap",
      query: "delta epsilon zeta",
    });
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });
});

describe("memory::embed extended", () => {
  it("produces deterministic embeddings", async () => {
    const e1 = await call("memory::embed", { text: "reproducible" });
    const e2 = await call("memory::embed", { text: "reproducible" });
    expect(e1).toEqual(e2);
  });

  it("produces different embeddings for different text", async () => {
    const e1 = await call("memory::embed", { text: "cats" });
    const e2 = await call("memory::embed", { text: "dogs" });
    expect(e1).not.toEqual(e2);
  });

  it("handles single word", async () => {
    const result = await call("memory::embed", { text: "hello" });
    expect(result.length).toBe(128);
    const norm = Math.sqrt(
      result.reduce((s: number, v: number) => s + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 3);
  });

  it("handles very long text", async () => {
    const longText = "word ".repeat(1000);
    const result = await call("memory::embed", { text: longText });
    expect(result.length).toBe(128);
    const norm = Math.sqrt(
      result.reduce((s: number, v: number) => s + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 2);
  });
});

describe("memory::kg::add extended", () => {
  it("stores entity properties", async () => {
    await call("memory::kg::add", {
      agentId: "kg-a",
      entity: {
        id: "e-props",
        name: "PropsEntity",
        type: "service",
        properties: { port: 8080, host: "localhost" },
        relations: [],
      },
    });
    const entity = getScope("kg:kg-a").get("e-props") as any;
    expect(entity.properties.port).toBe(8080);
  });

  it("handles entity with multiple relations", async () => {
    seedKv("kg:kg-b", "t1", { id: "t1", relations: [] });
    seedKv("kg:kg-b", "t2", { id: "t2", relations: [] });
    await call("memory::kg::add", {
      agentId: "kg-b",
      entity: {
        id: "multi-rel",
        name: "MultiRel",
        type: "node",
        properties: {},
        relations: [
          { target: "t1", type: "depends_on" },
          { target: "t2", type: "uses" },
        ],
      },
    });
    const entity = getScope("kg:kg-b").get("multi-rel");
    expect(entity).toBeDefined();
  });

  it("creates back-reference with inverse prefix", async () => {
    seedKv("kg:kg-c", "existing", {
      id: "existing",
      relations: [],
    });
    await call("memory::kg::add", {
      agentId: "kg-c",
      entity: {
        id: "source",
        name: "Source",
        type: "node",
        properties: {},
        relations: [{ target: "existing", type: "uses" }],
      },
    });
    const existing = getScope("kg:kg-c").get("existing") as any;
    const backRefs = existing.relations.filter(
      (r: any) => r.target === "source" && r.type === "inverse:uses",
    );
    expect(backRefs.length).toBe(1);
  });
});

describe("memory::kg::query extended", () => {
  it("returns deep chain at full depth", async () => {
    seedKv("kg:deep", "a", {
      id: "a",
      relations: [{ target: "b", type: "link" }],
    });
    seedKv("kg:deep", "b", {
      id: "b",
      relations: [{ target: "c", type: "link" }],
    });
    seedKv("kg:deep", "c", {
      id: "c",
      relations: [{ target: "d", type: "link" }],
    });
    seedKv("kg:deep", "d", { id: "d", relations: [] });
    const results = await call("memory::kg::query", {
      agentId: "deep",
      entityId: "a",
      depth: 4,
    });
    expect(results.length).toBe(4);
  });

  it("defaults depth to 2", async () => {
    seedKv("kg:def-depth", "x", {
      id: "x",
      relations: [{ target: "y", type: "l" }],
    });
    seedKv("kg:def-depth", "y", {
      id: "y",
      relations: [{ target: "z", type: "l" }],
    });
    seedKv("kg:def-depth", "z", { id: "z", relations: [] });
    const results = await call("memory::kg::query", {
      agentId: "def-depth",
      entityId: "x",
    });
    expect(results.length).toBe(2);
  });
});

describe("memory::evict extended", () => {
  it("deletes both entry and hash on eviction", async () => {
    const old = Date.now() - 40 * 86_400_000;
    seedKv("memory:evict-both", "entry-1", {
      id: "entry-1",
      content: "evictable",
      role: "user",
      timestamp: old,
      importance: 0.1,
      hash: "hash-1",
    });
    seedKv("memory:evict-both", "hash-1", { id: "entry-1" });
    await call("memory::evict", { agentId: "evict-both" });
    expect(getScope("memory:evict-both").has("entry-1")).toBe(false);
    expect(getScope("memory:evict-both").has("hash-1")).toBe(false);
  });

  it("returns 0 evicted for empty memory", async () => {
    const result = await call("memory::evict", { agentId: "empty-agent" });
    expect(result.evicted).toBe(0);
  });

  it("evicts multiple stale entries", async () => {
    const old = Date.now() - 50 * 86_400_000;
    for (let i = 0; i < 5; i++) {
      seedKv("memory:multi-evict", `e-${i}`, {
        id: `e-${i}`,
        content: `old entry ${i}`,
        role: "user",
        timestamp: old,
        importance: 0.05,
        hash: `h-${i}`,
      });
      seedKv("memory:multi-evict", `h-${i}`, { id: `e-${i}` });
    }
    const result = await call("memory::evict", { agentId: "multi-evict" });
    expect(result.evicted).toBe(5);
  });

  it("evicts overflow by importance when over cap", async () => {
    for (let i = 0; i < 10; i++) {
      seedKv("memory:overflow", `o-${i}`, {
        id: `o-${i}`,
        content: `overflow ${i}`,
        role: "user",
        timestamp: Date.now(),
        importance: 0.1 * (i + 1),
        hash: `oh-${i}`,
      });
    }
    const result = await call("memory::evict", {
      agentId: "overflow",
      cap: 5,
    });
    expect(result.evicted).toBe(5);
  });
});

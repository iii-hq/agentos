import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  return null;
});

const handlers: Record<string, Function> = {};
const mockTriggerVoid = vi.fn();
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
});

beforeAll(async () => {
  await import("../model-catalog.js");
});

async function call(id: string, input?: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input || {});
}

describe("catalog::models", () => {
  it("returns all models when no filters", async () => {
    const result = await call("catalog::models");
    expect(result.length).toBeGreaterThan(10);
  });

  it("filters by tier", async () => {
    const result = await call("catalog::models", { tier: "frontier" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m: any) => m.tier === "frontier")).toBe(true);
  });

  it("filters by provider", async () => {
    const result = await call("catalog::models", { provider: "anthropic" });
    expect(result.length).toBe(3);
    expect(result.every((m: any) => m.provider === "anthropic")).toBe(true);
  });

  it("filters by supportsTools", async () => {
    const result = await call("catalog::models", { supportsTools: true });
    expect(result.every((m: any) => m.supportsTools === true)).toBe(true);
  });

  it("combines tier and provider filters", async () => {
    const result = await call("catalog::models", {
      tier: "smart",
      provider: "anthropic",
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("claude-sonnet-4-6");
  });

  it("returns empty array for non-matching filter", async () => {
    const result = await call("catalog::models", {
      provider: "nonexistent_provider",
    });
    expect(result).toHaveLength(0);
  });

  it("includes all expected model fields", async () => {
    const result = await call("catalog::models", { provider: "anthropic" });
    const model = result[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("provider");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("tier");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxOutput");
    expect(model).toHaveProperty("inputPrice");
    expect(model).toHaveProperty("outputPrice");
    expect(model).toHaveProperty("supportsTools");
    expect(model).toHaveProperty("supportsVision");
  });
});

describe("catalog::resolve - alias resolution", () => {
  it("resolves 'opus' alias to claude-opus-4-6", async () => {
    const result = await call("catalog::resolve", { model: "opus" });
    expect(result.id).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });

  it("resolves 'sonnet' alias", async () => {
    const result = await call("catalog::resolve", { model: "sonnet" });
    expect(result.id).toBe("claude-sonnet-4-6");
  });

  it("resolves 'haiku' alias", async () => {
    const result = await call("catalog::resolve", { model: "haiku" });
    expect(result.id).toBe("claude-haiku-4-5");
  });

  it("resolves 'gpt4' alias to gpt-4o", async () => {
    const result = await call("catalog::resolve", { model: "gpt4" });
    expect(result.id).toBe("gpt-4o");
  });

  it("resolves 'flash' alias to gemini-2.5-flash", async () => {
    const result = await call("catalog::resolve", { model: "flash" });
    expect(result.id).toBe("gemini-2.5-flash");
  });

  it("resolves semantic alias 'best' to claude-opus-4-6", async () => {
    const result = await call("catalog::resolve", { model: "best" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("resolves semantic alias 'fast' to claude-haiku-4-5", async () => {
    const result = await call("catalog::resolve", { model: "fast" });
    expect(result.id).toBe("claude-haiku-4-5");
  });

  it("resolves direct model ID", async () => {
    const result = await call("catalog::resolve", { model: "gpt-4o" });
    expect(result.id).toBe("gpt-4o");
  });

  it("throws for unknown model", async () => {
    await expect(
      call("catalog::resolve", { model: "nonexistent-model-xyz" }),
    ).rejects.toThrow("Unknown model");
  });

  it("is case-insensitive for aliases", async () => {
    const result = await call("catalog::resolve", { model: "OPUS" });
    expect(result.id).toBe("claude-opus-4-6");
  });
});

describe("catalog::providers", () => {
  it("returns all providers", async () => {
    const result = await call("catalog::providers");
    expect(result.length).toBeGreaterThan(20);
  });

  it("includes model count per provider", async () => {
    const result = await call("catalog::providers");
    const anthropic = result.find((p: any) => p.id === "anthropic");
    expect(anthropic.modelCount).toBe(3);
  });

  it("marks local providers correctly", async () => {
    const result = await call("catalog::providers");
    const ollama = result.find((p: any) => p.id === "ollama");
    expect(ollama.local).toBe(true);
  });

  it("checks availability based on env vars", async () => {
    const result = await call("catalog::providers");
    const ollama = result.find((p: any) => p.id === "ollama");
    expect(ollama.available).toBe(true);
  });
});

describe("catalog::aliases", () => {
  it("returns all aliases", async () => {
    const result = await call("catalog::aliases");
    expect(result.opus).toBe("claude-opus-4-6");
    expect(result.sonnet).toBe("claude-sonnet-4-6");
    expect(result.fast).toBe("claude-haiku-4-5");
  });
});

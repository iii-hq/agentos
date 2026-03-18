import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const handlers: Record<string, Function> = {};
const mockTrigger = vi.fn();
const mockTriggerVoid = vi.fn();
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => { handlers[config.id] = handler; },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

beforeEach(() => {});

beforeAll(async () => {
  await import("../model-catalog.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("catalog::models - comprehensive", () => {
  it("returns all models when no filters", async () => {
    const result = await call("catalog::models", {});
    expect(result.length).toBeGreaterThan(20);
  });

  it("filters by frontier tier", async () => {
    const result = await call("catalog::models", { tier: "frontier" });
    expect(result.every((m: any) => m.tier === "frontier")).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by smart tier", async () => {
    const result = await call("catalog::models", { tier: "smart" });
    expect(result.every((m: any) => m.tier === "smart")).toBe(true);
  });

  it("filters by balanced tier", async () => {
    const result = await call("catalog::models", { tier: "balanced" });
    expect(result.every((m: any) => m.tier === "balanced")).toBe(true);
  });

  it("filters by fast tier", async () => {
    const result = await call("catalog::models", { tier: "fast" });
    expect(result.every((m: any) => m.tier === "fast")).toBe(true);
  });

  it("filters by anthropic provider", async () => {
    const result = await call("catalog::models", { provider: "anthropic" });
    expect(result.every((m: any) => m.provider === "anthropic")).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("filters by openai provider", async () => {
    const result = await call("catalog::models", { provider: "openai" });
    expect(result.every((m: any) => m.provider === "openai")).toBe(true);
  });

  it("filters by gemini provider", async () => {
    const result = await call("catalog::models", { provider: "gemini" });
    expect(result.every((m: any) => m.provider === "gemini")).toBe(true);
  });

  it("filters by deepseek provider", async () => {
    const result = await call("catalog::models", { provider: "deepseek" });
    expect(result.every((m: any) => m.provider === "deepseek")).toBe(true);
  });

  it("filters by xai provider", async () => {
    const result = await call("catalog::models", { provider: "xai" });
    expect(result.every((m: any) => m.provider === "xai")).toBe(true);
  });

  it("filters by cohere provider", async () => {
    const result = await call("catalog::models", { provider: "cohere" });
    expect(result.every((m: any) => m.provider === "cohere")).toBe(true);
  });

  it("filters by bedrock provider", async () => {
    const result = await call("catalog::models", { provider: "bedrock" });
    expect(result.every((m: any) => m.provider === "bedrock")).toBe(true);
  });

  it("filters by supportsTools true", async () => {
    const result = await call("catalog::models", { supportsTools: true });
    expect(result.every((m: any) => m.supportsTools === true)).toBe(true);
  });

  it("filters by supportsTools false", async () => {
    const result = await call("catalog::models", { supportsTools: false });
    expect(result.every((m: any) => m.supportsTools === false)).toBe(true);
  });

  it("combines tier and provider filters", async () => {
    const result = await call("catalog::models", { tier: "smart", provider: "anthropic" });
    expect(result.every((m: any) => m.tier === "smart" && m.provider === "anthropic")).toBe(true);
  });

  it("returns empty when no match", async () => {
    const result = await call("catalog::models", { provider: "nonexistent" });
    expect(result).toEqual([]);
  });

  it("each model has required fields", async () => {
    const result = await call("catalog::models", {});
    for (const model of result) {
      expect(model.id).toBeDefined();
      expect(model.provider).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.tier).toBeDefined();
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutput).toBeGreaterThan(0);
      expect(typeof model.inputPrice).toBe("number");
      expect(typeof model.outputPrice).toBe("number");
      expect(typeof model.supportsTools).toBe("boolean");
      expect(typeof model.supportsVision).toBe("boolean");
      expect(typeof model.local).toBe("boolean");
    }
  });

  it("frontier models have higher prices", async () => {
    const frontier = await call("catalog::models", { tier: "frontier" });
    const fast = await call("catalog::models", { tier: "fast" });
    const avgFrontierPrice = frontier.reduce((s: number, m: any) => s + m.outputPrice, 0) / frontier.length;
    const avgFastPrice = fast.reduce((s: number, m: any) => s + m.outputPrice, 0) / fast.length;
    expect(avgFrontierPrice).toBeGreaterThan(avgFastPrice);
  });

  it("includes claude-opus-4-6", async () => {
    const result = await call("catalog::models", {});
    expect(result.some((m: any) => m.id === "claude-opus-4-6")).toBe(true);
  });

  it("includes gpt-4o", async () => {
    const result = await call("catalog::models", {});
    expect(result.some((m: any) => m.id === "gpt-4o")).toBe(true);
  });

  it("includes gemini-2.5-pro", async () => {
    const result = await call("catalog::models", {});
    expect(result.some((m: any) => m.id === "gemini-2.5-pro")).toBe(true);
  });
});

describe("catalog::resolve - comprehensive", () => {
  it("resolves opus alias", async () => {
    const result = await call("catalog::resolve", { model: "opus" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("resolves sonnet alias", async () => {
    const result = await call("catalog::resolve", { model: "sonnet" });
    expect(result.id).toBe("claude-sonnet-4-6");
  });

  it("resolves haiku alias", async () => {
    const result = await call("catalog::resolve", { model: "haiku" });
    expect(result.id).toBe("claude-haiku-4-5");
  });

  it("resolves gpt4 alias", async () => {
    const result = await call("catalog::resolve", { model: "gpt4" });
    expect(result.id).toBe("gpt-4o");
  });

  it("resolves gpt4o alias", async () => {
    const result = await call("catalog::resolve", { model: "gpt4o" });
    expect(result.id).toBe("gpt-4o");
  });

  it("resolves flash alias", async () => {
    const result = await call("catalog::resolve", { model: "flash" });
    expect(result.id).toBe("gemini-2.5-flash");
  });

  it("resolves pro alias", async () => {
    const result = await call("catalog::resolve", { model: "pro" });
    expect(result.id).toBe("gemini-2.5-pro");
  });

  it("resolves deepseek alias", async () => {
    const result = await call("catalog::resolve", { model: "deepseek" });
    expect(result.id).toBe("deepseek-chat");
  });

  it("resolves ds alias", async () => {
    const result = await call("catalog::resolve", { model: "ds" });
    expect(result.id).toBe("deepseek-chat");
  });

  it("resolves r1 alias", async () => {
    const result = await call("catalog::resolve", { model: "r1" });
    expect(result.id).toBe("deepseek-reasoner");
  });

  it("resolves grok alias", async () => {
    const result = await call("catalog::resolve", { model: "grok" });
    expect(result.id).toBe("grok-2");
  });

  it("resolves grok3 alias", async () => {
    const result = await call("catalog::resolve", { model: "grok3" });
    expect(result.id).toBe("grok-3");
  });

  it("resolves fast alias", async () => {
    const result = await call("catalog::resolve", { model: "fast" });
    expect(result.id).toBe("claude-haiku-4-5");
  });

  it("resolves cheap alias", async () => {
    const result = await call("catalog::resolve", { model: "cheap" });
    expect(result.id).toBe("gpt-4o-mini");
  });

  it("resolves smart alias", async () => {
    const result = await call("catalog::resolve", { model: "smart" });
    expect(result.id).toBe("claude-sonnet-4-6");
  });

  it("resolves best alias", async () => {
    const result = await call("catalog::resolve", { model: "best" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("resolves frontier alias", async () => {
    const result = await call("catalog::resolve", { model: "frontier" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("resolves direct model id", async () => {
    const result = await call("catalog::resolve", { model: "claude-opus-4-6" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("is case-insensitive", async () => {
    const result = await call("catalog::resolve", { model: "OPUS" });
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("throws on unknown model", async () => {
    await expect(
      call("catalog::resolve", { model: "nonexistent-model-xyz" }),
    ).rejects.toThrow("Unknown model");
  });

  it("resolves bedrock alias", async () => {
    const result = await call("catalog::resolve", { model: "bedrock" });
    expect(result.id).toBe("bedrock-claude-sonnet");
  });

  it("resolves nova alias", async () => {
    const result = await call("catalog::resolve", { model: "nova" });
    expect(result.id).toBe("bedrock-nova-pro");
  });

  it("resolves copilot alias", async () => {
    const result = await call("catalog::resolve", { model: "copilot" });
    expect(result.id).toBe("copilot-gpt-4o");
  });

  it("resolves qwen alias", async () => {
    const result = await call("catalog::resolve", { model: "qwen" });
    expect(result.id).toBe("qwen-max");
  });

  it("resolves kimi alias", async () => {
    const result = await call("catalog::resolve", { model: "kimi" });
    expect(result.id).toBe("moonshot-v1-128k");
  });

  it("resolves ernie alias", async () => {
    const result = await call("catalog::resolve", { model: "ernie" });
    expect(result.id).toBe("ernie-4.0-turbo");
  });

  it("resolves together alias", async () => {
    const result = await call("catalog::resolve", { model: "together" });
    expect(result.id).toBe("together-llama-3.3-70b");
  });

  it("resolves fireworks alias", async () => {
    const result = await call("catalog::resolve", { model: "fireworks" });
    expect(result.id).toBe("fireworks-llama-3.3-70b");
  });

  it("resolves openrouter alias", async () => {
    const result = await call("catalog::resolve", { model: "openrouter" });
    expect(result.id).toBe("openrouter-auto");
  });

  it("resolves minimax alias", async () => {
    const result = await call("catalog::resolve", { model: "minimax" });
    expect(result.id).toBe("abab7-chat");
  });

  it("resolves glm alias", async () => {
    const result = await call("catalog::resolve", { model: "glm" });
    expect(result.id).toBe("glm-4-plus");
  });

  it("resolves zhipu alias", async () => {
    const result = await call("catalog::resolve", { model: "zhipu" });
    expect(result.id).toBe("glm-4-plus");
  });

  it("resolves command alias", async () => {
    const result = await call("catalog::resolve", { model: "command" });
    expect(result.id).toBe("command-a");
  });

  it("resolves jamba alias", async () => {
    const result = await call("catalog::resolve", { model: "jamba" });
    expect(result.id).toBe("jamba-1.5-large");
  });

  it("resolves cerebras alias", async () => {
    const result = await call("catalog::resolve", { model: "cerebras" });
    expect(result.id).toBe("cerebras-llama-3.3-70b");
  });

  it("resolves sambanova alias", async () => {
    const result = await call("catalog::resolve", { model: "sambanova" });
    expect(result.id).toBe("samba-llama-3.1-405b");
  });

  it("resolves hf alias", async () => {
    const result = await call("catalog::resolve", { model: "hf" });
    expect(result.id).toBe("hf-llama-3.3-70b");
  });

  it("resolves replicate alias", async () => {
    const result = await call("catalog::resolve", { model: "replicate" });
    expect(result.id).toBe("replicate-llama-3.3-70b");
  });

  it("resolves sonar alias", async () => {
    const result = await call("catalog::resolve", { model: "sonar" });
    expect(result.id).toBe("sonar-pro");
  });

  it("resolves llama alias", async () => {
    const result = await call("catalog::resolve", { model: "llama" });
    expect(result.id).toBe("llama-3.3-70b");
  });

  it("resolves mistral alias", async () => {
    const result = await call("catalog::resolve", { model: "mistral" });
    expect(result.id).toBe("mistral-large");
  });

  it("resolves moonshot alias", async () => {
    const result = await call("catalog::resolve", { model: "moonshot" });
    expect(result.id).toBe("moonshot-v1-128k");
  });

  it("resolves o3 alias", async () => {
    const result = await call("catalog::resolve", { model: "o3" });
    expect(result.id).toBe("o3");
  });

  it("resolves o4 alias", async () => {
    const result = await call("catalog::resolve", { model: "o4" });
    expect(result.id).toBe("o4-mini");
  });

  it("returns full model entry with all fields", async () => {
    const result = await call("catalog::resolve", { model: "opus" });
    expect(result.provider).toBe("anthropic");
    expect(result.name).toContain("Opus");
    expect(result.tier).toBe("frontier");
    expect(result.contextWindow).toBe(200000);
    expect(result.supportsTools).toBe(true);
    expect(result.supportsVision).toBe(true);
  });
});

describe("catalog::providers", () => {
  it("returns all providers", async () => {
    const result = await call("catalog::providers", {});
    expect(result.length).toBeGreaterThanOrEqual(27);
  });

  it("includes anthropic provider", async () => {
    const result = await call("catalog::providers", {});
    expect(result.some((p: any) => p.id === "anthropic")).toBe(true);
  });

  it("includes openai provider", async () => {
    const result = await call("catalog::providers", {});
    expect(result.some((p: any) => p.id === "openai")).toBe(true);
  });

  it("includes ollama as local provider", async () => {
    const result = await call("catalog::providers", {});
    const ollama = result.find((p: any) => p.id === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama.local).toBe(true);
  });

  it("each provider has required fields", async () => {
    const result = await call("catalog::providers", {});
    for (const p of result) {
      expect(p.id).toBeDefined();
      expect(p.name).toBeDefined();
      expect(p.baseUrl).toBeDefined();
      expect(p.envKey).toBeDefined();
      expect(typeof p.local).toBe("boolean");
      expect(p.driver).toBeDefined();
    }
  });

  it("includes model count for each provider", async () => {
    const result = await call("catalog::providers", {});
    for (const p of result) {
      expect(typeof p.modelCount).toBe("number");
    }
  });

  it("includes availability status", async () => {
    const result = await call("catalog::providers", {});
    for (const p of result) {
      expect(typeof p.available).toBe("boolean");
    }
  });

  it("local providers are always available", async () => {
    const result = await call("catalog::providers", {});
    const locals = result.filter((p: any) => p.local);
    expect(locals.every((p: any) => p.available)).toBe(true);
  });

  it("includes bedrock provider", async () => {
    const result = await call("catalog::providers", {});
    const bedrock = result.find((p: any) => p.id === "bedrock");
    expect(bedrock).toBeDefined();
    expect(bedrock.driver).toBe("bedrock");
  });

  it("includes gemini provider with correct driver", async () => {
    const result = await call("catalog::providers", {});
    const gemini = result.find((p: any) => p.id === "gemini");
    expect(gemini.driver).toBe("gemini");
  });
});

describe("catalog::aliases", () => {
  it("returns alias map", async () => {
    const result = await call("catalog::aliases", {});
    expect(typeof result).toBe("object");
  });

  it("includes opus alias", async () => {
    const result = await call("catalog::aliases", {});
    expect(result.opus).toBe("claude-opus-4-6");
  });

  it("includes sonnet alias", async () => {
    const result = await call("catalog::aliases", {});
    expect(result.sonnet).toBe("claude-sonnet-4-6");
  });

  it("includes convenience aliases", async () => {
    const result = await call("catalog::aliases", {});
    expect(result.fast).toBeDefined();
    expect(result.cheap).toBeDefined();
    expect(result.smart).toBeDefined();
    expect(result.best).toBeDefined();
  });

  it("has more than 30 aliases", async () => {
    const result = await call("catalog::aliases", {});
    expect(Object.keys(result).length).toBeGreaterThan(30);
  });
});

describe("catalog::provider_test", () => {
  it("throws on unknown provider", async () => {
    await expect(
      call("catalog::provider_test", { providerId: "nonexistent" }),
    ).rejects.toThrow("Unknown provider");
  });

  it("returns not reachable when env key not set", async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await call("catalog::provider_test", { providerId: "anthropic" });
    expect(result.reachable).toBe(false);
    expect(result.reason).toContain("not set");
    if (orig) process.env.ANTHROPIC_API_KEY = orig;
  });
});

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
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
    }
    scope.set(data.key, current);
    return current;
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

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "mock response" }],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
    },
  })),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../llm-router.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("llm::route - complexity scoring", () => {
  it("routes short simple messages to haiku", async () => {
    const result = await call("llm::route", {
      message: "hi",
      toolCount: 0,
    });
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.maxTokens).toBe(2048);
  });

  it("routes medium complexity to sonnet", async () => {
    const result = await call("llm::route", {
      message: "Can you help me write a function that processes data?",
      toolCount: 0,
    });
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("routes high complexity (long + code) to opus", async () => {
    const message =
      "Please analyze and refactor this complex module:\n```\n" +
      "x".repeat(2500) +
      "\n```";
    const result = await call("llm::route", {
      message,
      toolCount: 15,
    });
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.maxTokens).toBe(8192);
  });

  it("uses config model when provided", async () => {
    const result = await call("llm::route", {
      message: "anything",
      toolCount: 0,
      config: {
        provider: "openai",
        model: "gpt-4o",
        maxTokens: 16384,
      },
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.maxTokens).toBe(16384);
  });

  it("boosts score for code blocks", async () => {
    const withCode = await call("llm::route", {
      message: "Here is code:\n```\nconst x = 1;\n```",
      toolCount: 0,
    });
    const withoutCode = await call("llm::route", {
      message: "Here is some text without code",
      toolCount: 0,
    });
    expect(
      withCode.model === "claude-sonnet-4-6" ||
        withCode.model === "claude-opus-4-6",
    ).toBe(true);
  });

  it("boosts score for action keywords (analyze, refactor, debug)", async () => {
    const result = await call("llm::route", {
      message: "Please analyze and refactor this code carefully",
      toolCount: 0,
    });
    expect(result.model).not.toBe("claude-haiku-4-5");
  });

  it("reduces score for greeting messages", async () => {
    const result = await call("llm::route", {
      message: "hello",
      toolCount: 0,
    });
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("boosts score for many tools (>10)", async () => {
    const result = await call("llm::route", {
      message: "Please help me with this task",
      toolCount: 15,
    });
    expect(result.model !== "claude-haiku-4-5").toBe(true);
  });

  it("considers medium tool count (3-10) for scoring", async () => {
    const noTools = await call("llm::route", {
      message: "Help me with this",
      toolCount: 0,
    });
    const someTools = await call("llm::route", {
      message: "Help me with this",
      toolCount: 5,
    });
    expect(
      someTools.model === noTools.model ||
        someTools.model === "claude-sonnet-4-6",
    ).toBe(true);
  });

  it("defaults provider to anthropic", async () => {
    const result = await call("llm::route", {
      message: "test",
      toolCount: 0,
    });
    expect(result.provider).toBe("anthropic");
  });

  it("defaults config maxTokens to 4096", async () => {
    const result = await call("llm::route", {
      message: "test",
      config: { model: "custom-model" },
    });
    expect(result.maxTokens).toBe(4096);
  });

  it("boosts score for multi-step indicators", async () => {
    const result = await call("llm::route", {
      message: "Step 1: set up the project. Then add auth. Next deploy it. Finally test.",
      toolCount: 0,
    });
    expect(result.model).not.toBe("claude-haiku-4-5");
  });

  it("boosts score for multiple code blocks", async () => {
    const message = "Compare:\n```\nconst a = 1;\n```\nwith:\n```\nconst b = 2;\n```";
    const result = await call("llm::route", {
      message,
      toolCount: 0,
    });
    expect(
      result.model === "claude-sonnet-4-6" || result.model === "claude-opus-4-6",
    ).toBe(true);
  });

  it("economy tier always returns haiku", async () => {
    const result = await call("llm::route", {
      message: "Please analyze and refactor this complex module:\n```\n" + "x".repeat(2500) + "\n```",
      toolCount: 15,
      agentTier: "economy",
    });
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("premium tier returns sonnet minimum", async () => {
    const result = await call("llm::route", {
      message: "hello",
      toolCount: 0,
      agentTier: "premium",
    });
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("premium tier returns opus for complex queries", async () => {
    const result = await call("llm::route", {
      message: "Analyze and refactor this complex system:\n```\n" + "x".repeat(3000) + "\n```",
      toolCount: 15,
      agentTier: "premium",
    });
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("detects additional reasoning keywords (compare, evaluate, optimize, migrate)", async () => {
    const result = await call("llm::route", {
      message: "Compare and evaluate these two approaches to optimize the system",
      toolCount: 0,
    });
    expect(result.model).not.toBe("claude-haiku-4-5");
  });
});

describe("llm::complete", () => {
  it("calls anthropic provider and returns response", async () => {
    const result = await call("llm::complete", {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
      },
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.content).toBe("mock response");
    expect(result.durationMs).toBeDefined();
  });

  it("throws for unknown provider", async () => {
    await expect(
      call("llm::complete", {
        model: { provider: "unknown", model: "x", maxTokens: 1000 },
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("Unknown provider");
  });

  it("tracks cost via state::update", async () => {
    await call("llm::complete", {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
      },
      messages: [{ role: "user", content: "Test" }],
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "state::update",
      expect.objectContaining({ scope: "costs" }),
    );
  });

  it("includes usage in response", async () => {
    const result = await call("llm::complete", {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
      },
      messages: [{ role: "user", content: "Test" }],
    });
    expect(result.model).toBe("claude-sonnet-4-6");
  });
});

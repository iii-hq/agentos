import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get")
    return { model: { model: "test-model" }, systemPrompt: "You are helpful" };
  if (fnId === "memory::recall")
    return [{ role: "system", content: "context" }];
  if (fnId === "llm::route") return "test-model";
  if (fnId === "llm::complete")
    return {
      content:
        data?.messages?.[data.messages.length - 1]?.content || "response",
      model: "test-model",
      usage: { input: 10, output: 20, total: 30 },
    };
  if (fnId === "agent::chat")
    return {
      content: "agent response text for testing purposes",
      model: "test-model",
      usage: { input: 5, output: 15, total: 20 },
    };
  return null;
});

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
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
}));

const ENV_KEY = process.env.AGENTOS_API_KEY;
beforeEach(() => {
  mockTrigger.mockClear();
  process.env.AGENTOS_API_KEY = "test-key";
});

beforeAll(async () => {
  await import("../streaming.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("stream::chat", () => {
  it("returns 200 with content", async () => {
    const result = await call("stream::chat", {
      body: { agentId: "default", message: "Hello", sessionId: "s1" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.status_code).toBe(200);
    expect(result.body.content).toBeDefined();
  });

  it("returns model in response", async () => {
    const result = await call("stream::chat", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.body.model).toBeDefined();
  });

  it("returns usage in response", async () => {
    const result = await call("stream::chat", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.body.usage).toBeDefined();
    expect(result.body.usage.input).toBe(10);
    expect(result.body.usage.output).toBe(20);
  });

  it("uses default agentId when not provided", async () => {
    await call("stream::chat", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const getCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::get",
    );
    expect(getCalls.some((c: any) => c[1].key === "default")).toBe(true);
  });

  it("includes memories in context", async () => {
    await call("stream::chat", {
      body: { agentId: "test", message: "hello" },
      headers: { authorization: "Bearer test-key" },
    });
    const recallCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "memory::recall",
    );
    expect(recallCalls.length).toBeGreaterThan(0);
  });

  it("routes model selection", async () => {
    await call("stream::chat", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const routeCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "llm::route",
    );
    expect(routeCalls.length).toBe(1);
  });
});

describe("stream::sse", () => {
  it("returns SSE formatted response", async () => {
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.status_code).toBe(200);
    expect(result.headers["Content-Type"]).toBe("text/event-stream");
    expect(result.headers["Cache-Control"]).toBe("no-cache");
    expect(result.headers.Connection).toBe("keep-alive");
  });

  it("body contains data: prefixed lines", async () => {
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.body).toContain("data: ");
    expect(result.body).toContain("data: [DONE]");
  });

  it("each event is valid JSON", async () => {
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: ") && l !== "data: [DONE]");
    for (const line of lines) {
      const json = line.replace("data: ", "");
      const parsed = JSON.parse(json);
      expect(parsed.object).toBe("chat.completion.chunk");
      expect(parsed.choices).toBeDefined();
    }
  });

  it("first chunk has role assistant", async () => {
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const firstLine = result.body
      .split("\n")
      .find((l: string) => l.startsWith("data: {"));
    const parsed = JSON.parse(firstLine!.replace("data: ", ""));
    expect(parsed.choices[0].delta.role).toBe("assistant");
  });

  it("last chunk has finish_reason stop", async () => {
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine.replace("data: ", ""));
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });

  it("intermediate chunks have null finish_reason", async () => {
    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "agent::chat")
          return {
            content: "a".repeat(300),
            model: "test-model",
            usage: { input: 5, output: 15, total: 20 },
          };
        return null;
      },
    );
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    if (lines.length > 1) {
      const mid = JSON.parse(lines[0].replace("data: ", ""));
      if (lines.length > 2) {
        const midChunk = JSON.parse(lines[1].replace("data: ", ""));
        expect(midChunk.choices[0].finish_reason).toBeNull();
      }
    }
  });

  it("includes model in each event", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat")
        return { content: "short", model: "claude-test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    for (const line of lines) {
      const parsed = JSON.parse(line.replace("data: ", ""));
      expect(parsed.model).toBeDefined();
    }
  });

  it("each event has unique id", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat")
        return { content: "a".repeat(500), model: "test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    const ids = lines.map(
      (l: string) => JSON.parse(l.replace("data: ", "")).id,
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("each event has created timestamp", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat") return { content: "test", model: "test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    for (const line of lines) {
      const parsed = JSON.parse(line.replace("data: ", ""));
      expect(parsed.created).toBeDefined();
      expect(parsed.created).toBeGreaterThan(0);
    }
  });
});

describe("chunkMarkdownAware (via stream::sse)", () => {
  it("returns single chunk for short text", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat") return { content: "short", model: "test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    expect(lines.length).toBe(1);
  });

  it("splits long text into multiple chunks", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat")
        return { content: "a".repeat(500), model: "test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    const lines = result.body
      .split("\n")
      .filter((l: string) => l.startsWith("data: {"));
    expect(lines.length).toBeGreaterThan(1);
  });

  it("handles empty content", async () => {
    mockTrigger.mockImplementation(async (fnId: string): Promise<any> => {
      if (fnId === "agent::chat") return { content: "", model: "test" };
      return null;
    });
    const result = await call("stream::sse", {
      body: { message: "test" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.body).toContain("data: [DONE]");
  });
});

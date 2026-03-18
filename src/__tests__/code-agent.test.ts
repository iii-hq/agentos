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
  await import("../code-agent.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("agent::code_detect", () => {
  it("returns hasCode false for empty response", async () => {
    const result = await call("agent::code_detect", { response: "" });
    expect(result.hasCode).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it("detects typescript code blocks", async () => {
    const response = "Here is code:\n```typescript\nconst x = 42;\n```\n";
    const result = await call("agent::code_detect", { response });
    expect(result.hasCode).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toBe("const x = 42;");
  });

  it("detects javascript code blocks", async () => {
    const response = "Example:\n```javascript\nlet y = 10;\n```\n";
    const result = await call("agent::code_detect", { response });
    expect(result.hasCode).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toBe("let y = 10;");
  });

  it("returns multiple blocks", async () => {
    const response = [
      "First:",
      "```ts",
      "const a = 1;",
      "```",
      "Second:",
      "```js",
      "const b = 2;",
      "```",
    ].join("\n");
    const result = await call("agent::code_detect", { response });
    expect(result.hasCode).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toBe("const a = 1;");
    expect(result.blocks[1]).toBe("const b = 2;");
  });

  it("ignores non-code blocks (python, bash)", async () => {
    const response = [
      "Python:",
      "```python",
      "x = 42",
      "```",
      "Bash:",
      "```bash",
      "echo hello",
      "```",
      "Plain text with no blocks.",
    ].join("\n");
    const result = await call("agent::code_detect", { response });
    expect(result.hasCode).toBe(false);
    expect(result.blocks).toEqual([]);
  });
});

describe("agent::code_execute", () => {
  it("runs simple expression", async () => {
    const result = await call("agent::code_execute", {
      code: "2 + 2",
      agentId: "test-agent",
    });
    expect(result.result).toBe(4);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("captures console.log output", async () => {
    const result = await call("agent::code_execute", {
      code: 'console.log("hello"); console.log("world"); 42',
      agentId: "test-agent",
    });
    expect(result.stdout).toBe("hello\nworld");
    expect(result.result).toBe(42);
  });

  it("returns error for missing code", async () => {
    const result = await call("agent::code_execute", {
      code: "",
      agentId: "test-agent",
    });
    expect(result.result).toEqual({ error: "code and agentId required" });
    expect(result.stdout).toBe("");
    expect(result.executionTimeMs).toBe(0);
  });

  it("blocks access to process", async () => {
    const result = await call("agent::code_execute", {
      code: "process.exit(1)",
      agentId: "test-agent",
    });
    expect(result.result).toHaveProperty("error");
  });

  it("respects timeout", async () => {
    const result = await call("agent::code_execute", {
      code: "while(true) {}",
      agentId: "test-agent",
      timeout: 1000,
    });
    expect(result.result).toHaveProperty("error");
    expect((result.result as any).error).toMatch(/timed out|timeout/i);
  }, 10_000);

  it("truncates large output", async () => {
    const result = await call("agent::code_execute", {
      code: `
        const big = "x".repeat(200000);
        big;
      `,
      agentId: "test-agent",
    });
    expect(result.result).toHaveProperty("truncated", true);
    expect(result.result).toHaveProperty("preview");
  });
});

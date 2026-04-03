import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(
  async (_fnId?: string, _payload?: unknown): Promise<null> => null,
);
const mockTriggerVoid = vi.fn(
  (_fnId?: string, _payload?: unknown): void => undefined,
);

const handlers: Record<string, Function> = {};
const triggerRefs: any[] = [];
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
      return { id: config.id, unregister: vi.fn() };
    },
    registerTrigger: vi.fn((...args: any[]) => {
      triggerRefs.push(args);
      return { unregister: vi.fn() };
    }),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  validateMcpCommand: vi.fn(),
  stripSecretsFromEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
}));

const mockSpawn = vi.fn((_cmd?: any, _args?: any, _opts?: any) => ({
  stdin: { writable: true, write: vi.fn() },
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
}));

vi.mock("child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(args[0], args[1], args[2]),
}));

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async () => null);
  mockTriggerVoid.mockClear();
  mockSpawn.mockClear();
});

beforeAll(async () => {
  await import("../mcp-client.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("mcp::connect", () => {
  it("throws when stdio transport missing command", async () => {
    await expect(
      call("mcp::connect", {
        body: { name: "no-cmd", transport: "stdio" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("requires command");
  });

  it("throws when SSE transport missing url", async () => {
    await expect(
      call("mcp::connect", {
        body: { name: "no-url", transport: "sse" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("requires url");
  });

  it("validates MCP command", async () => {
    vi.useFakeTimers();
    const { validateMcpCommand } = await import("../shared/utils.js");
    const promise = call("mcp::connect", {
      body: {
        name: "validated",
        transport: "stdio",
        command: "npx",
        args: ["mcp-server"],
      },
      headers: { authorization: "Bearer test-key" },
    });
    vi.advanceTimersByTime(31000);
    try {
      await promise;
    } catch {}
    expect(validateMcpCommand).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("spawns process for stdio transport", async () => {
    vi.useFakeTimers();
    const promise = call("mcp::connect", {
      body: {
        name: "spawned",
        transport: "stdio",
        command: "npx",
        args: ["mcp-server"],
      },
      headers: { authorization: "Bearer test-key" },
    });
    vi.advanceTimersByTime(31000);
    await expect(promise).rejects.toBeDefined();
    expect(mockSpawn).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses stripped environment for spawned process", async () => {
    vi.useFakeTimers();
    const { stripSecretsFromEnv } = await import("../shared/utils.js");
    const promise = call("mcp::connect", {
      body: { name: "env-check", transport: "stdio", command: "npx" },
      headers: { authorization: "Bearer test-key" },
    });
    vi.advanceTimersByTime(31000);
    await expect(promise).rejects.toBeDefined();
    expect(stripSecretsFromEnv).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("mcp::disconnect", () => {
  it("throws when connection not found", async () => {
    await expect(
      call("mcp::disconnect", {
        body: { name: "nonexistent" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("No connection");
  });
});

describe("mcp::list_tools", () => {
  it("returns tools array", async () => {
    const result = await call("mcp::list_tools", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.count).toBeDefined();
  });
});

describe("mcp::call_tool", () => {
  it("throws when server not found", async () => {
    await expect(
      call("mcp::call_tool", {
        body: { server: "nonexistent", tool: "test", arguments: {} },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("No connection");
  });
});

describe("mcp::list_connections", () => {
  it("returns connections array", async () => {
    const result = await call("mcp::list_connections", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.connections).toBeDefined();
    expect(result.count).toBeDefined();
  });
});

describe("mcp::serve", () => {
  it("registers tools as MCP server", async () => {
    const result = await call("mcp::serve", {
      body: {
        tools: [
          {
            name: "test-tool",
            description: "A test",
            inputSchema: {},
            functionId: "tool::test",
          },
        ],
      },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.serving).toBe(true);
    expect(result.tools).toBe(1);
  });
});

describe("mcp::unserve", () => {
  it("returns status", async () => {
    const result = await call("mcp::unserve", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.unserved).toBeDefined();
  });
});

describe("handler registration", () => {
  it("registers mcp::connect handler", () => {
    expect(handlers["mcp::connect"]).toBeDefined();
  });

  it("registers mcp::disconnect handler", () => {
    expect(handlers["mcp::disconnect"]).toBeDefined();
  });

  it("registers mcp::list_tools handler", () => {
    expect(handlers["mcp::list_tools"]).toBeDefined();
  });

  it("registers mcp::call_tool handler", () => {
    expect(handlers["mcp::call_tool"]).toBeDefined();
  });

  it("registers mcp::list_connections handler", () => {
    expect(handlers["mcp::list_connections"]).toBeDefined();
  });

  it("registers mcp::serve handler", () => {
    expect(handlers["mcp::serve"]).toBeDefined();
  });

  it("registers mcp::unserve handler", () => {
    expect(handlers["mcp::unserve"]).toBeDefined();
  });
});

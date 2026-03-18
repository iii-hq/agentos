import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const handlers: Record<string, Function> = {};
const mockTrigger = vi.fn(async () => null);
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

let mockExecResult = { stdout: "[]", stderr: "", exitCode: 0 };
vi.mock("child_process", () => ({
  execFile: Object.assign(
    vi.fn((...args: any[]) => {
      const cb = typeof args[3] === "function" ? args[3] : args[2];
      if (mockExecResult.exitCode !== 0) {
        const err: any = new Error("Command failed");
        err.code = mockExecResult.exitCode;
        err.stdout = mockExecResult.stdout;
        err.stderr = mockExecResult.stderr;
        cb?.(err, mockExecResult.stdout, mockExecResult.stderr);
      } else {
        cb?.(null, mockExecResult.stdout, mockExecResult.stderr);
      }
    }),
    {
      __promisify__: vi.fn(async () => {
        if (mockExecResult.exitCode !== 0) {
          const err: any = new Error("Command failed");
          err.code = mockExecResult.exitCode;
          err.stdout = mockExecResult.stdout;
          err.stderr = mockExecResult.stderr;
          throw err;
        }
        return { stdout: mockExecResult.stdout, stderr: mockExecResult.stderr };
      }),
    },
  ),
}));

vi.mock("util", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    promisify: vi.fn((fn: any) => {
      return async (...args: any[]) => {
        if (mockExecResult.exitCode !== 0) {
          const err: any = new Error("Command failed");
          err.code = mockExecResult.exitCode;
          err.stdout = mockExecResult.stdout;
          err.stderr = mockExecResult.stderr;
          throw err;
        }
        return { stdout: mockExecResult.stdout, stderr: mockExecResult.stderr };
      };
    }),
  };
});

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.includes("SKILL.md"))
      return "---\nname: test-skill\n---\nA test skill";
    return "file content";
  }),
  readdir: vi.fn(async (dir: string, opts?: any) => {
    if (dir.includes("empty")) return [];
    if (dir.includes(".well-known"))
      return [
        { name: "agent.json", isFile: () => true, isDirectory: () => false },
      ];
    if (dir.includes("src")) return [];
    return [
      {
        name: "SKILL.md",
        isFile: () => true,
        isDirectory: () => false,
      },
      {
        name: "src",
        isFile: () => false,
        isDirectory: () => true,
      },
      {
        name: ".well-known",
        isFile: () => false,
        isDirectory: () => true,
      },
      {
        name: "node_modules",
        isFile: () => false,
        isDirectory: () => true,
      },
    ];
  }),
  stat: vi.fn(async () => ({ size: 100 })),
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  mockTrigger.mockClear();
  mockExecResult = { stdout: "[]", stderr: "", exitCode: 0 };
});

beforeAll(async () => {
  await import("../skillkit-bridge.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function setExecResult(stdout: string, stderr: string, exitCode: number) {
  mockExecResult = { stdout, stderr, exitCode };
}

describe("skillkit::search", () => {
  it("returns results on success", async () => {
    setExecResult('[{"name":"skill-a"}]', "", 0);
    const result = await call("skillkit::search", { query: "testing" });
    expect(result.results).toEqual([{ name: "skill-a" }]);
  });

  it("returns empty results on command failure", async () => {
    setExecResult("", "not found", 1);
    const result = await call("skillkit::search", { query: "missing" });
    expect(result.results).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it("rejects query shorter than 2 chars", async () => {
    await expect(call("skillkit::search", { query: "x" })).rejects.toThrow(
      "Query must be at least 2 characters",
    );
  });

  it("rejects empty query", async () => {
    await expect(call("skillkit::search", { query: "" })).rejects.toThrow(
      "Query must be at least 2 characters",
    );
  });

  it("handles non-JSON stdout gracefully", async () => {
    setExecResult("plain text output", "", 0);
    const result = await call("skillkit::search", { query: "test" });
    expect(result.results).toEqual([]);
    expect(result.raw).toBeDefined();
  });
});

describe("skillkit::install", () => {
  it("returns installed on success", async () => {
    setExecResult('{"installed":true}', "", 0);
    const result = await call("skillkit::install", { id: "my-skill" });
    expect(result.installed).toBe(true);
  });

  it("rejects invalid skill ID format", async () => {
    await expect(
      call("skillkit::install", { id: "bad id with spaces" }),
    ).rejects.toThrow("Invalid skill ID format");
  });

  it("validates agent name format", async () => {
    await expect(
      call("skillkit::install", { id: "valid-skill", agent: "bad agent" }),
    ).rejects.toThrow("Invalid agent name");
  });

  it("returns error on command failure", async () => {
    setExecResult("", "not found in marketplace", 1);
    const result = await call("skillkit::install", { id: "nonexistent" });
    expect(result.installed).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("handles non-JSON success output", async () => {
    setExecResult("Installed successfully", "", 0);
    const result = await call("skillkit::install", { id: "test-skill" });
    expect(result.installed).toBe(true);
    expect(result.raw).toBeDefined();
  });
});

describe("skillkit::list", () => {
  it("returns skills on success", async () => {
    setExecResult('[{"name":"a"},{"name":"b"}]', "", 0);
    const result = await call("skillkit::list", {});
    expect(result.skills).toHaveLength(2);
  });

  it("returns empty on failure", async () => {
    setExecResult("", "error", 1);
    const result = await call("skillkit::list", {});
    expect(result.skills).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it("handles non-JSON output", async () => {
    setExecResult("No skills installed", "", 0);
    const result = await call("skillkit::list", {});
    expect(result.skills).toEqual([]);
    expect(result.raw).toBeDefined();
  });
});

describe("skillkit::recommend", () => {
  it("returns recommendations", async () => {
    setExecResult('[{"name":"rec-1","score":0.9}]', "", 0);
    const result = await call("skillkit::recommend", {});
    expect(result.recommendations).toHaveLength(1);
  });

  it("returns empty on failure", async () => {
    setExecResult("", "error", 1);
    const result = await call("skillkit::recommend", {});
    expect(result.recommendations).toEqual([]);
  });

  it("handles no context", async () => {
    setExecResult("[]", "", 0);
    const result = await call("skillkit::recommend", {});
    expect(result.exitCode).toBe(0);
  });
});

describe("skillkit::scan", () => {
  it("scans workspace and finds SKILL.md", async () => {
    const result = await call("skillkit::scan", {});
    expect(result.count).toBeGreaterThan(0);
    expect(result.found.some((f: any) => f.type === "skill")).toBe(true);
  });

  it("finds .well-known directory", async () => {
    const result = await call("skillkit::scan", {});
    expect(result.found.some((f: any) => f.type === "well-known")).toBe(true);
  });

  it("accepts custom scan path", async () => {
    const result = await call("skillkit::scan", { path: "subdir" });
    expect(result.root).toBeDefined();
  });

  it("limits results to 50", async () => {
    const result = await call("skillkit::scan", {});
    expect(result.count).toBeLessThanOrEqual(50);
  });

  it("returns root in result", async () => {
    const result = await call("skillkit::scan", {});
    expect(result.root).toBeDefined();
    expect(typeof result.root).toBe("string");
  });
});

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
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}));

let fileContents: Record<string, string> = {};

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (fileContents[p] !== undefined) return fileContents[p];
    if (p.includes("not-found")) throw new Error("ENOENT");
    return "line one\nline two\nline three\nline four\nline five";
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    fileContents[p] = content;
  }),
}));

vi.mock("@agentos/shared/metrics", () => ({
  createRecordMetric: () => vi.fn(),
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

const WORKSPACE_ROOT = process.cwd();

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  fileContents = {};
});

beforeAll(async () => {
  await import("../hashline.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("computeLineHash", () => {
  it("produces 2-char codes from the hash alphabet", async () => {
    const { computeLineHash } = await import("../hashline.js");
    const hash = computeLineHash(1, "function hello() {");
    expect(hash).toHaveLength(2);
    expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
  });

  it("produces different hashes for different content", async () => {
    const { computeLineHash } = await import("../hashline.js");
    const h1 = computeLineHash(1, "function hello() {");
    const h2 = computeLineHash(1, "function goodbye() {");
    expect(h1).not.toBe(h2);
  });

  it("uses line number as seed for non-alphanumeric lines", async () => {
    const { computeLineHash } = await import("../hashline.js");
    const h1 = computeLineHash(1, "---");
    const h2 = computeLineHash(2, "---");
    expect(h1).not.toBe(h2);
  });

  it("produces same hash for same line content and number", async () => {
    const { computeLineHash } = await import("../hashline.js");
    const h1 = computeLineHash(5, "const x = 42;");
    const h2 = computeLineHash(5, "const x = 42;");
    expect(h1).toBe(h2);
  });
});

describe("tool::hashline_read", () => {
  it("formats lines with hash-anchored numbers", async () => {
    const result = await call("tool::hashline_read", { path: "test.ts" });
    expect(result.totalLines).toBe(5);
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toMatch(/^1#[A-Z]{2}\|line one$/);
    expect(result.lines[1]).toMatch(/^2#[A-Z]{2}\|line two$/);
  });

  it("respects startLine and endLine", async () => {
    const result = await call("tool::hashline_read", {
      path: "test.ts",
      startLine: 2,
      endLine: 3,
    });
    expect(result.lines).toHaveLength(2);
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.lines[0]).toMatch(/^2#[A-Z]{2}\|line two$/);
  });

  it("returns path and total line count", async () => {
    const result = await call("tool::hashline_read", { path: "test.ts" });
    expect(result.path).toContain("test.ts");
    expect(result.totalLines).toBe(5);
  });
});

describe("tool::hashline_edit", () => {
  it("rejects empty edits array", async () => {
    await expect(
      call("tool::hashline_edit", { path: "test.ts", edits: [] }),
    ).rejects.toThrow("edits must be a non-empty array");
  });

  it("replaces a single line with valid hash", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const firstLine = readResult.lines[0];
    const match = firstLine.match(/^1#([A-Z]{2})\|/);
    const hash = match![1];

    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [
        { op: "replace", pos: `1#${hash}`, lines: "replaced line one" },
      ],
    });

    expect(result.editsApplied).toBe(1);
    expect(result.totalLines).toBe(5);
  });

  it("rejects edit with hash mismatch", async () => {
    await expect(
      call("tool::hashline_edit", {
        path: "test.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: "bad" }],
      }),
    ).rejects.toThrow(/Hash mismatch/);
  });

  it("appends lines after a specific position", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const line2 = readResult.lines[1];
    const match = line2.match(/^2#([A-Z]{2})\|/);
    const hash = match![1];

    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [
        { op: "append", pos: `2#${hash}`, lines: ["inserted A", "inserted B"] },
      ],
    });

    expect(result.totalLines).toBe(7);
  });

  it("appends to end of file without pos", async () => {
    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [{ op: "append", lines: "new last line" }],
    });

    expect(result.totalLines).toBe(6);
  });

  it("prepends before a specific position", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const line3 = readResult.lines[2];
    const match = line3.match(/^3#([A-Z]{2})\|/);
    const hash = match![1];

    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [
        { op: "prepend", pos: `3#${hash}`, lines: "before three" },
      ],
    });

    expect(result.totalLines).toBe(6);
  });

  it("prepends to start of file without pos", async () => {
    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [{ op: "prepend", lines: "new first line" }],
    });

    expect(result.totalLines).toBe(6);
  });

  it("deletes a line with null lines", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const line4 = readResult.lines[3];
    const match = line4.match(/^4#([A-Z]{2})\|/);
    const hash = match![1];

    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [{ op: "replace", pos: `4#${hash}`, lines: null }],
    });

    expect(result.totalLines).toBe(4);
  });

  it("replaces a range of lines", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const line2 = readResult.lines[1];
    const line4 = readResult.lines[3];
    const hash2 = line2.match(/^2#([A-Z]{2})\|/)![1];
    const hash4 = line4.match(/^4#([A-Z]{2})\|/)![1];

    const result = await call("tool::hashline_edit", {
      path: "test.ts",
      edits: [
        {
          op: "replace",
          pos: `2#${hash2}`,
          end: `4#${hash4}`,
          lines: ["combined line"],
        },
      ],
    });

    expect(result.totalLines).toBe(3);
  });
});

describe("tool::hashline_diff", () => {
  it("shows diff without applying changes", async () => {
    const readResult = await call("tool::hashline_read", { path: "test.ts" });
    const line1 = readResult.lines[0];
    const hash = line1.match(/^1#([A-Z]{2})\|/)![1];

    const result = await call("tool::hashline_diff", {
      path: "test.ts",
      edits: [
        { op: "replace", pos: `1#${hash}`, lines: "changed first" },
      ],
    });

    expect(result.diff).toContain("-line one");
    expect(result.diff).toContain("+changed first");
    expect(result.originalLines).toBe(5);
    expect(result.editedLines).toBe(5);
  });

  it("rejects empty edits", async () => {
    await expect(
      call("tool::hashline_diff", { path: "test.ts", edits: [] }),
    ).rejects.toThrow("edits must be a non-empty array");
  });
});

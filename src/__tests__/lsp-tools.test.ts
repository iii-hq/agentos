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

const sampleTsFile = `import { foo } from "./bar";

export function computeHash(input: string): string {
  return input;
}

export class Parser {
  parse() {}
}

export const MAX_SIZE = 1024;

export type Config = {
  name: string;
};

export interface Options {
  debug: boolean;
}

function internalHelper() {
  return 42;
}

const localVar = "hello";
`;

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.includes("not-found")) throw new Error("ENOENT");
    if (p.includes("sample")) return sampleTsFile;
    return "line one\nline two\n";
  }),
  writeFile: vi.fn(async () => {}),
}));

let execFileResults: Record<string, { stdout: string; stderr: string }> = {};

vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb?: Function) => {
    if (!cb && typeof opts === "function") {
      cb = opts;
    }
    const key = `${cmd}:${args.join(",")}`;
    for (const [pattern, result] of Object.entries(execFileResults)) {
      if (key.includes(pattern)) {
        cb?.(null, result.stdout, result.stderr);
        return;
      }
    }
    cb?.(null, "", "");
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

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  execFileResults = {};
});

beforeAll(async () => {
  await import("../lsp-tools.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("tool::lsp_symbols", () => {
  it("extracts function declarations", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    const fns = result.symbols.filter(
      (s: any) => s.kind === "function",
    );
    expect(fns.length).toBeGreaterThanOrEqual(2);
    const names = fns.map((s: any) => s.name);
    expect(names).toContain("computeHash");
    expect(names).toContain("internalHelper");
  });

  it("extracts class declarations", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    const classes = result.symbols.filter((s: any) => s.kind === "class");
    expect(classes.length).toBeGreaterThanOrEqual(1);
    expect(classes[0].name).toBe("Parser");
    expect(classes[0].exported).toBe(true);
  });

  it("extracts const/variable declarations", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    const vars = result.symbols.filter((s: any) => s.kind === "variable");
    const names = vars.map((s: any) => s.name);
    expect(names).toContain("MAX_SIZE");
    expect(names).toContain("localVar");
  });

  it("extracts type and interface declarations", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    const types = result.symbols.filter((s: any) => s.kind === "type");
    expect(types.length).toBeGreaterThanOrEqual(1);
    expect(types[0].name).toBe("Config");

    const ifaces = result.symbols.filter(
      (s: any) => s.kind === "interface",
    );
    expect(ifaces.length).toBeGreaterThanOrEqual(1);
    expect(ifaces[0].name).toBe("Options");
  });

  it("marks exported symbols correctly", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    const computeHash = result.symbols.find(
      (s: any) => s.name === "computeHash",
    );
    expect(computeHash?.exported).toBe(true);

    const internalHelper = result.symbols.find(
      (s: any) => s.name === "internalHelper",
    );
    expect(internalHelper?.exported).toBe(false);
  });

  it("includes line numbers", async () => {
    const result = await call("tool::lsp_symbols", { path: "sample.ts" });
    for (const sym of result.symbols) {
      expect(sym.line).toBeGreaterThan(0);
    }
  });
});

describe("tool::lsp_references", () => {
  it("finds occurrences across files", async () => {
    const cwd = process.cwd();
    execFileResults["grep"] = {
      stdout: `${cwd}/src/foo.ts:10:  computeHash(data)\n${cwd}/src/bar.ts:5:import { computeHash } from "./foo"\n`,
      stderr: "",
    };

    const result = await call("tool::lsp_references", {
      symbol: "computeHash",
    });

    expect(result.symbol).toBe("computeHash");
    expect(result.references.length).toBe(2);
    expect(result.references[0].line).toBe(10);
    expect(result.references[0].content).toContain("computeHash");
  });

  it("returns empty when no matches", async () => {
    execFileResults["grep"] = { stdout: "", stderr: "" };

    const result = await call("tool::lsp_references", {
      symbol: "nonExistentSymbol",
    });

    expect(result.references).toEqual([]);
  });

  it("rejects missing symbol", async () => {
    await expect(
      call("tool::lsp_references", { symbol: "" }),
    ).rejects.toThrow("symbol is required");
  });
});

describe("tool::lsp_goto_definition", () => {
  it("finds function definition", async () => {
    const cwd = process.cwd();
    execFileResults["function"] = {
      stdout: `${cwd}/src/utils.ts:15:export function computeHash(input: string) {\n`,
      stderr: "",
    };

    const result = await call("tool::lsp_goto_definition", {
      symbol: "computeHash",
    });

    expect(result.symbol).toBe("computeHash");
    expect(result.kind).toBe("function");
    expect(result.line).toBe(15);
  });

  it("returns notFound for unknown symbol", async () => {
    execFileResults["grep"] = { stdout: "", stderr: "" };

    const result = await call("tool::lsp_goto_definition", {
      symbol: "doesNotExist",
    });

    expect(result.notFound).toBe(true);
    expect(result.file).toBeNull();
  });

  it("rejects missing symbol", async () => {
    await expect(
      call("tool::lsp_goto_definition", { symbol: "" }),
    ).rejects.toThrow("symbol is required");
  });
});

describe("tool::lsp_diagnostics", () => {
  it("returns diagnostics for typescript files", async () => {
    execFileResults["tsc"] = {
      stdout: "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.\n",
      stderr: "",
    };

    const result = await call("tool::lsp_diagnostics", {
      path: "src/foo.ts",
    });

    expect(result.language).toBe("typescript");
  });

  it("returns unsupported for unknown extensions", async () => {
    const result = await call("tool::lsp_diagnostics", {
      path: "readme.md",
    });

    expect(result.unsupported).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("tool::lsp_rename", () => {
  it("rejects missing names", async () => {
    await expect(
      call("tool::lsp_rename", { oldName: "", newName: "bar" }),
    ).rejects.toThrow("oldName and newName are required");
  });

  it("returns rename results", async () => {
    execFileResults["grep"] = { stdout: "", stderr: "" };

    const result = await call("tool::lsp_rename", {
      oldName: "oldFunc",
      newName: "newFunc",
    });

    expect(result.oldName).toBe("oldFunc");
    expect(result.newName).toBe("newFunc");
    expect(typeof result.filesModified).toBe("number");
    expect(typeof result.occurrences).toBe("number");
  });
});

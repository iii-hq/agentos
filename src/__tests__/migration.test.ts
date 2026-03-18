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

const mockFiles: Record<string, string> = {};
const mockDirs: Set<string> = new Set();

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    if (mockFiles[path] !== undefined) return mockFiles[path];
    throw new Error("ENOENT");
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    mockFiles[path] = content;
  }),
  mkdir: vi.fn(async (path: string) => {
    mockDirs.add(path);
  }),
  readdir: vi.fn(async (dir: string) => {
    const entries = Object.keys(mockFiles)
      .filter((f) => f.startsWith(dir) && f !== dir)
      .map((f) => {
        const rel = f.slice(dir.length + 1);
        const name = rel.split("/")[0];
        return {
          name: name + (rel.includes(".") ? "" : ""),
          isDirectory: () => !name.includes("."),
          isFile: () => name.includes("."),
        };
      });
    return entries;
  }),
  access: vi.fn(async (path: string) => {
    if (!mockFiles[path] && !mockDirs.has(path)) throw new Error("ENOENT");
  }),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb: Function) => {
    cb(new Error("not found"), "", "");
  }),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  mockDirs.clear();
});

beforeAll(async () => {
  await import("../migration.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("migrate::openclaw", () => {
  it("returns empty report when no config found", async () => {
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.framework).toBe("openclaw");
    expect(result.items).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("migrates agents from config", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: {
        researcher: {
          model: "claude-sonnet",
          system_prompt: "You are a researcher",
          tools: ["web_search", "file_read"],
        },
      },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.items.length).toBe(1);
    expect(result.items[0].type).toBe("agent");
    expect(result.items[0].status).toBe("migrated");
  });

  it("migrates channels from config", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      channels: {
        slack: { type: "slack", webhook: "hooks.slack.com" },
      },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.items[0].type).toBe("channel");
    expect(result.items[0].status).toBe("migrated");
  });

  it("skips channels without type", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      channels: { bad: {} },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.items[0].status).toBe("skipped");
    expect(result.items[0].reason).toContain("No channel type");
  });

  it("skips disabled cron jobs", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      cron: {
        daily: { schedule: "0 0 * * *", agent: "a1", enabled: false },
      },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.items[0].status).toBe("skipped");
  });

  it("skips disabled skills", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      skills: { myskill: { path: "/tmp/skill.md", enabled: false } },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.items[0].status).toBe("skipped");
  });

  it("produces correct summary counts", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: { a1: { model: "gpt-4", tools: [] } },
      channels: { notype: {} },
    });
    const result = await call("migrate::openclaw", { dryRun: true });
    expect(result.summary.total).toBe(2);
    expect(result.summary.migrated).toBe(1);
    expect(result.summary.skipped).toBe(1);
  });
});

describe("migrate::openclaw - tool mapping", () => {
  it("maps web_search to tool::web_search", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: {
        mapper: { model: "gpt-4", tools: ["web_search"] },
      },
    });
    const result = await call("migrate::openclaw", { dryRun: false });
    const agentFile = mockFiles["agents/mapper/agent.toml"];
    expect(agentFile).toContain("tool::web_search");
  });

  it("maps unknown tools with custom:: prefix", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: {
        custom: { model: "gpt-4", tools: ["my_custom_tool"] },
      },
    });
    const result = await call("migrate::openclaw", { dryRun: false });
    const agentFile = mockFiles["agents/custom/agent.toml"];
    expect(agentFile).toContain("custom::my_custom_tool");
  });
});

describe("migrate::openclaw - model mapping", () => {
  it("maps gpt-4 to claude-sonnet-4-6", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: { test: { model: "gpt-4", tools: [] } },
    });
    await call("migrate::openclaw", { dryRun: false });
    const file = mockFiles["agents/test/agent.toml"];
    expect(file).toContain("claude-sonnet-4-6");
  });

  it("maps gpt-4o-mini to claude-haiku-3.5", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: { mini: { model: "gpt-4o-mini", tools: [] } },
    });
    await call("migrate::openclaw", { dryRun: false });
    const file = mockFiles["agents/mini/agent.toml"];
    expect(file).toContain("claude-haiku-3.5");
  });

  it("preserves unknown model names", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = JSON.stringify({
      agents: { unknown: { model: "custom-model-v2", tools: [] } },
    });
    await call("migrate::openclaw", { dryRun: false });
    const file = mockFiles["agents/unknown/agent.toml"];
    expect(file).toContain("custom-model-v2");
  });
});

describe("migrate::scan - framework detection", () => {
  it("returns scan results for all frameworks", async () => {
    const result = await call("migrate::scan", {});
    expect(result.frameworks.length).toBeGreaterThan(10);
    expect(result.summary.scanned).toBeGreaterThan(0);
  });

  it("detects openclaw config when present", async () => {
    const home = process.env.HOME || "/root";
    mockFiles[`${home}/.openclaw/openclaw.json`] = "{}";
    const result = await call("migrate::scan", {});
    const openclaw = result.frameworks.find(
      (f: any) => f.framework === "openclaw",
    );
    expect(openclaw.detected).toBe(true);
    expect(openclaw.migratable).toBe(true);
  });

  it("reports not detected for missing frameworks", async () => {
    const result = await call("migrate::scan", {});
    const missing = result.frameworks.find(
      (f: any) => f.framework === "crewai",
    );
    expect(missing.detected).toBe(false);
  });
});

describe("migrate::langchain", () => {
  it("returns empty report when no Python files found", async () => {
    const result = await call("migrate::langchain", {
      dryRun: true,
      configDir: "/empty",
    });
    expect(result.framework).toBe("langchain");
    expect(result.items).toHaveLength(0);
  });
});

describe("migrate::report", () => {
  it("returns report with zero items when no reports exist", async () => {
    const result = await call("migrate::report", {});
    expect(result.markdown).toContain("Migration Report");
    expect(result.aggregated.totals.total).toBe(0);
  });
});

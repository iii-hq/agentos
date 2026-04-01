import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import path from "path";

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
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "agent::create") return { id: data.id };
  if (fnId === "agent::chat") return { content: "mock response" };
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
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  assertNoSsrf: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "10.0.0.1" ||
      parsed.hostname === "169.254.169.254"
    ) {
      throw new Error(`SSRF blocked: ${parsed.hostname}`);
    }
  }),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.includes("not-found")) throw new Error("ENOENT");
    return "file content";
  }),
  writeFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => [
    { name: "file1.ts", isDirectory: () => false },
    { name: "src", isDirectory: () => true },
  ]),
  stat: vi.fn(async () => ({
    size: 1234,
    mtime: new Date("2026-01-01"),
  })),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb?: Function) => {
    if (!cb && typeof opts === "function") {
      cb = opts;
    }
    if (cmd === "rm" || cmd === "sudo" || cmd === "chmod") {
      const err: any = new Error("not allowed");
      err.code = 1;
      cb?.(err, "", "not allowed");
      return;
    }
    cb?.(null, "mock stdout", "");
  }),
}));

const WORKSPACE_ROOT = process.cwd();

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../tools.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("tool::file_read - path containment", () => {
  it("reads a file within workspace", async () => {
    const result = await call("tool::file_read", { path: "readme.md" });
    expect(result.content).toBe("file content");
  });

  it("rejects path traversal with ../", async () => {
    await expect(
      call("tool::file_read", { path: "../../etc/passwd" }),
    ).rejects.toThrow(/path traversal/i);
  });

  it("rejects absolute paths outside workspace", async () => {
    await expect(
      call("tool::file_read", { path: "/etc/passwd" }),
    ).rejects.toThrow(/path traversal/i);
  });

  it("limits content with maxBytes", async () => {
    const result = await call("tool::file_read", {
      path: "test.txt",
      maxBytes: 4,
    });
    expect(result.content).toBe("file");
  });

  it("returns file size in result", async () => {
    const result = await call("tool::file_read", { path: "test.txt" });
    expect(result.size).toBe(12);
  });
});

describe("tool::file_write - path containment", () => {
  it("writes file within workspace", async () => {
    const result = await call("tool::file_write", {
      path: "output.txt",
      content: "hello",
    });
    expect(result.written).toBe(true);
    expect(result.size).toBe(5);
  });

  it("rejects path traversal on write", async () => {
    await expect(
      call("tool::file_write", {
        path: "../../../tmp/evil.sh",
        content: "bad",
      }),
    ).rejects.toThrow(/path traversal/i);
  });
});

describe("tool::file_list", () => {
  it("lists directory contents", async () => {
    const result = await call("tool::file_list", { path: "." });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].name).toBe("file1.ts");
  });

  it("rejects path traversal on list", async () => {
    await expect(call("tool::file_list", { path: "../../" })).rejects.toThrow(
      /path traversal/i,
    );
  });
});

describe("tool::apply_patch", () => {
  it("applies a basic patch", async () => {
    const result = await call("tool::apply_patch", {
      path: "file.ts",
      patch: "@@ -1,1 +1,1 @@\n+new line",
    });
    expect(result.patched).toBe(true);
  });

  it("rejects path traversal on patch", async () => {
    await expect(
      call("tool::apply_patch", {
        path: "../../../etc/hosts",
        patch: "",
      }),
    ).rejects.toThrow(/path traversal/i);
  });
});

describe("tool::shell_exec - command allowlist", () => {
  it("allows 'git' command", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["git", "status"],
    });
    expect(result).toBeDefined();
  });

  it("allows 'node' command", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["node", "--version"],
    });
    expect(result).toBeDefined();
  });

  it("allows 'npm' command", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["npm", "list"],
    });
    expect(result).toBeDefined();
  });

  it("rejects 'rm' command", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["rm", "-rf", "/"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects 'sudo' command", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["sudo", "anything"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects 'chmod' command", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["chmod", "777", "file"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects 'bash' command", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["bash", "-c", "malicious"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects 'sh' command", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["sh", "-c", "evil"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects empty argv", async () => {
    await expect(call("tool::shell_exec", { argv: [] })).rejects.toThrow(
      "argv must be a non-empty array",
    );
  });

  it("rejects undefined argv", async () => {
    await expect(call("tool::shell_exec", {})).rejects.toThrow(
      "argv must be a non-empty array",
    );
  });

  it("allows 'python3' command", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["python3", "--version"],
    });
    expect(result).toBeDefined();
  });

  it("allows 'cargo' command", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["cargo", "build"],
    });
    expect(result).toBeDefined();
  });

  it("allows 'ls' command", async () => {
    const result = await call("tool::shell_exec", { argv: ["ls", "-la"] });
    expect(result).toBeDefined();
  });

  it("audits successful shell execution", async () => {
    await call("tool::shell_exec", { argv: ["git", "log"] });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "shell_exec" }),
    );
  });

  it("truncates stdout to 100k chars", async () => {
    const result = await call("tool::shell_exec", {
      argv: ["echo", "hello"],
    });
    expect(typeof result.stdout).toBe("string");
  });

  it("uses basename of command for allowlist check", async () => {
    await expect(
      call("tool::shell_exec", { argv: ["/usr/bin/rm", "-rf", "/"] }),
    ).rejects.toThrow("Command not allowed");
  });

  it("rejects path traversal in cwd", async () => {
    await expect(
      call("tool::shell_exec", {
        argv: ["ls"],
        cwd: "../../../",
      }),
    ).rejects.toThrow(/path traversal/i);
  });
});

describe("tool::web_fetch - SSRF prevention", () => {
  it("blocks localhost URLs", async () => {
    await expect(
      call("tool::web_fetch", { url: "http://localhost:8080/secret" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("blocks 127.0.0.1 URLs", async () => {
    await expect(
      call("tool::web_fetch", { url: "http://127.0.0.1/admin" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("blocks private network 10.x URLs", async () => {
    await expect(
      call("tool::web_fetch", { url: "http://10.0.0.1/internal" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("blocks cloud metadata endpoint", async () => {
    await expect(
      call("tool::web_fetch", {
        url: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow(/SSRF/);
  });
});

describe("tool::agent_spawn - depth limit", () => {
  it("spawns a sub-agent with depth 1 from root", async () => {
    const result = await call("tool::agent_spawn", {
      template: "researcher",
      message: "help me",
    });
    expect(result.agentId).toBeDefined();
    expect(result.depth).toBe(1);
  });

  it("increments depth from parent", async () => {
    seedKv("agent_depth", "parent-1", { depth: 2 });
    const result = await call("tool::agent_spawn", {
      template: "coder",
      parentId: "parent-1",
      message: "code this",
    });
    expect(result.depth).toBe(3);
  });

  it("rejects when max depth (5) is exceeded", async () => {
    seedKv("agent_depth", "deep-agent", { depth: 5 });
    await expect(
      call("tool::agent_spawn", {
        template: "sub",
        parentId: "deep-agent",
        message: "go deeper",
      }),
    ).rejects.toThrow("Max agent depth");
  });

  it("allows exactly at depth 4 (parent depth 4, child becomes 5)", async () => {
    seedKv("agent_depth", "agent-4", { depth: 4 });
    const result = await call("tool::agent_spawn", {
      template: "sub",
      parentId: "agent-4",
      message: "last level",
    });
    expect(result.depth).toBe(5);
  });

  it("records depth in state for spawned agent", async () => {
    await call("tool::agent_spawn", {
      template: "test",
      message: "hi",
    });
    const calls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set" && c[1]?.scope === "agent_depth",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1].value.depth).toBe(1);
  });
});

describe("tool::agent_send", () => {
  it("sends message when agent has wildcard capability", async () => {
    seedKv("agents", "sender-1", {
      capabilities: { tools: ["*"] },
    });
    const result = await call("tool::agent_send", {
      agentId: "sender-1",
      targetAgentId: "target-1",
      message: "hello",
    });
    expect(result.sent).toBe(true);
  });

  it("sends message when agent has agent::send capability", async () => {
    seedKv("agents", "sender-2", {
      capabilities: { tools: ["agent::send"] },
    });
    const result = await call("tool::agent_send", {
      agentId: "sender-2",
      targetAgentId: "target-2",
      message: "hi",
    });
    expect(result.sent).toBe(true);
  });

  it("denies when agent lacks send capability", async () => {
    seedKv("agents", "sender-3", {
      capabilities: { tools: ["tool::file_read"] },
    });
    await expect(
      call("tool::agent_send", {
        agentId: "sender-3",
        targetAgentId: "target-3",
        message: "blocked",
      }),
    ).rejects.toThrow("does not have agent::send capability");
  });

  it("allows send when no agentId provided (system context)", async () => {
    const result = await call("tool::agent_send", {
      agentId: "",
      targetAgentId: "target-4",
      message: "system message",
    });
    expect(result.sent).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import os from "os";

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
  if (fnId === "agent::chat")
    return { content: "mock llm response", model: "test-model" };
  if (fnId === "enqueue") return { ok: true };
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

vi.mock("@agentos/shared/utils", () => ({
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
    if (p.includes(".py"))
      return "def hello():\n  pass\nclass Foo:\n  pass\n# comment\n\n";
    return "function foo() {}\nconst bar = () => {}\n// comment\nclass Baz {}\n\nexport function qux() {}\n";
  }),
  writeFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ size: 100, mtime: new Date() })),
}));

vi.mock("child_process", () => {
  const { promisify } = require("util");
  const fn: any = vi.fn(
    (cmd: string, args: string[], opts: any, cb?: Function) => {
      if (!cb && typeof opts === "function") {
        cb = opts;
      }
      cb?.(null, "mock stdout output", "");
    },
  );
  fn[promisify.custom] = vi.fn(async () => ({
    stdout: "mock stdout output",
    stderr: "",
  }));
  return { execFile: fn };
});

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../tools-extended.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("tool::schedule_reminder", () => {
  it("creates reminder with valid time", async () => {
    const result = await call("tool::schedule_reminder", {
      label: "standup",
      time: "2030-01-01T09:00:00Z",
    });
    expect(result.id).toBeDefined();
    expect(result.label).toBe("standup");
    expect(result.time).toBe("2030-01-01T09:00:00.000Z");
  });

  it("stores reminder in state", async () => {
    await call("tool::schedule_reminder", {
      label: "test",
      time: "2030-06-15T12:00:00Z",
    });
    const calls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "state::set" && c[1]?.scope === "reminders",
    );
    expect(calls.length).toBe(1);
  });

  it("rejects invalid time format", async () => {
    await expect(
      call("tool::schedule_reminder", { label: "bad", time: "not-a-date" }),
    ).rejects.toThrow("Invalid time format");
  });

  it("accepts optional agentId", async () => {
    const result = await call("tool::schedule_reminder", {
      label: "agent-task",
      time: "2030-01-01T00:00:00Z",
      agentId: "agent-42",
    });
    expect(result.id).toBeDefined();
  });

  it("returns ISO time string", async () => {
    const result = await call("tool::schedule_reminder", {
      label: "iso",
      time: "2030-03-15",
    });
    expect(result.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("tool::cron_create", () => {
  it("creates cron job with valid inputs", async () => {
    const result = await call("tool::cron_create", {
      name: "daily-report",
      schedule: "0 9 * * *",
      functionId: "report::generate",
    });
    expect(result.created).toBe(true);
    expect(result.name).toBe("daily-report");
  });

  it("stores cron job in state", async () => {
    await call("tool::cron_create", {
      name: "test-cron",
      schedule: "*/5 * * * *",
      functionId: "test::run",
    });
    const stored = getScope("cron_jobs").get("test-cron") as any;
    expect(stored).toBeDefined();
    expect(stored.functionId).toBe("test::run");
  });

  it("rejects invalid cron name with spaces", async () => {
    await expect(
      call("tool::cron_create", {
        name: "bad name",
        schedule: "* * * * *",
        functionId: "test::fn",
      }),
    ).rejects.toThrow("Invalid cron name");
  });

  it("rejects empty cron name", async () => {
    await expect(
      call("tool::cron_create", {
        name: "",
        schedule: "* * * * *",
        functionId: "test::fn",
      }),
    ).rejects.toThrow("Invalid cron name");
  });

  it("rejects invalid functionId with spaces", async () => {
    await expect(
      call("tool::cron_create", {
        name: "valid",
        schedule: "* * * * *",
        functionId: "bad function id",
      }),
    ).rejects.toThrow("Invalid function ID");
  });

  it("accepts payload parameter", async () => {
    const result = await call("tool::cron_create", {
      name: "with-payload",
      schedule: "0 0 * * 0",
      functionId: "weekly::task",
      payload: { key: "value" },
    });
    expect(result.created).toBe(true);
  });
});

describe("tool::cron_list", () => {
  it("returns empty array when no cron jobs", async () => {
    const result = await call("tool::cron_list", {});
    expect(result).toEqual([]);
  });

  it("returns stored cron jobs", async () => {
    seedKv("cron_jobs", "job1", { name: "job1", schedule: "* * * * *" });
    seedKv("cron_jobs", "job2", { name: "job2", schedule: "0 9 * * *" });
    const result = await call("tool::cron_list", {});
    expect(result).toHaveLength(2);
  });
});

describe("tool::cron_delete", () => {
  it("deletes a cron job", async () => {
    seedKv("cron_jobs", "to-delete", { name: "to-delete" });
    const result = await call("tool::cron_delete", { name: "to-delete" });
    expect(result.deleted).toBe(true);
    expect(result.name).toBe("to-delete");
  });
});

describe("tool::todo_create", () => {
  it("creates a todo with defaults", async () => {
    const result = await call("tool::todo_create", { title: "Test task" });
    expect(result.id).toBeDefined();
    expect(result.title).toBe("Test task");
    expect(result.priority).toBe("medium");
    expect(result.status).toBe("pending");
  });

  it("creates todo with all fields", async () => {
    const result = await call("tool::todo_create", {
      title: "Urgent task",
      description: "Do this now",
      priority: "high",
      assignee: "alice",
    });
    expect(result.priority).toBe("high");
    expect(result.assignee).toBe("alice");
    expect(result.description).toBe("Do this now");
  });

  it("stores todo in state", async () => {
    const result = await call("tool::todo_create", { title: "Stored" });
    const stored = getScope("todos").get(result.id);
    expect(stored).toBeDefined();
  });

  it("sets createdAt and updatedAt timestamps", async () => {
    const before = Date.now();
    const result = await call("tool::todo_create", { title: "Timed" });
    expect(result.createdAt).toBeGreaterThanOrEqual(before);
    expect(result.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("tool::todo_list", () => {
  it("returns empty array when no todos", async () => {
    const result = await call("tool::todo_list", {});
    expect(result).toEqual([]);
  });

  it("filters by status", async () => {
    seedKv("todos", "1", { status: "pending", title: "A" });
    seedKv("todos", "2", { status: "done", title: "B" });
    const result = await call("tool::todo_list", { status: "pending" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("A");
  });

  it("filters by assignee", async () => {
    seedKv("todos", "1", { assignee: "alice", title: "A" });
    seedKv("todos", "2", { assignee: "bob", title: "B" });
    const result = await call("tool::todo_list", { assignee: "bob" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("B");
  });

  it("returns all when no filters", async () => {
    seedKv("todos", "1", { status: "pending", title: "A" });
    seedKv("todos", "2", { status: "done", title: "B" });
    const result = await call("tool::todo_list", {});
    expect(result).toHaveLength(2);
  });
});

describe("tool::todo_update", () => {
  it("updates todo status", async () => {
    seedKv("todos", "t1", {
      id: "t1",
      title: "Task",
      status: "pending",
      updatedAt: 0,
    });
    const result = await call("tool::todo_update", {
      id: "t1",
      status: "done",
    });
    expect(result.status).toBe("done");
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("throws when todo not found", async () => {
    await expect(
      call("tool::todo_update", { id: "nonexistent", status: "done" }),
    ).rejects.toThrow("Todo not found");
  });

  it("updates multiple fields at once", async () => {
    seedKv("todos", "t2", { id: "t2", title: "Old", priority: "low" });
    const result = await call("tool::todo_update", {
      id: "t2",
      title: "New",
      priority: "high",
      assignee: "carol",
    });
    expect(result.title).toBe("New");
    expect(result.priority).toBe("high");
    expect(result.assignee).toBe("carol");
  });
});

describe("tool::todo_delete", () => {
  it("deletes a todo", async () => {
    seedKv("todos", "del-1", { title: "Delete me" });
    const result = await call("tool::todo_delete", { id: "del-1" });
    expect(result.deleted).toBe(true);
    expect(result.id).toBe("del-1");
  });
});

describe("tool::image_analyze", () => {
  it("analyzes image with default prompt", async () => {
    const result = await call("tool::image_analyze", {
      url: "https://example.com/image.png",
    });
    expect(result.url).toBe("https://example.com/image.png");
    expect(result.description).toBeDefined();
  });

  it("uses custom prompt when provided", async () => {
    const result = await call("tool::image_analyze", {
      url: "https://example.com/img.jpg",
      prompt: "Count the objects",
    });
    expect(result.description).toBeDefined();
  });

  it("blocks SSRF on localhost URLs", async () => {
    await expect(
      call("tool::image_analyze", { url: "http://localhost/secret.png" }),
    ).rejects.toThrow(/SSRF/);
  });
});

describe("tool::audio_transcribe", () => {
  it("returns not_implemented status", async () => {
    const result = await call("tool::audio_transcribe", {
      url: "https://example.com/audio.mp3",
    });
    expect(result.status).toBe("not_implemented");
    expect(result.transcript).toBeNull();
  });

  it("blocks SSRF on private URLs", async () => {
    await expect(
      call("tool::audio_transcribe", { url: "http://10.0.0.1/audio.wav" }),
    ).rejects.toThrow(/SSRF/);
  });
});

describe("tool::tts_speak", () => {
  it("returns not_implemented status", async () => {
    const result = await call("tool::tts_speak", { text: "Hello world" });
    expect(result.status).toBe("not_implemented");
    expect(result.audioUrl).toBeNull();
  });

  it("accepts voice parameter", async () => {
    const result = await call("tool::tts_speak", {
      text: "test",
      voice: "alloy",
    });
    expect(result.status).toBe("not_implemented");
  });
});

describe("tool::media_download", () => {
  it("blocks SSRF on private IPs", async () => {
    await expect(
      call("tool::media_download", {
        url: "http://127.0.0.1/file.zip",
        outputPath: "out.zip",
      }),
    ).rejects.toThrow(/SSRF/);
  });

  it("blocks path traversal", async () => {
    await expect(
      call("tool::media_download", {
        url: "https://example.com/file.zip",
        outputPath: "../../etc/passwd",
      }),
    ).rejects.toThrow(/Path traversal/);
  });
});

describe("tool::kg_add", () => {
  it("adds a new entity", async () => {
    const result = await call("tool::kg_add", {
      entity: "React",
      type: "framework",
    });
    expect(result.entity).toBe("react");
    expect(result.type).toBe("framework");
    expect(result.relationsCount).toBe(0);
  });

  it("adds entity with relation", async () => {
    const result = await call("tool::kg_add", {
      entity: "TypeScript",
      type: "language",
      relation: "compiles_to",
      target: "JavaScript",
    });
    expect(result.relationsCount).toBe(1);
  });

  it("normalizes entity key to lowercase with underscores", async () => {
    const result = await call("tool::kg_add", {
      entity: "Hello World",
      type: "test",
    });
    expect(result.entity).toBe("hello_world");
  });

  it("merges properties on existing entity", async () => {
    seedKv("knowledge_graph", "react", {
      entity: "React",
      type: "framework",
      relations: [],
      properties: { version: "19" },
    });
    await call("tool::kg_add", {
      entity: "React",
      type: "framework",
      properties: { creator: "Meta" },
    });
    const stored = getScope("knowledge_graph").get("react") as any;
    expect(stored.properties.version).toBe("19");
    expect(stored.properties.creator).toBe("Meta");
  });

  it("avoids duplicate relations", async () => {
    await call("tool::kg_add", {
      entity: "A",
      type: "node",
      relation: "connects",
      target: "B",
    });
    await call("tool::kg_add", {
      entity: "A",
      type: "node",
      relation: "connects",
      target: "B",
    });
    const stored = getScope("knowledge_graph").get("a") as any;
    expect(stored.relations).toHaveLength(1);
  });
});

describe("tool::kg_query", () => {
  it("returns empty for non-existent entity", async () => {
    const result = await call("tool::kg_query", { entity: "nonexistent" });
    expect(result.nodes).toHaveLength(0);
  });

  it("returns node at depth 0", async () => {
    seedKv("knowledge_graph", "root", {
      entity: "root",
      type: "node",
      relations: [],
    });
    const result = await call("tool::kg_query", { entity: "root" });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]._depth).toBe(0);
  });

  it("caps depth at 5", async () => {
    const result = await call("tool::kg_query", { entity: "x", depth: 100 });
    expect(result.totalVisited).toBeLessThanOrEqual(100);
  });

  it("filters by relation type", async () => {
    seedKv("knowledge_graph", "parent", {
      entity: "parent",
      type: "node",
      relations: [
        { relation: "child_of", target: "child1" },
        { relation: "sibling_of", target: "sibling1" },
      ],
    });
    seedKv("knowledge_graph", "child1", {
      entity: "child1",
      type: "node",
      relations: [],
    });
    const result = await call("tool::kg_query", {
      entity: "parent",
      relation: "child_of",
    });
    expect(result.nodes.length).toBeLessThanOrEqual(2);
  });
});

describe("tool::kg_visualize", () => {
  it("returns empty mermaid for non-existent entity", async () => {
    const result = await call("tool::kg_visualize", { entity: "missing" });
    expect(result.mermaid).toContain("graph TD");
    expect(result.edgeCount).toBe(0);
  });

  it("generates mermaid edges", async () => {
    seedKv("knowledge_graph", "a", {
      entity: "a",
      relations: [{ relation: "knows", target: "b" }],
    });
    seedKv("knowledge_graph", "b", {
      entity: "b",
      relations: [],
    });
    const result = await call("tool::kg_visualize", { entity: "a" });
    expect(result.mermaid).toContain("a -->|knows| b");
    expect(result.edgeCount).toBe(1);
  });

  it("caps depth at 4", async () => {
    const result = await call("tool::kg_visualize", {
      entity: "x",
      depth: 100,
    });
    expect(result.nodeCount).toBeLessThanOrEqual(50);
  });
});

describe("tool::memory_store", () => {
  it("stores memory with defaults", async () => {
    const result = await call("tool::memory_store", {
      key: "mem1",
      content: "Test memory content",
    });
    expect(result.stored).toBe(true);
    expect(result.key).toBe("mem1");
  });

  it("stores memory with tags and importance", async () => {
    const result = await call("tool::memory_store", {
      key: "tagged",
      content: "Important data",
      tags: ["project", "deadline"],
      importance: 9,
    });
    expect(result.stored).toBe(true);
    const stored = getScope("memories").get("tagged") as any;
    expect(stored.tags).toEqual(["project", "deadline"]);
    expect(stored.importance).toBe(9);
  });

  it("generates UUID key when none provided", async () => {
    const result = await call("tool::memory_store", {
      key: "",
      content: "auto-keyed",
    });
    expect(result.key).toBeDefined();
    expect(result.key.length).toBeGreaterThan(0);
  });

  it("initializes accessCount to 0", async () => {
    await call("tool::memory_store", { key: "count-test", content: "data" });
    const stored = getScope("memories").get("count-test") as any;
    expect(stored.accessCount).toBe(0);
  });
});

describe("tool::memory_recall", () => {
  it("returns found:false for missing key", async () => {
    const result = await call("tool::memory_recall", { key: "missing" });
    expect(result.found).toBe(false);
  });

  it("returns memory and increments access count", async () => {
    seedKv("memories", "existing", {
      content: "Hello",
      accessCount: 0,
      tags: [],
    });
    const result = await call("tool::memory_recall", { key: "existing" });
    expect(result.found).toBe(true);
    expect(result.content).toBe("Hello");
    expect(result.accessCount).toBe(1);
  });

  it("sets lastAccessed timestamp", async () => {
    seedKv("memories", "ts-test", { content: "test", accessCount: 0 });
    const before = Date.now();
    const result = await call("tool::memory_recall", { key: "ts-test" });
    expect(result.lastAccessed).toBeGreaterThanOrEqual(before);
  });
});

describe("tool::memory_search", () => {
  it("returns empty results for no matches", async () => {
    const result = await call("tool::memory_search", { query: "xyz" });
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("finds memories by content", async () => {
    seedKv("memories", "m1", { content: "React hooks tutorial", tags: [] });
    seedKv("memories", "m2", { content: "Vue composition API", tags: [] });
    const result = await call("tool::memory_search", { query: "react" });
    expect(result.total).toBe(1);
  });

  it("finds memories by tag", async () => {
    seedKv("memories", "m1", {
      content: "data",
      tags: ["typescript", "testing"],
    });
    const result = await call("tool::memory_search", { query: "typescript" });
    expect(result.total).toBe(1);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 30; i++) {
      seedKv("memories", `m-${i}`, { content: `match item ${i}`, tags: [] });
    }
    const result = await call("tool::memory_search", {
      query: "match",
      limit: 5,
    });
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it("defaults limit to 20", async () => {
    for (let i = 0; i < 30; i++) {
      seedKv("memories", `m-${i}`, { content: `test item ${i}`, tags: [] });
    }
    const result = await call("tool::memory_search", { query: "test" });
    expect(result.results.length).toBeLessThanOrEqual(20);
  });
});

describe("tool::agent_list", () => {
  it("returns empty array when no agents", async () => {
    const result = await call("tool::agent_list", {});
    expect(result).toEqual([]);
  });

  it("returns agents with name, id, tags", async () => {
    seedKv("agents", "a1", {
      name: "researcher",
      tags: ["research"],
      createdAt: 100,
    });
    const result = await call("tool::agent_list", {});
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("researcher");
    expect(result[0].id).toBe("a1");
  });

  it("filters out agents without names", async () => {
    seedKv("agents", "a1", { tags: [] });
    seedKv("agents", "a2", { name: "valid", tags: [] });
    const result = await call("tool::agent_list", {});
    expect(result).toHaveLength(1);
  });
});

describe("tool::agent_delegate", () => {
  it("delegates task to agent", async () => {
    const result = await call("tool::agent_delegate", {
      agentId: "researcher",
      task: "Find information about X",
    });
    expect(result.agentId).toBe("researcher");
    expect(result.response).toBe("mock llm response");
  });

  it("includes context in message when provided", async () => {
    await call("tool::agent_delegate", {
      agentId: "coder",
      task: "Write tests",
      context: "TypeScript project",
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls[0][1].message).toContain("Context: TypeScript project");
  });
});

describe("tool::channel_send", () => {
  it("sends message to channel", async () => {
    const result = await call("tool::channel_send", {
      channel: "slack",
      channelId: "C123",
      message: "Hello team",
    });
    expect(result.sent).toBe(true);
    expect(result.channel).toBe("slack");
  });

  it("uses triggerVoid for enqueue", async () => {
    await call("tool::channel_send", {
      channel: "discord",
      channelId: "guild-1",
      message: "test",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "enqueue",
      expect.objectContaining({
        topic: "discord.outbound",
      }),
    );
  });
});

describe("tool::env_get", () => {
  it("returns allowed env var", async () => {
    const result = await call("tool::env_get", { name: "PATH" });
    expect(result.name).toBe("PATH");
    expect(result.value).toBeDefined();
  });

  it("returns HOME env var", async () => {
    const result = await call("tool::env_get", { name: "HOME" });
    expect(result.name).toBe("HOME");
  });

  it("blocks access to SECRET env vars", async () => {
    await expect(
      call("tool::env_get", { name: "AWS_SECRET_ACCESS_KEY" }),
    ).rejects.toThrow("Access denied");
  });

  it("blocks access to API keys", async () => {
    await expect(
      call("tool::env_get", { name: "ANTHROPIC_API_KEY" }),
    ).rejects.toThrow("Access denied");
  });

  it("lists allowed vars in error message", async () => {
    try {
      await call("tool::env_get", { name: "FORBIDDEN" });
    } catch (e: any) {
      expect(e.message).toContain("PATH");
      expect(e.message).toContain("HOME");
    }
  });
});

describe("tool::system_info", () => {
  it("returns system information", async () => {
    const result = await call("tool::system_info", {});
    expect(result.platform).toBe(os.platform());
    expect(result.arch).toBe(os.arch());
    expect(typeof result.cpus).toBe("number");
    expect(result.totalMemory).toBeGreaterThan(0);
    expect(result.nodeVersion).toMatch(/^v\d+/);
  });

  it("includes hostname", async () => {
    const result = await call("tool::system_info", {});
    expect(result.hostname).toBe(os.hostname());
  });

  it("includes uptime", async () => {
    const result = await call("tool::system_info", {});
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("tool::process_list", () => {
  it("returns process list", async () => {
    const result = await call("tool::process_list", {});
    expect(result.processes).toBeDefined();
    expect(Array.isArray(result.processes)).toBe(true);
  });

  it("truncates to max 50 lines", async () => {
    const result = await call("tool::process_list", {});
    expect(result.processes.length).toBeLessThanOrEqual(50);
  });
});

describe("tool::code_analyze", () => {
  it("analyzes TypeScript file", async () => {
    const result = await call("tool::code_analyze", { filePath: "test.ts" });
    expect(result.totalLines).toBeGreaterThan(0);
    expect(result.extension).toBe(".ts");
    expect(typeof result.functions).toBe("number");
    expect(typeof result.classes).toBe("number");
    expect(typeof result.comments).toBe("number");
  });

  it("analyzes Python file", async () => {
    const result = await call("tool::code_analyze", { filePath: "test.py" });
    expect(result.extension).toBe(".py");
  });

  it("counts code, blank, and comment lines", async () => {
    const result = await call("tool::code_analyze", { filePath: "test.ts" });
    expect(result.codeLines).toBe(
      result.totalLines - result.blankLines - result.comments,
    );
  });

  it("rejects path traversal", async () => {
    await expect(
      call("tool::code_analyze", { filePath: "../../etc/passwd" }),
    ).rejects.toThrow(/Path traversal/);
  });
});

describe("tool::code_format", () => {
  it("formats TypeScript file with prettier", async () => {
    const result = await call("tool::code_format", { filePath: "test.ts" });
    expect(result.formatted).toBe(true);
  });

  it("uses rustfmt for .rs files", async () => {
    const result = await call("tool::code_format", { filePath: "test.rs" });
    expect(result).toBeDefined();
  });

  it("uses black for .py files", async () => {
    const result = await call("tool::code_format", { filePath: "test.py" });
    expect(result).toBeDefined();
  });

  it("rejects path traversal", async () => {
    await expect(
      call("tool::code_format", { filePath: "../../../etc/hosts" }),
    ).rejects.toThrow(/Path traversal/);
  });
});

describe("tool::code_lint", () => {
  it("lints TypeScript with eslint", async () => {
    const result = await call("tool::code_lint", { filePath: "test.ts" });
    expect(result.path).toBeDefined();
  });

  it("uses clippy for .rs files", async () => {
    const result = await call("tool::code_lint", { filePath: "main.rs" });
    expect(result).toBeDefined();
  });

  it("rejects path traversal", async () => {
    await expect(
      call("tool::code_lint", { filePath: "../../secret.py" }),
    ).rejects.toThrow(/Path traversal/);
  });
});

describe("tool::code_test", () => {
  it("runs npm test command", async () => {
    const result = await call("tool::code_test", {
      command: ["npm", "test"],
    });
    expect(result.exitCode).toBe(0);
  });

  it("rejects empty command array", async () => {
    await expect(call("tool::code_test", { command: [] })).rejects.toThrow(
      "command must be a non-empty array",
    );
  });

  it("rejects disallowed test command", async () => {
    await expect(
      call("tool::code_test", { command: ["rm", "-rf", "/"] }),
    ).rejects.toThrow("Test command not allowed");
  });

  it("allows cargo test", async () => {
    const result = await call("tool::code_test", {
      command: ["cargo", "test"],
    });
    expect(result).toBeDefined();
  });

  it("allows python test", async () => {
    const result = await call("tool::code_test", {
      command: ["python3", "-m", "pytest"],
    });
    expect(result).toBeDefined();
  });

  it("rejects path traversal in cwd", async () => {
    await expect(
      call("tool::code_test", {
        command: ["npm", "test"],
        cwd: "../../../",
      }),
    ).rejects.toThrow(/Path traversal/);
  });

  it("rejects bash as test command", async () => {
    await expect(
      call("tool::code_test", { command: ["bash", "-c", "evil"] }),
    ).rejects.toThrow("Test command not allowed");
  });
});

describe("tool::json_transform", () => {
  it("returns parsed data with identity expression", async () => {
    const result = await call("tool::json_transform", {
      data: '{"name":"test"}',
      expression: ".",
    });
    expect(result.result).toEqual({ name: "test" });
  });

  it("extracts keys", async () => {
    const result = await call("tool::json_transform", {
      data: '{"a":1,"b":2}',
      expression: ".keys",
    });
    expect(result.result).toEqual(["a", "b"]);
  });

  it("extracts values", async () => {
    const result = await call("tool::json_transform", {
      data: '{"a":1,"b":2}',
      expression: ".values",
    });
    expect(result.result).toEqual([1, 2]);
  });

  it("returns length of array", async () => {
    const result = await call("tool::json_transform", {
      data: "[1,2,3]",
      expression: ".length",
    });
    expect(result.result).toBe(3);
  });

  it("returns length of object keys", async () => {
    const result = await call("tool::json_transform", {
      data: '{"a":1,"b":2,"c":3}',
      expression: ".length",
    });
    expect(result.result).toBe(3);
  });

  it("navigates nested path", async () => {
    const result = await call("tool::json_transform", {
      data: '{"a":{"b":{"c":42}}}',
      expression: ".a.b.c",
    });
    expect(result.result).toBe(42);
  });

  it("throws on invalid JSON", async () => {
    await expect(
      call("tool::json_transform", {
        data: "not-json",
        expression: ".",
      }),
    ).rejects.toThrow();
  });
});

describe("tool::csv_parse", () => {
  it("parses CSV with headers", async () => {
    const result = await call("tool::csv_parse", {
      content: "name,age\nAlice,30\nBob,25",
    });
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0]).toEqual({ name: "Alice", age: "30" });
  });

  it("parses CSV without headers", async () => {
    const result = await call("tool::csv_parse", {
      content: "Alice,30\nBob,25",
      hasHeader: false,
    });
    expect(result.headers).toEqual([]);
    expect(result.rows[0]).toEqual(["Alice", "30"]);
  });

  it("supports custom delimiter", async () => {
    const result = await call("tool::csv_parse", {
      content: "name|age\nAlice|30",
      delimiter: "|",
    });
    expect(result.rows[0]).toEqual({ name: "Alice", age: "30" });
  });

  it("handles empty content", async () => {
    const result = await call("tool::csv_parse", { content: "" });
    expect(result.rows).toEqual([]);
  });

  it("strips quotes from values", async () => {
    const result = await call("tool::csv_parse", {
      content: '"name","age"\n"Alice","30"',
    });
    expect(result.rows[0]).toEqual({ name: "Alice", age: "30" });
  });
});

describe("tool::yaml_parse", () => {
  it("parses simple key-value pairs", async () => {
    const result = await call("tool::yaml_parse", {
      content: "name: test\nversion: 1.0",
    });
    expect(result.result.name).toBe("test");
    expect(result.result.version).toBe(1.0);
  });

  it("parses boolean values", async () => {
    const result = await call("tool::yaml_parse", {
      content: "enabled: true\ndisabled: false",
    });
    expect(result.result.enabled).toBe(true);
    expect(result.result.disabled).toBe(false);
  });

  it("parses null value", async () => {
    const result = await call("tool::yaml_parse", {
      content: "value: null",
    });
    expect(result.result.value).toBeNull();
  });

  it("skips comments", async () => {
    const result = await call("tool::yaml_parse", {
      content: "# comment\nkey: value",
    });
    expect(result.result.key).toBe("value");
  });

  it("skips empty lines", async () => {
    const result = await call("tool::yaml_parse", {
      content: "a: 1\n\nb: 2",
    });
    expect(result.result.a).toBe(1);
    expect(result.result.b).toBe(2);
  });
});

describe("tool::regex_test", () => {
  it("finds matches with global flag", async () => {
    const result = await call("tool::regex_test", {
      pattern: "\\d+",
      text: "abc 123 def 456",
    });
    expect(result.count).toBe(2);
    expect(result.matches[0].match).toBe("123");
    expect(result.matches[1].match).toBe("456");
  });

  it("returns empty for no matches", async () => {
    const result = await call("tool::regex_test", {
      pattern: "xyz",
      text: "abc def",
    });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it("captures groups", async () => {
    const result = await call("tool::regex_test", {
      pattern: "(\\w+)@(\\w+)",
      text: "user@host",
    });
    expect(result.matches[0].captures).toEqual(["user", "host"]);
  });

  it("strips invalid flags", async () => {
    const result = await call("tool::regex_test", {
      pattern: "a",
      text: "abc",
      flags: "gxyz",
    });
    expect(result.flags).toBe("gy");
  });

  it("uses g flag by default", async () => {
    const result = await call("tool::regex_test", {
      pattern: "a",
      text: "aaa",
    });
    expect(result.count).toBe(3);
  });

  it("limits iterations to 1000", async () => {
    const result = await call("tool::regex_test", {
      pattern: ".",
      text: "a".repeat(2000),
    });
    expect(result.count).toBeLessThanOrEqual(1000);
  });
});

describe("tool::uuid_generate", () => {
  it("generates a single UUID by default", async () => {
    const result = await call("tool::uuid_generate", {});
    expect(result.uuids).toHaveLength(1);
    expect(result.uuids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates multiple UUIDs", async () => {
    const result = await call("tool::uuid_generate", { count: 5 });
    expect(result.uuids).toHaveLength(5);
    expect(result.count).toBe(5);
  });

  it("caps count at 100", async () => {
    const result = await call("tool::uuid_generate", { count: 500 });
    expect(result.uuids).toHaveLength(100);
    expect(result.count).toBe(100);
  });

  it("generates unique UUIDs", async () => {
    const result = await call("tool::uuid_generate", { count: 10 });
    const unique = new Set(result.uuids);
    expect(unique.size).toBe(10);
  });
});

describe("tool::hash_compute", () => {
  it("computes sha256 hash by default", async () => {
    const result = await call("tool::hash_compute", { input: "hello" });
    expect(result.algorithm).toBe("sha256");
    expect(result.encoding).toBe("hex");
    expect(result.hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("computes md5 hash", async () => {
    const result = await call("tool::hash_compute", {
      input: "hello",
      algorithm: "md5",
    });
    expect(result.algorithm).toBe("md5");
    expect(result.hash).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("computes sha1 hash", async () => {
    const result = await call("tool::hash_compute", {
      input: "hello",
      algorithm: "sha1",
    });
    expect(result.algorithm).toBe("sha1");
    expect(result.hash).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  it("supports base64 encoding", async () => {
    const result = await call("tool::hash_compute", {
      input: "test",
      encoding: "base64",
    });
    expect(result.encoding).toBe("base64");
    expect(result.hash).toBeDefined();
  });

  it("rejects unsupported algorithm", async () => {
    await expect(
      call("tool::hash_compute", { input: "test", algorithm: "ripemd160" }),
    ).rejects.toThrow("Unsupported algorithm");
  });

  it("lists allowed algorithms in error", async () => {
    try {
      await call("tool::hash_compute", { input: "x", algorithm: "bad" });
    } catch (e: any) {
      expect(e.message).toContain("sha256");
      expect(e.message).toContain("md5");
    }
  });

  it("supports sha512", async () => {
    const result = await call("tool::hash_compute", {
      input: "test",
      algorithm: "sha512",
    });
    expect(result.algorithm).toBe("sha512");
    expect(result.hash.length).toBe(128);
  });
});

describe("tool::image_generate_prompt", () => {
  it("generates prompt from description", async () => {
    const result = await call("tool::image_generate_prompt", {
      description: "A sunset over mountains",
    });
    expect(result.originalDescription).toBe("A sunset over mountains");
    expect(result.prompt).toBeDefined();
  });

  it("includes style when provided", async () => {
    await call("tool::image_generate_prompt", {
      description: "A cat",
      style: "watercolor",
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBeGreaterThan(0);
  });
});

describe("tool::disk_usage", () => {
  it("returns disk usage for workspace", async () => {
    const result = await call("tool::disk_usage", {});
    expect(result.output).toBeDefined();
  });

  it("accepts custom path", async () => {
    const result = await call("tool::disk_usage", { path: "/tmp" });
    expect(result.path).toBe("/tmp");
  });
});

describe("tool::network_check", () => {
  it("rejects private addresses", async () => {
    await expect(
      call("tool::network_check", { host: "127.0.0.1" }),
    ).rejects.toThrow("Cannot check private/reserved addresses");
  });

  it("rejects 192.168.x.x", async () => {
    await expect(
      call("tool::network_check", { host: "192.168.1.1" }),
    ).rejects.toThrow("Cannot check private/reserved addresses");
  });

  it("rejects 10.x.x.x", async () => {
    await expect(
      call("tool::network_check", { host: "10.0.0.1" }),
    ).rejects.toThrow("Cannot check private/reserved addresses");
  });

  it("rejects 172.16.x.x", async () => {
    await expect(
      call("tool::network_check", { host: "172.16.0.1" }),
    ).rejects.toThrow("Cannot check private/reserved addresses");
  });

  it("rejects 169.254.x.x", async () => {
    await expect(
      call("tool::network_check", { host: "169.254.169.254" }),
    ).rejects.toThrow("Cannot check private/reserved addresses");
  });
});

describe("tool::code_explain", () => {
  it("explains code file", async () => {
    const result = await call("tool::code_explain", { filePath: "test.ts" });
    expect(result.explanation).toBeDefined();
  });

  it("includes question in prompt when provided", async () => {
    await call("tool::code_explain", {
      filePath: "test.ts",
      question: "What does this do?",
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls.length).toBeGreaterThan(0);
  });

  it("rejects path traversal", async () => {
    await expect(
      call("tool::code_explain", { filePath: "../../etc/shadow" }),
    ).rejects.toThrow(/Path traversal/);
  });
});

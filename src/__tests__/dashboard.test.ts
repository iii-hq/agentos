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
    const entries = [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
    return { entries };
  }
  if (fnId === "agent::list")
    return {
      agents: [
        { name: "default", model: "claude-sonnet-4-6", status: "ready" },
      ],
    };
  if (fnId === "skill::list")
    return { skills: [{ name: "recall", tags: ["memory"] }] };
  if (fnId === "llm::usage")
    return {
      stats: [
        { requests: 100, input_tokens: 5000, output_tokens: 2000, cost: 0.15 },
      ],
    };
  if (fnId === "hand::list")
    return { hands: [{ id: "h1", name: "daily", enabled: true }] };
  if (fnId === "workflow::list")
    return { workflows: [{ name: "onboarding", steps: [1, 2] }] };
  if (fnId === "approval::list")
    return { pending: [{ id: "a1", action: "deploy" }] };
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
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../security-headers.js", () => ({
  SECURITY_HEADERS: { "X-Frame-Options": "DENY" },
}));

const ENV_KEY = process.env.AGENTOS_API_KEY;
const defaultMockImpl = async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::list") {
    const entries = [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
    return { entries };
  }
  if (fnId === "agent::list")
    return {
      agents: [
        { name: "default", model: "claude-sonnet-4-6", status: "ready" },
      ],
    };
  if (fnId === "skill::list")
    return { skills: [{ name: "recall", tags: ["memory"] }] };
  if (fnId === "llm::usage")
    return {
      stats: [
        { requests: 100, input_tokens: 5000, output_tokens: 2000, cost: 0.15 },
      ],
    };
  if (fnId === "hand::list")
    return { hands: [{ id: "h1", name: "daily", enabled: true }] };
  if (fnId === "workflow::list")
    return { workflows: [{ name: "onboarding", steps: [1, 2] }] };
  if (fnId === "approval::list")
    return { pending: [{ id: "a1", action: "deploy" }] };
  return null;
};

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(defaultMockImpl);
  mockTriggerVoid.mockClear();
  process.env.AGENTOS_API_KEY = "test-key";
});

beforeAll(async () => {
  await import("../dashboard.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("dashboard::page", () => {
  it("returns HTML content", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toBeDefined();
    expect(result.contentType).toBe("text/html");
  });

  it("contains AgentOS title", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("<title>AgentOS Dashboard</title>");
  });

  it("includes Tailwind CSS", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("cdn.tailwindcss.com");
  });

  it("includes Alpine.js", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("alpinejs");
  });

  it("includes security headers", async () => {
    const result = await call("dashboard::page", {});
    expect(result.headers).toBeDefined();
  });

  it("includes CSP header", async () => {
    const result = await call("dashboard::page", {});
    expect(result.headers["Content-Security-Policy"]).toBeDefined();
    expect(result.headers["Content-Security-Policy"]).toContain("default-src");
  });

  it("CSP blocks object-src", async () => {
    const result = await call("dashboard::page", {});
    expect(result.headers["Content-Security-Policy"]).toContain(
      "object-src 'none'",
    );
  });

  it("CSP blocks frame-ancestors", async () => {
    const result = await call("dashboard::page", {});
    expect(result.headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("includes navigation items in HTML", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("navItems");
  });

  it("includes overview cards section", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("overviewCards");
  });

  it("includes dark mode class", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("dark bg-surface-50");
  });

  it("includes dashboard JavaScript function", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("function dashboard()");
  });

  it("includes refresh interval", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("setInterval");
  });

  it("includes chat section", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("sendChat()");
  });

  it("includes approval handling", async () => {
    const result = await call("dashboard::page", {});
    expect(result.html).toContain("handleApproval");
  });
});

describe("dashboard::stats", () => {
  it("returns aggregated statistics", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.agents).toBeDefined();
    expect(result.skills).toBeDefined();
  });

  it("returns agent count", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.agents).toBe(1);
  });

  it("returns skill count", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.skills).toBe(1);
  });

  it("returns hand count", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.hands).toBe(1);
  });

  it("returns workflow count", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.workflows).toBe(1);
  });

  it("returns approval count", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.approvals).toBe(1);
  });

  it("returns token usage", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.tokens).toBeDefined();
    expect(result.tokens.input).toBe(5000);
    expect(result.tokens.output).toBe(2000);
    expect(result.tokens.total).toBe(7000);
  });

  it("returns total requests", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.requests).toBe(100);
  });

  it("returns cost", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.cost).toBe(0.15);
  });

  it("returns uptime", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.uptime).toBeGreaterThan(0);
  });

  it("returns agentList array", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.agentList).toHaveLength(1);
    expect(result.agentList[0].name).toBe("default");
  });

  it("returns skillList array", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.skillList).toHaveLength(1);
  });

  it("returns handList array", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.handList).toHaveLength(1);
  });

  it("returns workflowList array", async () => {
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.workflowList).toHaveLength(1);
  });

  it("handles trigger failures gracefully", async () => {
    mockTrigger.mockImplementation(async () => {
      throw new Error("fail");
    });
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result).toBeDefined();
  });

  it("limits sessionList to 50 entries", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::list" && data.scope === "sessions") {
        return { entries: Array(60).fill({ id: "s1" }) };
      }
      if (fnId === "agent::list") return { agents: [] };
      if (fnId === "skill::list") return { skills: [] };
      if (fnId === "llm::usage") return { stats: [] };
      if (fnId === "hand::list") return { hands: [] };
      if (fnId === "workflow::list") return { workflows: [] };
      if (fnId === "approval::list") return { pending: [] };
      return null;
    });
    const result = await call("dashboard::stats", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.sessionList.length).toBeLessThanOrEqual(50);
  });
});

describe("dashboard::events", () => {
  it("returns events from audit log", async () => {
    const result = await call("dashboard::events", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.events).toBeDefined();
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("respects limit parameter", async () => {
    const result = await call("dashboard::events", {
      body: { limit: 10 },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.events).toBeDefined();
  });

  it("defaults limit to 100", async () => {
    const result = await call("dashboard::events", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.events).toBeDefined();
  });

  it("handles empty audit log", async () => {
    const result = await call("dashboard::events", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.events).toEqual([]);
  });
});

describe("dashboard::logs", () => {
  it("returns system logs", async () => {
    const result = await call("dashboard::logs", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs).toBeDefined();
    expect(Array.isArray(result.logs)).toBe(true);
  });

  it("respects limit parameter", async () => {
    const result = await call("dashboard::logs", {
      body: { limit: 50 },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs).toBeDefined();
  });

  it("defaults limit to 200", async () => {
    const result = await call("dashboard::logs", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs).toBeDefined();
  });

  it("filters by level when specified", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "state::list")
        return {
          entries: [
            { level: "error", message: "bad" },
            { level: "info", message: "ok" },
          ],
        };
      return null;
    });
    const result = await call("dashboard::logs", {
      body: { level: "error" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs.every((l: any) => l.level === "error")).toBe(true);
  });

  it("returns all levels when level is 'all'", async () => {
    mockTrigger.mockImplementation(async (fnId: string) => {
      if (fnId === "state::list")
        return {
          entries: [
            { level: "error", message: "bad" },
            { level: "info", message: "ok" },
          ],
        };
      return null;
    });
    const result = await call("dashboard::logs", {
      body: { level: "all" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs).toHaveLength(2);
  });

  it("handles empty log store", async () => {
    const result = await call("dashboard::logs", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.logs).toEqual([]);
  });
});

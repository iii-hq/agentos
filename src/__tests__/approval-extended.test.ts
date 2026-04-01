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
  if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({ key, value }));
  }
  if (fnId === "state::update") {
    const existing: any = getScope(data.scope).get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") existing[op.path] = op.value;
    }
    getScope(data.scope).set(data.key, existing);
    return { ok: true };
  }
  if (fnId === "state::list_groups") {
    return Object.keys(kvStore);
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => { handlers[config.id] = handler; },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  sanitizeId: vi.fn((id: string) => id),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string, data?: any): Promise<any> => {
    if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
    if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
    if (fnId === "state::list") {
      return [...getScope(data.scope).entries()].map(([key, value]) => ({ key, value }));
    }
    if (fnId === "state::update") {
      const existing: any = getScope(data.scope).get(data.key) || {};
      for (const op of data.operations || []) {
        if (op.type === "set") existing[op.path] = op.value;
      }
      getScope(data.scope).set(data.key, existing);
      return { ok: true };
    }
    if (fnId === "state::list_groups") return Object.keys(kvStore);
    return null;
  });
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../approval.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("approval::check extended", () => {
  it("returns not required when no policy exists", async () => {
    const result = await call("approval::check", {
      agentId: "agent-1",
      toolName: "tool::exec",
      params: {},
    });
    expect(result.required).toBe(false);
  });

  it("returns not required when tool not in policy", async () => {
    getScope("approval_policy").set("default", { tools: ["tool::deploy"], timeoutMs: 300000 });
    const result = await call("approval::check", {
      agentId: "agent-1",
      toolName: "tool::read",
      params: {},
    });
    expect(result.required).toBe(false);
  });

  it("requires approval for exact tool match", async () => {
    getScope("approval_policy").set("default", { tools: ["tool::exec"], timeoutMs: 300000 });
    const result = await call("approval::check", {
      agentId: "agent-1",
      toolName: "tool::exec",
      params: {},
    });
    expect(result.required).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.requestId).toBeDefined();
  });

  it("requires approval for wildcard policy", async () => {
    getScope("approval_policy").set("default", { tools: ["*"], timeoutMs: 300000 });
    const result = await call("approval::check", {
      agentId: "agent-2",
      toolName: "any::tool",
      params: {},
    });
    expect(result.required).toBe(true);
  });

  it("requires approval for namespace wildcard", async () => {
    getScope("approval_policy").set("default", { tools: ["tool::*"], timeoutMs: 300000 });
    const result = await call("approval::check", {
      agentId: "agent-3",
      toolName: "tool::anything",
      params: {},
    });
    expect(result.required).toBe(true);
  });

  it("does not match different namespace wildcard", async () => {
    getScope("approval_policy").set("default", { tools: ["deploy::*"], timeoutMs: 300000 });
    const result = await call("approval::check", {
      agentId: "agent-4",
      toolName: "tool::exec",
      params: {},
    });
    expect(result.required).toBe(false);
  });

  it("throws when max pending reached", async () => {
    getScope("approval_policy").set("default", { tools: ["*"], timeoutMs: 300000 });
    for (let i = 0; i < 5; i++) {
      getScope("approvals:overflow-agent").set(`req-${i}`, {
        id: `req-${i}`, status: "pending", agentId: "overflow-agent",
        toolName: "tool::x", params: {}, reason: "test", createdAt: Date.now(), timeoutMs: 300000,
      });
    }
    await expect(
      call("approval::check", { agentId: "overflow-agent", toolName: "tool::next", params: {} }),
    ).rejects.toThrow("pending approvals");
  });

  it("publishes approval.requested event", async () => {
    getScope("approval_policy").set("default", { tools: ["*"], timeoutMs: 300000 });
    await call("approval::check", { agentId: "pub-agent", toolName: "tool::x", params: {} });
    const pubCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "publish");
    expect(pubCalls.some(c => c[1].topic === "approval.requested")).toBe(true);
  });

  it("publishes approval request via publish", async () => {
    getScope("approval_policy").set("default", { tools: ["*"], timeoutMs: 300000 });
    await call("approval::check", { agentId: "stream-agent", toolName: "tool::y", params: {} });
    const pubCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "publish");
    expect(pubCalls.some(c => c[1].topic === "approval.requested")).toBe(true);
  });

  it("uses custom timeoutMs from policy", async () => {
    getScope("approval_policy").set("default", { tools: ["*"], timeoutMs: 60000 });
    const result = await call("approval::check", { agentId: "tm-agent", toolName: "tool::z", params: {} });
    expect(result.required).toBe(true);
  });
});

describe("approval::decide extended", () => {
  it("approves a pending request", async () => {
    getScope("approvals:agent-d").set("req-1", {
      id: "req-1", status: "pending", agentId: "agent-d",
      toolName: "tool::x", params: {}, reason: "test", createdAt: Date.now(), timeoutMs: 300000,
    });
    const result = await call("approval::decide", {
      body: { requestId: "req-1", agentId: "agent-d", decision: "approve", decidedBy: "admin" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.status).toBe("approved");
  });

  it("denies a pending request", async () => {
    getScope("approvals:agent-e").set("req-2", {
      id: "req-2", status: "pending", agentId: "agent-e",
      toolName: "tool::y", params: {}, reason: "test", createdAt: Date.now(), timeoutMs: 300000,
    });
    const result = await call("approval::decide", {
      body: { requestId: "req-2", agentId: "agent-e", decision: "deny", decidedBy: "admin" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.status).toBe("denied");
  });

  it("publishes approval.decided event", async () => {
    getScope("approvals:agent-f").set("req-3", {
      id: "req-3", status: "pending", agentId: "agent-f",
      toolName: "tool::z", params: {}, reason: "test", createdAt: Date.now(), timeoutMs: 300000,
    });
    await call("approval::decide", {
      body: { requestId: "req-3", agentId: "agent-f", decision: "approve" },
      headers: { authorization: "Bearer test-key" },
    });
    const pubCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "publish");
    expect(pubCalls.some(c => c[1].topic === "approval.decided")).toBe(true);
  });

  it("uses system as default decidedBy", async () => {
    getScope("approvals:agent-g").set("req-4", {
      id: "req-4", status: "pending", agentId: "agent-g",
      toolName: "tool::a", params: {}, reason: "test", createdAt: Date.now(), timeoutMs: 300000,
    });
    await call("approval::decide", {
      body: { requestId: "req-4", agentId: "agent-g", decision: "approve" },
      headers: { authorization: "Bearer test-key" },
    });
    const updated: any = getScope("approvals:agent-g").get("req-4");
    expect(updated.decidedBy).toBe("system");
  });
});

describe("approval::list extended", () => {
  it("lists approvals for specific agent", async () => {
    getScope("approvals:agent-list").set("req-l1", { id: "req-l1", status: "pending", agentId: "agent-list" });
    getScope("approvals:agent-list").set("req-l2", { id: "req-l2", status: "approved", agentId: "agent-list" });
    const result = await call("approval::list", {
      body: { agentId: "agent-list" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.length).toBe(2);
  });

  it("filters by status", async () => {
    getScope("approvals:agent-filter").set("req-f1", { id: "req-f1", status: "pending", agentId: "agent-filter" });
    getScope("approvals:agent-filter").set("req-f2", { id: "req-f2", status: "approved", agentId: "agent-filter" });
    const result = await call("approval::list", {
      body: { agentId: "agent-filter", status: "pending" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.length).toBe(1);
    expect(result[0].status).toBe("pending");
  });

  it("lists all approvals when no agentId", async () => {
    getScope("approvals:a1").set("r1", { id: "r1", status: "pending", agentId: "a1", createdAt: 100 });
    getScope("approvals:a2").set("r2", { id: "r2", status: "pending", agentId: "a2", createdAt: 200 });
    const result = await call("approval::list", {
      body: {},
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.length).toBe(2);
  });

  it("sorts by createdAt descending", async () => {
    getScope("approvals:sort-agent").set("old", { id: "old", status: "pending", agentId: "sort-agent", createdAt: 100 });
    getScope("approvals:sort-agent").set("new", { id: "new", status: "pending", agentId: "sort-agent", createdAt: 200 });
    const result = await call("approval::list", {
      body: { agentId: "sort-agent" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result[0].id).toBeDefined();
  });

  it("returns empty for no approvals", async () => {
    const result = await call("approval::list", {
      body: { agentId: "empty-agent" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.length).toBe(0);
  });
});

describe("approval::wait extended", () => {
  it("returns pending status", async () => {
    getScope("approvals:wait-agent").set("wait-1", {
      id: "wait-1", status: "pending", agentId: "wait-agent",
      toolName: "tool::x", createdAt: Date.now(), timeoutMs: 300000,
    });
    const result = await call("approval::wait", {
      body: { requestId: "wait-1", agentId: "wait-agent" },
    });
    expect(result.status).toBe("pending");
  });

  it("returns approved status with decision", async () => {
    getScope("approvals:wait-approved").set("wait-2", {
      id: "wait-2", status: "approved", agentId: "wait-approved",
      toolName: "tool::y", decidedBy: "admin", createdAt: Date.now(), timeoutMs: 300000,
    });
    const result = await call("approval::wait", {
      body: { requestId: "wait-2", agentId: "wait-approved" },
    });
    expect(result.status).toBe("approved");
    expect(result.decision).toBeDefined();
  });

  it("returns denied status with decision", async () => {
    getScope("approvals:wait-denied").set("wait-3", {
      id: "wait-3", status: "denied", agentId: "wait-denied",
      toolName: "tool::z", decidedBy: "admin", createdAt: Date.now(), timeoutMs: 300000,
    });
    const result = await call("approval::wait", {
      body: { requestId: "wait-3", agentId: "wait-denied" },
    });
    expect(result.status).toBe("denied");
  });

  it("returns not_found for unknown request", async () => {
    const result = await call("approval::wait", {
      body: { requestId: "unknown", agentId: "x" },
    });
    expect(result.status).toBe("not_found");
  });

  it("audits approved decisions", async () => {
    getScope("approvals:aud-agent").set("aud-1", {
      id: "aud-1", status: "approved", agentId: "aud-agent",
      toolName: "tool::a", decidedBy: "admin", createdAt: Date.now(), timeoutMs: 300000,
    });
    await call("approval::wait", {
      body: { requestId: "aud-1", agentId: "aud-agent" },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "approval_granted")).toBe(true);
  });

  it("audits denied decisions", async () => {
    getScope("approvals:aud-deny").set("aud-2", {
      id: "aud-2", status: "denied", agentId: "aud-deny",
      toolName: "tool::b", decidedBy: "admin", createdAt: Date.now(), timeoutMs: 300000,
    });
    await call("approval::wait", {
      body: { requestId: "aud-2", agentId: "aud-deny" },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "approval_denied")).toBe(true);
  });
});

describe("approval::set_policy extended", () => {
  it("sets policy with tools array", async () => {
    const result = await call("approval::set_policy", {
      body: { tools: ["tool::exec", "deploy::*"], timeoutMs: 60000 },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.updated).toBe(true);
    const stored: any = getScope("approval_policy").get("default");
    expect(stored.tools).toEqual(["tool::exec", "deploy::*"]);
  });

  it("uses default timeout when not provided", async () => {
    await call("approval::set_policy", {
      body: { tools: ["*"] },
      headers: { authorization: "Bearer test-key" },
    });
    const stored: any = getScope("approval_policy").get("default");
    expect(stored.timeoutMs).toBe(300000);
  });

  it("sets wildcard policy", async () => {
    const result = await call("approval::set_policy", {
      body: { tools: ["*"] },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.updated).toBe(true);
  });
});

describe("handler registration", () => {
  it("registers approval::check", () => {
    expect(handlers["approval::check"]).toBeDefined();
  });

  it("registers approval::decide", () => {
    expect(handlers["approval::decide"]).toBeDefined();
  });

  it("registers approval::list", () => {
    expect(handlers["approval::list"]).toBeDefined();
  });

  it("registers approval::wait", () => {
    expect(handlers["approval::wait"]).toBeDefined();
  });

  it("registers approval::set_policy", () => {
    expect(handlers["approval::set_policy"]).toBeDefined();
  });
});

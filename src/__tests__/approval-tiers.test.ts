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

const handlers: Record<string, Function> = {};

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
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "set") current[op.path] = op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "state::list_groups") {
    return Object.keys(kvStore);
  }
  if (fnId === "approval::classify") {
    const handler = handlers["approval::classify"];
    if (handler) return handler(data);
    return null;
  }
  if (fnId === "publish") return null;
  if (fnId === "security::audit") return null;
  return null;
});
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
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  sanitizeId: vi.fn((id: string) => id),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../approval-tiers.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("approval::classify", () => {
  it("returns auto for tool::file_read", async () => {
    const result = await call("approval::classify", {
      toolId: "tool::file_read",
    });
    expect(result.tier).toBe("auto");
    expect(result.toolId).toBe("tool::file_read");
  });

  it("returns async for tool::file_write", async () => {
    const result = await call("approval::classify", {
      toolId: "tool::file_write",
    });
    expect(result.tier).toBe("async");
  });

  it("returns sync for tool::shell_exec", async () => {
    const result = await call("approval::classify", {
      toolId: "tool::shell_exec",
    });
    expect(result.tier).toBe("sync");
  });

  it("returns auto for unknown memory:: tool", async () => {
    const result = await call("approval::classify", {
      toolId: "memory::custom_action",
    });
    expect(result.tier).toBe("auto");
  });

  it("returns auto for unknown skill:: tool", async () => {
    const result = await call("approval::classify", {
      toolId: "skill::custom_skill",
    });
    expect(result.tier).toBe("auto");
  });

  it("defaults unknown prefix to async", async () => {
    const result = await call("approval::classify", {
      toolId: "custom::something",
    });
    expect(result.tier).toBe("async");
  });

  it("downgrades shell_exec to async for safe commands", async () => {
    const result = await call("approval::classify", {
      toolId: "tool::shell_exec",
      args: { command: "ls -la /tmp" },
    });
    expect(result.tier).toBe("async");
  });

  it("keeps sync for shell_exec with unsafe commands", async () => {
    const result = await call("approval::classify", {
      toolId: "tool::shell_exec",
      args: { command: "rm -rf /" },
    });
    expect(result.tier).toBe("sync");
  });

  it("respects agent-level approval overrides", async () => {
    seedKv("agents", "agent-override", {
      approvalOverrides: { "tool::file_read": "sync" },
    });
    const result = await call("approval::classify", {
      toolId: "tool::file_read",
      agentId: "agent-override",
    });
    expect(result.tier).toBe("sync");
  });
});

describe("approval::decide_tier", () => {
  it("auto-approves auto-tier tools", async () => {
    const result = await call("approval::decide_tier", {
      toolId: "tool::file_read",
      agentId: "agent-1",
    });
    expect(result.approved).toBe(true);
    expect(result.tier).toBe("auto");
  });

  it("returns pending for async-tier tools", async () => {
    const result = await call("approval::decide_tier", {
      toolId: "tool::file_write",
      agentId: "agent-1",
    });
    expect(result.approved).toBe(false);
    expect(result.tier).toBe("async");
    expect(result.status).toBe("pending");
    expect(result.approvalId).toBeDefined();
  });

  it("stores pending approval in state", async () => {
    const result = await call("approval::decide_tier", {
      toolId: "tool::file_write",
      agentId: "agent-1",
    });
    const stored = getScope("tier_approvals:agent-1").get(
      result.approvalId,
    ) as any;
    expect(stored).toBeDefined();
    expect(stored.status).toBe("pending");
    expect(stored.toolId).toBe("tool::file_write");
  });

  it("publishes approval.requested for non-auto tools", async () => {
    await call("approval::decide_tier", {
      toolId: "tool::file_write",
      agentId: "agent-1",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ topic: "approval.requested" }),
    );
  });

  it("audits tier classification", async () => {
    await call("approval::decide_tier", {
      toolId: "tool::file_read",
      agentId: "agent-1",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "approval_tier_classified" }),
    );
  });
});

describe("approval::decide_tier_request", () => {
  it("approves a pending request", async () => {
    seedKv("tier_approvals:agent-1", "req-1", {
      id: "req-1",
      agentId: "agent-1",
      toolId: "tool::file_write",
      status: "pending",
    });

    const result = await call(
      "approval::decide_tier_request",
      authReq({
        approvalId: "req-1",
        agentId: "agent-1",
        decision: "approve",
        decidedBy: "admin",
      }),
    );
    expect(result.status).toBe("approved");
    expect(result.approvalId).toBe("req-1");
  });

  it("denies a pending request", async () => {
    seedKv("tier_approvals:agent-1", "req-2", {
      id: "req-2",
      agentId: "agent-1",
      toolId: "tool::shell_exec",
      status: "pending",
    });

    const result = await call(
      "approval::decide_tier_request",
      authReq({
        approvalId: "req-2",
        agentId: "agent-1",
        decision: "deny",
        decidedBy: "reviewer",
      }),
    );
    expect(result.status).toBe("denied");
  });

  it("defaults decidedBy to system", async () => {
    seedKv("tier_approvals:agent-1", "req-3", {
      id: "req-3",
      status: "pending",
    });

    await call(
      "approval::decide_tier_request",
      authReq({
        approvalId: "req-3",
        agentId: "agent-1",
        decision: "approve",
      }),
    );
    const updated = getScope("tier_approvals:agent-1").get("req-3") as any;
    expect(updated.decidedBy).toBe("system");
  });

  it("audits the decision", async () => {
    seedKv("tier_approvals:agent-1", "req-4", {
      id: "req-4",
      status: "pending",
    });

    await call(
      "approval::decide_tier_request",
      authReq({
        approvalId: "req-4",
        agentId: "agent-1",
        decision: "approve",
        decidedBy: "admin",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "approval_tier_approved" }),
    );
  });
});

describe("approval::list_pending_tiers", () => {
  it("returns pending items for specific agent", async () => {
    seedKv("tier_approvals:agent-1", "req-1", {
      id: "req-1",
      status: "pending",
      createdAt: 1000,
    });
    seedKv("tier_approvals:agent-1", "req-2", {
      id: "req-2",
      status: "approved",
      createdAt: 2000,
    });
    seedKv("tier_approvals:agent-1", "req-3", {
      id: "req-3",
      status: "pending",
      createdAt: 3000,
    });

    const result = await call(
      "approval::list_pending_tiers",
      authReq({ agentId: "agent-1" }),
    );
    expect(result.length).toBe(2);
    expect(result[0].createdAt).toBe(3000);
    expect(result[1].createdAt).toBe(1000);
  });

  it("returns empty array when no pending items", async () => {
    seedKv("tier_approvals:agent-1", "req-1", {
      id: "req-1",
      status: "approved",
      createdAt: 1000,
    });

    const result = await call(
      "approval::list_pending_tiers",
      authReq({ agentId: "agent-1" }),
    );
    expect(result).toEqual([]);
  });

  it("lists across all agents when no agentId given", async () => {
    seedKv("tier_approvals:agent-1", "req-1", {
      id: "req-1",
      status: "pending",
      createdAt: 1000,
    });
    seedKv("tier_approvals:agent-2", "req-2", {
      id: "req-2",
      status: "pending",
      createdAt: 2000,
    });

    const result = await call("approval::list_pending_tiers", authReq({}));
    expect(result.length).toBe(2);
    expect(result[0].createdAt).toBe(2000);
  });
});

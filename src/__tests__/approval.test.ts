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
  if (fnId === "state::list_groups") return [];
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

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  sanitizeId: vi.fn((id: string) => {
    if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id)) {
      throw Object.assign(new Error(`Invalid ID format: ${id}`), {
        statusCode: 400,
      });
    }
    return id;
  }),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
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

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("approval::check - policy matching", () => {
  it("returns not required when no policy exists", async () => {
    const result = await call("approval::check", {
      agentId: "a1",
      toolName: "tool::file_read",
      params: {},
    });
    expect(result.required).toBe(false);
  });

  it("requires approval when wildcard policy matches", async () => {
    seedKv("approval_policy", "default", {
      tools: ["*"],
      timeoutMs: 60000,
    });
    const result = await call("approval::check", {
      agentId: "a1",
      toolName: "tool::shell_exec",
      params: {},
    });
    expect(result.required).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.requestId).toBeDefined();
  });

  it("requires approval for exact tool match", async () => {
    seedKv("approval_policy", "default", {
      tools: ["tool::shell_exec"],
      timeoutMs: 60000,
    });
    const result = await call("approval::check", {
      agentId: "a1",
      toolName: "tool::shell_exec",
      params: {},
    });
    expect(result.required).toBe(true);
  });

  it("does not require approval when tool not in policy", async () => {
    seedKv("approval_policy", "default", {
      tools: ["tool::shell_exec"],
      timeoutMs: 60000,
    });
    const result = await call("approval::check", {
      agentId: "a1",
      toolName: "tool::file_read",
      params: {},
    });
    expect(result.required).toBe(false);
  });

  it("supports namespace wildcard pattern (tool::*)", async () => {
    seedKv("approval_policy", "default", {
      tools: ["tool::*"],
      timeoutMs: 60000,
    });
    const result = await call("approval::check", {
      agentId: "a1",
      toolName: "tool::file_write",
      params: {},
    });
    expect(result.required).toBe(true);
  });

  it("throws when max pending approvals exceeded", async () => {
    seedKv("approval_policy", "default", { tools: ["*"] });
    for (let i = 0; i < 5; i++) {
      seedKv(`approvals:a1`, `req-${i}`, {
        id: `req-${i}`,
        status: "pending",
      });
    }
    await expect(
      call("approval::check", {
        agentId: "a1",
        toolName: "tool::x",
        params: {},
      }),
    ).rejects.toThrow("pending approvals");
  });

  it("publishes approval.requested event", async () => {
    seedKv("approval_policy", "default", { tools: ["*"] });
    await call("approval::check", {
      agentId: "a1",
      toolName: "tool::shell_exec",
      params: {},
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ topic: "approval.requested" }),
    );
  });
});

describe("approval::decide", () => {
  it("approves a pending request", async () => {
    seedKv("approvals:a1", "req-1", {
      id: "req-1",
      status: "pending",
      agentId: "a1",
      toolName: "tool::x",
    });
    const result = await call(
      "approval::decide",
      authReq({
        requestId: "req-1",
        agentId: "a1",
        decision: "approve",
        decidedBy: "admin",
      }),
    );
    expect(result.status).toBe("approved");
    const updated = getScope("approvals:a1").get("req-1") as any;
    expect(updated.status).toBe("approved");
    expect(updated.decidedBy).toBe("admin");
  });

  it("denies a pending request", async () => {
    seedKv("approvals:a1", "req-2", {
      id: "req-2",
      status: "pending",
    });
    const result = await call(
      "approval::decide",
      authReq({
        requestId: "req-2",
        agentId: "a1",
        decision: "deny",
        decidedBy: "reviewer",
      }),
    );
    expect(result.status).toBe("denied");
  });

  it("publishes approval.decided event", async () => {
    seedKv("approvals:a1", "req-3", { id: "req-3", status: "pending" });
    await call(
      "approval::decide",
      authReq({
        requestId: "req-3",
        agentId: "a1",
        decision: "approve",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ topic: "approval.decided" }),
    );
  });

  it("defaults decidedBy to 'system'", async () => {
    seedKv("approvals:a1", "req-4", { id: "req-4", status: "pending" });
    await call(
      "approval::decide",
      authReq({
        requestId: "req-4",
        agentId: "a1",
        decision: "approve",
      }),
    );
    const updated = getScope("approvals:a1").get("req-4") as any;
    expect(updated.decidedBy).toBe("system");
  });
});

describe("approval::list", () => {
  it("lists approvals for a specific agent", async () => {
    seedKv("approvals:a1", "r1", {
      id: "r1",
      status: "pending",
      toolName: "t1",
    });
    seedKv("approvals:a1", "r2", {
      id: "r2",
      status: "approved",
      toolName: "t2",
    });
    const result = await call("approval::list", authReq({ agentId: "a1" }));
    expect(result).toHaveLength(2);
  });

  it("filters by status", async () => {
    seedKv("approvals:a1", "r1", { id: "r1", status: "pending" });
    seedKv("approvals:a1", "r2", { id: "r2", status: "approved" });
    const result = await call(
      "approval::list",
      authReq({
        agentId: "a1",
        status: "pending",
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pending");
  });
});

describe("approval::wait", () => {
  it("returns current status of approval", async () => {
    seedKv("approvals:a1", "wait-1", {
      id: "wait-1",
      status: "approved",
      toolName: "tool::x",
      decidedBy: "admin",
    });
    const result = await call(
      "approval::wait",
      authReq({
        requestId: "wait-1",
        agentId: "a1",
      }),
    );
    expect(result.status).toBe("approved");
    expect(result.decision).toBeDefined();
  });

  it("returns pending status without decision details", async () => {
    seedKv("approvals:a1", "wait-2", {
      id: "wait-2",
      status: "pending",
      toolName: "tool::y",
    });
    const result = await call(
      "approval::wait",
      authReq({
        requestId: "wait-2",
        agentId: "a1",
      }),
    );
    expect(result.status).toBe("pending");
    expect(result.decision).toBeUndefined();
  });

  it("returns not_found for missing request", async () => {
    const result = await call(
      "approval::wait",
      authReq({
        requestId: "missing",
        agentId: "a1",
      }),
    );
    expect(result.status).toBe("not_found");
  });

  it("audits approved wait checks", async () => {
    seedKv("approvals:a1", "wait-3", {
      id: "wait-3",
      status: "approved",
      toolName: "tool::z",
      decidedBy: "user",
    });
    await call(
      "approval::wait",
      authReq({
        requestId: "wait-3",
        agentId: "a1",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "approval_granted" }),
    );
  });

  it("audits denied wait checks", async () => {
    seedKv("approvals:a1", "wait-4", {
      id: "wait-4",
      status: "denied",
      toolName: "tool::w",
      decidedBy: "admin",
    });
    await call(
      "approval::wait",
      authReq({
        requestId: "wait-4",
        agentId: "a1",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "approval_denied" }),
    );
  });
});

describe("approval::set_policy", () => {
  it("stores approval policy", async () => {
    await call(
      "approval::set_policy",
      authReq({
        tools: ["tool::shell_exec"],
        timeoutMs: 120000,
      }),
    );
    const policy = getScope("approval_policy").get("default") as any;
    expect(policy.tools).toEqual(["tool::shell_exec"]);
    expect(policy.timeoutMs).toBe(120000);
  });

  it("defaults timeoutMs to 300000", async () => {
    await call("approval::set_policy", authReq({ tools: ["*"] }));
    const policy = getScope("approval_policy").get("default") as any;
    expect(policy.timeoutMs).toBe(300000);
  });
});

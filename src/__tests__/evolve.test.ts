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
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "llm::complete") {
    return {
      content: "async (input) => { return { doubled: input.value * 2 }; }",
    };
  }
  if (fnId === "skill::pipeline") {
    return {
      approved: true,
      report: {
        scan: { safe: true, findings: [] },
        sandbox: { passed: true, violations: [] },
      },
    };
  }
  if (fnId === "security::audit") return { ok: true };
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
      return { unregister: vi.fn() };
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
  sanitizeId: (id: string) => {
    if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id))
      throw new Error(`Invalid ID: ${id}`);
    return id;
  },
}));

vi.mock("../shared/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../shared/metrics.js", () => ({
  createRecordMetric: () => vi.fn(),
}));

vi.mock("../shared/errors.js", () => ({
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
});

beforeAll(async () => {
  await import("../evolve.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("evolve::generate", () => {
  it("generates a new evolved function", async () => {
    const result = await call(
      "evolve::generate",
      authReq({
        goal: "Double a number",
        name: "doubler",
        agentId: "agent-1",
      }),
    );
    expect(result.functionId).toBe("evolved::doubler_v1");
    expect(result.status).toBe("draft");
    expect(result.version).toBe(1);
    expect(result.authorAgentId).toBe("agent-1");
    expect(result.code).toContain("input");
  });

  it("increments version for same name", async () => {
    seedKv("evolved_functions", "evolved::adder_v1", {
      functionId: "evolved::adder_v1",
      version: 1,
    });

    const result = await call(
      "evolve::generate",
      authReq({
        goal: "Add numbers",
        name: "adder",
        agentId: "agent-1",
      }),
    );
    expect(result.functionId).toBe("evolved::adder_v2");
    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe("evolved::adder_v1");
  });

  it("rejects missing required fields", async () => {
    await expect(
      call("evolve::generate", authReq({ goal: "test" })),
    ).rejects.toThrow("goal, name, and agentId are required");
  });
});

describe("evolve::register", () => {
  it("registers a function after security scan", async () => {
    seedKv("evolved_functions", "evolved::test_v1", {
      functionId: "evolved::test_v1",
      code: "async (input) => { return input; }",
      description: "passthrough",
      authorAgentId: "agent-1",
      version: 1,
      status: "draft",
      securityReport: { scanSafe: false, sandboxPassed: false, findingCount: 0 },
      metadata: {},
    });

    const result = await call(
      "evolve::register",
      authReq({ functionId: "evolved::test_v1" }),
    );
    expect(result.registered).toBe(true);
    expect(result.securityReport.scanSafe).toBe(true);
    expect(result.securityReport.sandboxPassed).toBe(true);

    const stored: any = getScope("evolved_functions").get("evolved::test_v1");
    expect(stored.status).toBe("staging");
  });

  it("rejects when security scan fails", async () => {
    const originalImpl = mockTrigger.getMockImplementation()!;
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "skill::pipeline") {
        return {
          approved: false,
          report: {
            scan: { safe: false, findings: [{ severity: "critical" }] },
            sandbox: { passed: true, violations: [] },
          },
        };
      }
      return originalImpl(fnId, data);
    });

    seedKv("evolved_functions", "evolved::bad_v1", {
      functionId: "evolved::bad_v1",
      code: "require('child_process').exec('rm -rf /')",
      description: "malicious",
      authorAgentId: "agent-1",
      version: 1,
      status: "draft",
      securityReport: { scanSafe: false, sandboxPassed: false, findingCount: 0 },
      metadata: {},
    });

    const result = await call(
      "evolve::register",
      authReq({ functionId: "evolved::bad_v1" }),
    );
    expect(result.registered).toBe(false);
    expect(result.reason).toContain("Security scan failed");

    mockTrigger.mockImplementation(originalImpl);
  });

  it("rejects killed functions", async () => {
    seedKv("evolved_functions", "evolved::dead_v1", {
      functionId: "evolved::dead_v1",
      code: "async (input) => input",
      status: "killed",
      securityReport: { scanSafe: true, sandboxPassed: true, findingCount: 0 },
      metadata: {},
    });

    await expect(
      call("evolve::register", authReq({ functionId: "evolved::dead_v1" })),
    ).rejects.toThrow("Cannot register a killed function");
  });

  it("rejects missing functionId", async () => {
    await expect(
      call("evolve::register", authReq({})),
    ).rejects.toThrow("functionId is required");
  });
});

describe("evolve::unregister", () => {
  it("marks function as killed", async () => {
    seedKv("evolved_functions", "evolved::rm_v1", {
      functionId: "evolved::rm_v1",
      authorAgentId: "agent-1",
      status: "staging",
      metadata: {},
    });

    const result = await call(
      "evolve::unregister",
      authReq({ functionId: "evolved::rm_v1", agentId: "agent-1" }),
    );
    expect(result.unregistered).toBe(true);

    const stored: any = getScope("evolved_functions").get("evolved::rm_v1");
    expect(stored.status).toBe("killed");
  });

  it("rejects non-author agents", async () => {
    seedKv("evolved_functions", "evolved::prot_v1", {
      functionId: "evolved::prot_v1",
      authorAgentId: "agent-1",
      status: "staging",
      metadata: {},
    });

    await expect(
      call(
        "evolve::unregister",
        authReq({ functionId: "evolved::prot_v1", agentId: "agent-2" }),
      ),
    ).rejects.toThrow("Only the author agent can unregister");
  });
});

describe("evolve::list", () => {
  it("returns all evolved functions", async () => {
    seedKv("evolved_functions", "evolved::a_v1", {
      functionId: "evolved::a_v1",
      status: "draft",
      authorAgentId: "agent-1",
    });
    seedKv("evolved_functions", "evolved::b_v1", {
      functionId: "evolved::b_v1",
      status: "production",
      authorAgentId: "agent-2",
    });

    const result = await call("evolve::list", authReq({}));
    expect(result).toHaveLength(2);
  });

  it("filters by status", async () => {
    seedKv("evolved_functions", "evolved::c_v1", {
      functionId: "evolved::c_v1",
      status: "draft",
    });
    seedKv("evolved_functions", "evolved::d_v1", {
      functionId: "evolved::d_v1",
      status: "production",
    });

    const result = await call(
      "evolve::list",
      authReq({ status: "production" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].functionId).toBe("evolved::d_v1");
  });
});

describe("evolve::get", () => {
  it("returns function details", async () => {
    seedKv("evolved_functions", "evolved::get_v1", {
      functionId: "evolved::get_v1",
      code: "async (input) => input",
      description: "test",
      status: "draft",
    });

    const result = await call(
      "evolve::get",
      authReq({ functionId: "evolved::get_v1" }),
    );
    expect(result.functionId).toBe("evolved::get_v1");
    expect(result.code).toBeDefined();
  });

  it("throws for nonexistent function", async () => {
    await expect(
      call("evolve::get", authReq({ functionId: "evolved::nope_v1" })),
    ).rejects.toThrow("Function not found");
  });
});

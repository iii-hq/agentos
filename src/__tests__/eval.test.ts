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
  if (fnId === "security::scan_injection") {
    return { safe: true };
  }
  if (fnId === "llm::complete") {
    return { content: "0.85" };
  }
  if (fnId.startsWith("evolved::") || fnId.startsWith("test::")) {
    return { result: (data?.value || 0) * 2 };
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
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
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
});

beforeAll(async () => {
  await import("../eval.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("eval::run", () => {
  it("runs eval with exact match scorer", async () => {
    const result = await call(
      "eval::run",
      authReq({
        functionId: "test::double",
        input: { value: 5 },
        expected: { result: 10 },
        scorer: "exact_match",
      }),
    );
    expect(result.evalId).toBeDefined();
    expect(result.functionId).toBe("test::double");
    expect(result.scores.correctness).toBe(1);
    expect(result.scores.safety).toBe(1);
    expect(result.scores.overall).toBeGreaterThan(0);
  });

  it("scores 0 for incorrect output", async () => {
    const result = await call(
      "eval::run",
      authReq({
        functionId: "test::double",
        input: { value: 5 },
        expected: { result: 99 },
        scorer: "exact_match",
      }),
    );
    expect(result.scores.correctness).toBe(0);
  });

  it("handles null correctness when no expected", async () => {
    const result = await call(
      "eval::run",
      authReq({
        functionId: "test::double",
        input: { value: 5 },
      }),
    );
    expect(result.scores.correctness).toBeNull();
    expect(result.scores.overall).toBeGreaterThan(0);
  });

  it("stores eval result in KV", async () => {
    const result = await call(
      "eval::run",
      authReq({
        functionId: "test::store",
        input: { value: 1 },
        expected: { result: 2 },
      }),
    );
    const stored = getScope("eval_results").get(
      `test::store:${result.evalId}`,
    );
    expect(stored).toBeDefined();
  });

  it("rejects missing functionId", async () => {
    await expect(call("eval::run", authReq({}))).rejects.toThrow(
      "functionId is required",
    );
  });
});

describe("eval::score_inline", () => {
  it("scores inline without correctness", async () => {
    const result = await call("eval::score_inline", {
      functionId: "evolved::test_v1",
      input: { x: 1 },
      output: { y: 2 },
      latencyMs: 50,
      costTokens: 100,
    });
    expect(result.scores.correctness).toBeNull();
    expect(result.scores.latency_ms).toBe(50);
    expect(result.scores.cost_tokens).toBe(100);
    expect(result.scores.safety).toBe(1);
    expect(result.scorerType).toBe("inline");
  });

  it("fires inline_recorded event", async () => {
    await call("eval::score_inline", {
      functionId: "evolved::event_v1",
      input: {},
      output: {},
      latencyMs: 10,
      costTokens: 0,
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "eval::inline_recorded",
      expect.objectContaining({ functionId: "evolved::event_v1" }),
    );
  });
});

describe("eval::create_suite", () => {
  it("creates an eval suite", async () => {
    const result = await call(
      "eval::create_suite",
      authReq({
        name: "Double Suite",
        functionId: "evolved::doubler_v1",
        testCases: [
          { input: { value: 2 }, expected: { result: 4 } },
          { input: { value: 5 }, expected: { result: 10 } },
        ],
      }),
    );
    expect(result.suiteId).toBeDefined();
    expect(result.name).toBe("Double Suite");
    expect(result.testCases).toHaveLength(2);
  });

  it("rejects missing fields", async () => {
    await expect(
      call("eval::create_suite", authReq({ name: "Bad" })),
    ).rejects.toThrow("name, functionId, and testCases are required");
  });
});

describe("eval::suite", () => {
  it("runs all test cases and aggregates", async () => {
    seedKv("eval_suites", "suite-1", {
      suiteId: "suite-1",
      name: "Test Suite",
      functionId: "test::double",
      testCases: [
        { input: { value: 2 }, expected: { result: 4 }, scorer: "exact_match" },
        { input: { value: 5 }, expected: { result: 10 }, scorer: "exact_match" },
      ],
    });

    const result = await call("eval::suite", authReq({ suiteId: "suite-1" }));
    expect(result.aggregate.testCount).toBe(2);
    expect(result.aggregate.correctness).toBe(1);
    expect(result.aggregate.safety).toBe(1);
    expect(result.aggregate.passRate).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it("handles suite not found", async () => {
    await expect(
      call("eval::suite", authReq({ suiteId: "nope" })),
    ).rejects.toThrow("Suite not found");
  });
});

describe("eval::history", () => {
  it("returns eval history for a function", async () => {
    seedKv("eval_results", "fn1:eval1", {
      functionId: "fn1",
      scores: { overall: 0.8 },
      timestamp: 100,
    });
    seedKv("eval_results", "fn1:eval2", {
      functionId: "fn1",
      scores: { overall: 0.9 },
      timestamp: 200,
    });
    seedKv("eval_results", "fn2:eval3", {
      functionId: "fn2",
      scores: { overall: 0.5 },
      timestamp: 150,
    });

    const result = await call(
      "eval::history",
      authReq({ functionId: "fn1" }),
    );
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe(200);
  });
});

describe("eval::compare", () => {
  it("compares two function versions", async () => {
    const result = await call(
      "eval::compare",
      authReq({
        functionIdA: "test::v1",
        functionIdB: "test::v2",
        testCases: [
          { input: { value: 3 }, expected: { result: 6 } },
        ],
      }),
    );
    expect(result.winner).toBeDefined();
    expect(result.detailsA).toHaveLength(1);
    expect(result.detailsB).toHaveLength(1);
  });

  it("rejects missing fields", async () => {
    await expect(
      call("eval::compare", authReq({ functionIdA: "a" })),
    ).rejects.toThrow(
      "functionIdA, functionIdB, and testCases are required",
    );
  });
});

describe("eval custom scorer security", () => {
  it("rejects custom scorer with disallowed prefix", async () => {
    await expect(
      call(
        "eval::run",
        authReq({
          functionId: "test::double",
          input: { value: 1 },
          expected: { result: 2 },
          scorer: "custom",
          scorerFunctionId: "security::reset_all",
        }),
      ),
    ).rejects.toThrow("Custom scorer must use");
  });

  it("allows custom scorer with evolved:: prefix", async () => {
    const result = await call(
      "eval::run",
      authReq({
        functionId: "test::double",
        input: { value: 1 },
        expected: { result: 2 },
        scorer: "custom",
        scorerFunctionId: "evolved::my_scorer_v1",
      }),
    );
    expect(result.scores).toBeDefined();
  });
});

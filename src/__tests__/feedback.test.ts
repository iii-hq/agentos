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
  if (fnId === "evolve::unregister") return { unregistered: true };
  if (fnId === "evolve::generate") {
    return {
      functionId: `evolved::improved_v${(data?.metadata?.depth || 0) + 1}`,
      code: "async (input) => input",
      description: "improved",
    };
  }
  if (fnId === "evolve::register") return { registered: true };
  if (fnId === "eval::suite") {
    return {
      aggregate: { correctness: 0.9, passRate: 1.0 },
      results: [],
    };
  }
  if (fnId === "feedback::review") {
    return { decision: "keep", functionId: data?.functionId };
  }
  if (fnId === "feedback::improve") {
    return { improved: true, newFunctionId: "evolved::new_v1" };
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
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
  await import("../feedback.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

function seedEval(
  functionId: string,
  evalId: string,
  correctness: number | null,
  overall: number,
  timestamp: number,
) {
  seedKv("eval_results", `${functionId}:${evalId}`, {
    functionId,
    evalId,
    scores: { correctness, overall, safety: 1.0, latency_ms: 50, cost_tokens: 0 },
    timestamp,
  });
}

describe("feedback::review", () => {
  it("returns keep when no evals exist", async () => {
    const result = await call(
      "feedback::review",
      authReq({ functionId: "evolved::new_v1" }),
    );
    expect(result.decision).toBe("keep");
    expect(result.reason).toContain("No eval data");
  });

  it("returns keep when scores are good", async () => {
    seedEval("evolved::good_v1", "e1", 0.9, 0.85, 1000);
    seedEval("evolved::good_v1", "e2", 0.8, 0.75, 2000);
    seedEval("evolved::good_v1", "e3", 0.95, 0.9, 3000);

    const result = await call(
      "feedback::review",
      authReq({ functionId: "evolved::good_v1" }),
    );
    expect(result.decision).toBe("keep");
  });

  it("returns kill when too many failures", async () => {
    seedEval("evolved::bad_v1", "e1", 0.1, 0.2, 1000);
    seedEval("evolved::bad_v1", "e2", 0.2, 0.25, 2000);
    seedEval("evolved::bad_v1", "e3", 0.3, 0.3, 3000);

    const result = await call(
      "feedback::review",
      authReq({ functionId: "evolved::bad_v1" }),
    );
    expect(result.decision).toBe("kill");
    expect(result.recentFailures).toBe(3);
  });

  it("returns improve when score below threshold", async () => {
    seedEval("evolved::mid_v1", "e1", 0.6, 0.4, 1000);
    seedEval("evolved::mid_v1", "e2", 0.7, 0.45, 2000);

    const result = await call(
      "feedback::review",
      authReq({ functionId: "evolved::mid_v1" }),
    );
    expect(result.decision).toBe("improve");
  });

  it("directly kills function in state on kill decision", async () => {
    seedKv("evolved_functions", "evolved::killme_v1", {
      functionId: "evolved::killme_v1",
      status: "staging",
      authorAgentId: "agent-1",
    });
    seedEval("evolved::killme_v1", "e1", 0.1, 0.1, 1000);
    seedEval("evolved::killme_v1", "e2", 0.2, 0.15, 2000);
    seedEval("evolved::killme_v1", "e3", 0.3, 0.2, 3000);

    await call(
      "feedback::review",
      authReq({ functionId: "evolved::killme_v1" }),
    );

    const stored: any = getScope("evolved_functions").get("evolved::killme_v1");
    expect(stored.status).toBe("killed");
  });

  it("rejects missing functionId", async () => {
    await expect(
      call("feedback::review", authReq({})),
    ).rejects.toThrow("functionId is required");
  });
});

describe("feedback::improve", () => {
  it("generates improved version", async () => {
    seedKv("evolved_functions", "evolved::fix_v1", {
      functionId: "evolved::fix_v1",
      code: "async (input) => input",
      description: "needs fixing",
      authorAgentId: "agent-1",
      metadata: {},
    });
    seedEval("evolved::fix_v1", "e1", 0.3, 0.3, 1000);

    const result = await call(
      "feedback::improve",
      authReq({ functionId: "evolved::fix_v1" }),
    );
    expect(result.improved).toBe(true);
    expect(result.newFunctionId).toBeDefined();
  });

  it("stops at max depth", async () => {
    seedKv("evolved_functions", "evolved::deep_v1", {
      functionId: "evolved::deep_v1",
      code: "async (input) => input",
      description: "deep",
      authorAgentId: "agent-1",
      metadata: {},
    });

    const result = await call(
      "feedback::improve",
      authReq({ functionId: "evolved::deep_v1", depth: 3 }),
    );
    expect(result.improved).toBe(false);
    expect(result.reason).toContain("Max improvement depth");
  });

  it("rejects missing functionId", async () => {
    await expect(
      call("feedback::improve", authReq({})),
    ).rejects.toThrow("functionId is required");
  });
});

describe("feedback::promote", () => {
  it("promotes draft to staging", async () => {
    seedKv("evolved_functions", "evolved::promo_v1", {
      functionId: "evolved::promo_v1",
      status: "draft",
    });
    for (let i = 0; i < 5; i++) {
      seedEval("evolved::promo_v1", `e${i}`, 0.9, 0.85, 1000 + i);
    }

    const result = await call(
      "feedback::promote",
      authReq({ functionId: "evolved::promo_v1" }),
    );
    expect(result.promoted).toBe(true);
    expect(result.newStatus).toBe("staging");
  });

  it("promotes staging to production with safety check", async () => {
    seedKv("evolved_functions", "evolved::safe_v1", {
      functionId: "evolved::safe_v1",
      status: "staging",
    });
    for (let i = 0; i < 5; i++) {
      seedEval("evolved::safe_v1", `e${i}`, 0.9, 0.85, 1000 + i);
    }

    const result = await call(
      "feedback::promote",
      authReq({ functionId: "evolved::safe_v1" }),
    );
    expect(result.promoted).toBe(true);
    expect(result.newStatus).toBe("production");
  });

  it("blocks production promotion with low safety", async () => {
    seedKv("evolved_functions", "evolved::unsafe_v1", {
      functionId: "evolved::unsafe_v1",
      status: "staging",
    });
    for (let i = 0; i < 5; i++) {
      seedKv("eval_results", `evolved::unsafe_v1:e${i}`, {
        functionId: "evolved::unsafe_v1",
        scores: { correctness: 0.9, overall: 0.85, safety: 0.5, latency_ms: 50, cost_tokens: 0 },
        timestamp: 1000 + i,
      });
    }

    const result = await call(
      "feedback::promote",
      authReq({ functionId: "evolved::unsafe_v1" }),
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("Safety score");
  });

  it("rejects killed functions", async () => {
    seedKv("evolved_functions", "evolved::dead_v1", {
      functionId: "evolved::dead_v1",
      status: "killed",
    });

    await expect(
      call("feedback::promote", authReq({ functionId: "evolved::dead_v1" })),
    ).rejects.toThrow("Cannot promote from killed");
  });

  it("requires minimum evals", async () => {
    seedKv("evolved_functions", "evolved::early_v1", {
      functionId: "evolved::early_v1",
      status: "draft",
    });
    seedEval("evolved::early_v1", "e1", 0.9, 0.85, 1000);

    const result = await call(
      "feedback::promote",
      authReq({ functionId: "evolved::early_v1" }),
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("Need");
  });
});

describe("feedback::demote", () => {
  it("demotes production to staging", async () => {
    seedKv("evolved_functions", "evolved::down_v1", {
      functionId: "evolved::down_v1",
      status: "production",
    });

    const result = await call(
      "feedback::demote",
      authReq({ functionId: "evolved::down_v1" }),
    );
    expect(result.newStatus).toBe("staging");
  });

  it("kills when kill flag is set", async () => {
    seedKv("evolved_functions", "evolved::nuke_v1", {
      functionId: "evolved::nuke_v1",
      status: "production",
    });

    const result = await call(
      "feedback::demote",
      authReq({ functionId: "evolved::nuke_v1", kill: true }),
    );
    expect(result.newStatus).toBe("killed");
  });

  it("returns no-op for already killed function", async () => {
    seedKv("evolved_functions", "evolved::already_dead_v1", {
      functionId: "evolved::already_dead_v1",
      status: "killed",
    });

    const result = await call(
      "feedback::demote",
      authReq({ functionId: "evolved::already_dead_v1" }),
    );
    expect(result.demoted).toBe(false);
    expect(result.reason).toContain("Already killed");
  });
});

describe("feedback::leaderboard", () => {
  it("ranks functions by overall score", async () => {
    seedKv("evolved_functions", "evolved::top_v1", {
      functionId: "evolved::top_v1",
      status: "production",
      evalScores: { overall: 0.95, correctness: 0.9, safety: 1.0 },
      description: "top",
      version: 1,
      authorAgentId: "agent-1",
    });
    seedKv("evolved_functions", "evolved::mid_v1", {
      functionId: "evolved::mid_v1",
      status: "staging",
      evalScores: { overall: 0.7, correctness: 0.6, safety: 0.9 },
      description: "mid",
      version: 1,
      authorAgentId: "agent-2",
    });

    const result = await call(
      "feedback::leaderboard",
      authReq({}),
    );
    expect(result).toHaveLength(2);
    expect(result[0].rank).toBe(1);
    expect(result[0].functionId).toBe("evolved::top_v1");
    expect(result[1].rank).toBe(2);
  });

  it("clamps negative limit to 0", async () => {
    seedKv("evolved_functions", "evolved::clamp_v1", {
      functionId: "evolved::clamp_v1",
      status: "production",
      evalScores: { overall: 0.9 },
    });

    const result = await call(
      "feedback::leaderboard",
      authReq({ limit: -5 }),
    );
    expect(result).toHaveLength(0);
  });

  it("excludes killed functions", async () => {
    seedKv("evolved_functions", "evolved::alive_v1", {
      functionId: "evolved::alive_v1",
      status: "production",
      evalScores: { overall: 0.8 },
    });
    seedKv("evolved_functions", "evolved::dead2_v1", {
      functionId: "evolved::dead2_v1",
      status: "killed",
      evalScores: { overall: 0.9 },
    });

    const result = await call(
      "feedback::leaderboard",
      authReq({}),
    );
    expect(result).toHaveLength(1);
  });
});

describe("feedback::policy", () => {
  it("returns default policy when none set", async () => {
    const result = await call("feedback::policy", authReq({}));
    expect(result.minScoreToKeep).toBe(0.5);
    expect(result.minEvalsToPromote).toBe(5);
    expect(result.maxFailuresToKill).toBe(3);
  });

  it("updates policy", async () => {
    const result = await call(
      "feedback::policy",
      authReq({ minScoreToKeep: 0.7, maxFailuresToKill: 5 }),
    );
    expect(result.minScoreToKeep).toBe(0.7);
    expect(result.maxFailuresToKill).toBe(5);
    expect(result.minEvalsToPromote).toBe(5);
  });

  it("rejects negative integer fields", async () => {
    await expect(
      call("feedback::policy", authReq({ maxFailuresToKill: -1 })),
    ).rejects.toThrow("non-negative integer");
  });

  it("rejects non-integer count fields", async () => {
    await expect(
      call("feedback::policy", authReq({ minEvalsToPromote: 3.5 })),
    ).rejects.toThrow("non-negative integer");
  });

  it("rejects minScoreToKeep out of range", async () => {
    await expect(
      call("feedback::policy", authReq({ minScoreToKeep: 1.5 })),
    ).rejects.toThrow("between 0 and 1");
  });

  it("ignores NaN and Infinity values", async () => {
    const result = await call(
      "feedback::policy",
      authReq({ minScoreToKeep: 0.6, maxFailuresToKill: NaN }),
    );
    expect(result.minScoreToKeep).toBe(0.6);
    expect(result.maxFailuresToKill).toBe(3);
  });
});

describe("feedback::auto_review", () => {
  it("reviews staging and production functions", async () => {
    seedKv("evolved_functions", "evolved::review1_v1", {
      functionId: "evolved::review1_v1",
      status: "staging",
    });
    seedKv("evolved_functions", "evolved::review2_v1", {
      functionId: "evolved::review2_v1",
      status: "production",
    });
    seedKv("evolved_functions", "evolved::draft1_v1", {
      functionId: "evolved::draft1_v1",
      status: "draft",
    });

    const result = await call("feedback::auto_review", {});
    expect(result.reviewed).toBe(2);
  });
});

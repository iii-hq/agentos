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
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
      if (op.type === "set") current[op.path] = op.value;
      if (op.type === "merge")
        current[op.path] = [...(current[op.path] || []), ...(op.value || [])];
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "memory::recall") {
    return [
      { role: "user", content: "I prefer TypeScript over JavaScript", score: 0.9 },
      { role: "assistant", content: "Noted, using TypeScript", score: 0.8 },
    ];
  }
  if (fnId === "llm::complete") {
    return {
      content: JSON.stringify({
        facts: [
          { content: "User prefers TypeScript", importance: 0.8, category: "preference" },
          { content: "Low importance item", importance: 0.3, category: "context" },
        ],
        profileUpdates: { preferences: { language: "TypeScript" } },
      }),
    };
  }
  if (fnId === "memory::user_profile::update") return { updated: true };
  if (fnId === "evolve::generate") return { functionId: "evolved::new_skill_v1" };
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
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
  Logger: class { info() {} warn() {} error() {} },
}));

vi.mock("@agentos/shared/config", () => ({
  ENGINE_URL: "ws://localhost:3111",
  OTEL_CONFIG: {},
  registerShutdown: vi.fn(),
}));
vi.mock("@agentos/shared/metrics", () => ({
  recordMetric: vi.fn(),
}));
vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  stripCodeFences: (s: string) => s.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, ""),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../memory-reflection.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("reflect::check_turn", () => {
  it("increments turn counter", async () => {
    const result = await call("reflect::check_turn", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.turnCount).toBe(1);
    expect(result.shouldReflect).toBe(false);
  });

  it("triggers reflection on turn 5", async () => {
    seedKv("reflect:a1", "s1", { turnCount: 4 });
    const result = await call("reflect::check_turn", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.turnCount).toBe(5);
    expect(result.shouldReflect).toBe(true);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "reflect::curate_memory",
      expect.objectContaining({ agentId: "a1" }),
    );
  });

  it("triggers skill discovery when iterations >= 5", async () => {
    const result = await call("reflect::check_turn", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 7,
    });
    expect(result.shouldReviewSkills).toBe(true);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "reflect::discover_skills",
      expect.objectContaining({ agentId: "a1", iterations: 7 }),
    );
  });

  it("does not trigger skill discovery when iterations < 5", async () => {
    const result = await call("reflect::check_turn", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 2,
    });
    expect(result.shouldReviewSkills).toBe(false);
  });
});

describe("reflect::curate_memory", () => {
  it("extracts facts from LLM response and stores high-importance ones", async () => {
    const result = await call("reflect::curate_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.saved).toBe(1);
    expect(result.totalFacts).toBe(2);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "memory::store",
      expect.objectContaining({
        agentId: "a1",
        content: "[Curated] User prefers TypeScript",
      }),
    );
  });

  it("skips facts with low importance", async () => {
    const result = await call("reflect::curate_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    const storeCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "memory::store",
    );
    expect(storeCalls.length).toBe(1);
    expect(storeCalls[0][1].content).not.toContain("Low importance");
  });

  it("handles code-fenced JSON from LLM", async () => {
    mockTrigger.mockImplementationOnce(async (fnId: string, data?: any) => {
      if (fnId === "memory::recall") return [{ role: "user", content: "test" }];
      return null;
    });
    mockTrigger.mockImplementationOnce(async () => null);
    mockTrigger.mockImplementationOnce(async () => ({
      content: '```json\n{"facts": [{"content": "fact1", "importance": 0.9, "category": "learning"}], "profileUpdates": null}\n```',
    }));

    const result = await call("reflect::curate_memory", {
      agentId: "a2",
      sessionId: "s2",
    });
    expect(result.saved).toBe(1);
  });

  it("triggers profile update when profileUpdates present", async () => {
    await call("reflect::curate_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "memory::user_profile::update",
      expect.objectContaining({ agentId: "a1" }),
    );
  });
});

describe("reflect::discover_skills", () => {
  it("skips when iterations < 5", async () => {
    const result = await call("reflect::discover_skills", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 3,
    });
    expect(result.created).toBe(false);
  });

  it("fires evolve::generate when LLM suggests skill creation", async () => {
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "memory::recall") return [{ role: "user", content: "complex workflow" }];
      if (fnId === "llm::complete") {
        return {
          content: JSON.stringify({
            shouldCreate: true,
            name: "auto_deploy",
            goal: "Automate deployment steps",
            spec: "deploy to k8s",
          }),
        };
      }
      return null;
    });

    const result = await call("reflect::discover_skills", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 10,
    });
    expect(result.created).toBe(true);
    expect(result.name).toBe("auto_deploy");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "evolve::generate",
      expect.objectContaining({ name: "auto_deploy" }),
    );
  });
});

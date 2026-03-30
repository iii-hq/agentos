import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

let llmResponse: any = { content: '{"facts": [], "profileUpdates": null}' };
let recallResponse: any = [];

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::update") {
    const scope = getScope(data.scope);
    const current: any = scope.get(data.key) || {};
    for (const op of data.operations || []) {
      if (op.type === "increment")
        current[op.path] = (current[op.path] || 0) + op.value;
      else if (op.type === "set") current[op.path] = op.value;
    }
    scope.set(data.key, current);
    return current;
  }
  if (fnId === "memory::recall") return recallResponse;
  if (fnId === "llm::complete") return llmResponse;
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

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  llmResponse = { content: '{"facts": [], "profileUpdates": null}' };
  recallResponse = [];
});

beforeAll(async () => {
  await import("../memory-nudge.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("nudge::check_turn", () => {
  it("returns shouldReview false on turns 1-4", async () => {
    for (let i = 1; i <= 4; i++) {
      const result = await call("nudge::check_turn", {
        agentId: "a1",
        sessionId: "s1",
        iterations: 0,
      });
      expect(result.shouldReview).toBe(false);
      expect(result.turnCount).toBe(i);
    }
  });

  it("returns shouldReview true on turn 5 and fires review_memory", async () => {
    for (let i = 0; i < 4; i++) {
      await call("nudge::check_turn", {
        agentId: "a1",
        sessionId: "s1",
        iterations: 0,
      });
    }
    mockTriggerVoid.mockClear();
    const result = await call("nudge::check_turn", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 0,
    });
    expect(result.shouldReview).toBe(true);
    expect(result.turnCount).toBe(5);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "nudge::review_memory",
      expect.objectContaining({ agentId: "a1" }),
    );
  });

  it("fires review_skills when iterations >= 5", async () => {
    mockTriggerVoid.mockClear();
    const result = await call("nudge::check_turn", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 7,
    });
    expect(result.shouldReviewSkills).toBe(true);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "nudge::review_skills",
      expect.objectContaining({ agentId: "a1", iterations: 7 }),
    );
  });

  it("returns shouldReviewSkills false when iterations < 5", async () => {
    const result = await call("nudge::check_turn", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 3,
    });
    expect(result.shouldReviewSkills).toBe(false);
  });
});

describe("nudge::review_memory", () => {
  it("returns saved 0 when no memories", async () => {
    recallResponse = [];
    const result = await call("nudge::review_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.saved).toBe(0);
  });

  it("extracts and stores facts from conversation", async () => {
    recallResponse = [
      { role: "user", content: "I prefer TypeScript over JavaScript" },
      { role: "assistant", content: "Got it, I will use TypeScript" },
    ];
    llmResponse = {
      content: JSON.stringify({
        facts: [
          { content: "User prefers TypeScript", importance: 0.8, category: "preference" },
        ],
        profileUpdates: null,
      }),
    };

    const result = await call("nudge::review_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.saved).toBe(1);
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "memory::store",
      expect.objectContaining({
        agentId: "a1",
        content: expect.stringContaining("[Nudge Fact]"),
      }),
    );
  });

  it("skips facts with importance below 0.5", async () => {
    recallResponse = [{ role: "user", content: "test content" }];
    llmResponse = {
      content: JSON.stringify({
        facts: [
          { content: "Low importance fact", importance: 0.3, category: "context" },
        ],
        profileUpdates: null,
      }),
    };

    const result = await call("nudge::review_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.saved).toBe(0);
  });

  it("fires profile update when profileUpdates present", async () => {
    recallResponse = [{ role: "user", content: "I like concise answers" }];
    llmResponse = {
      content: JSON.stringify({
        facts: [],
        profileUpdates: { communicationStyle: "concise" },
      }),
    };

    await call("nudge::review_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "memory::user_profile::update",
      expect.objectContaining({
        agentId: "a1",
        updates: { communicationStyle: "concise" },
      }),
    );
  });

  it("handles LLM returning code-fenced JSON", async () => {
    recallResponse = [{ role: "user", content: "test" }];
    llmResponse = {
      content: '```json\n{"facts": [{"content": "fenced fact", "importance": 0.9, "category": "learning"}], "profileUpdates": null}\n```',
    };

    const result = await call("nudge::review_memory", {
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.saved).toBe(1);
  });
});

describe("nudge::review_skills", () => {
  it("does nothing when iterations < 5", async () => {
    const result = await call("nudge::review_skills", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 3,
    });
    expect(result.created).toBe(false);
    expect(mockTriggerVoid).not.toHaveBeenCalledWith(
      "evolve::generate",
      expect.anything(),
    );
  });

  it("fires evolve::generate when LLM suggests a skill", async () => {
    recallResponse = [
      { role: "user", content: "Build a complex data pipeline" },
      { role: "assistant", content: "I used 8 tools to set it up" },
    ];
    llmResponse = {
      content: JSON.stringify({
        shouldCreate: true,
        name: "data_pipeline",
        goal: "Automate data pipeline setup",
        spec: "function that sets up ETL pipeline",
      }),
    };

    const result = await call("nudge::review_skills", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 8,
    });
    expect(result.created).toBe(true);
    expect(result.name).toBe("data_pipeline");
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "evolve::generate",
      expect.objectContaining({
        name: "data_pipeline",
        agentId: "a1",
      }),
    );
  });

  it("does nothing when LLM says shouldCreate false", async () => {
    recallResponse = [{ role: "user", content: "simple task" }];
    llmResponse = {
      content: JSON.stringify({ shouldCreate: false }),
    };

    const result = await call("nudge::review_skills", {
      agentId: "a1",
      sessionId: "s1",
      iterations: 6,
    });
    expect(result.created).toBe(false);
  });
});

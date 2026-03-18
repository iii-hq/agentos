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
  if (fnId === "echo::fn") return data.prompt || data.input || "echoed";
  if (fnId === "upper::fn")
    return String(data.prompt || data.input || "").toUpperCase();
  if (fnId === "fail::fn") throw new Error("step failure");
  if (fnId === "loop::fn") {
    if (data.iteration >= 2) return "done: finished";
    return `iteration ${data.iteration}`;
  }
  if (fnId === "conditional::fn") return "conditional output";
  return data.prompt || data.input || "default";
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
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../workflow.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("workflow::create", () => {
  it("creates a workflow definition", async () => {
    const result = await call(
      "workflow::create",
      authReq({
        id: "wf-1",
        name: "Test Workflow",
        description: "A test",
        steps: [],
      }),
    );
    expect(result.id).toBe("wf-1");
  });

  it("auto-generates ID if not provided", async () => {
    const result = await call(
      "workflow::create",
      authReq({
        name: "Auto ID",
        description: "no id",
        steps: [],
      }),
    );
    expect(result.id).toBeDefined();
    expect(result.id.length).toBeGreaterThan(0);
  });
});

describe("workflow::run - sequential mode", () => {
  it("executes sequential steps in order", async () => {
    seedKv("workflows", "seq-wf", {
      id: "seq-wf",
      name: "Sequential",
      steps: [
        {
          name: "step1",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
          promptTemplate: "{{input}}",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "seq-wf",
        input: "hello",
      }),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].stepName).toBe("step1");
  });

  it("passes output between sequential steps via vars", async () => {
    seedKv("workflows", "chain-wf", {
      id: "chain-wf",
      name: "Chain",
      steps: [
        {
          name: "step1",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
          outputVar: "first",
        },
        {
          name: "step2",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
          promptTemplate: "{{first}}",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "chain-wf",
        input: "start",
      }),
    );
    expect(result.results).toHaveLength(2);
  });
});

describe("workflow::run - variable interpolation", () => {
  it("interpolates {{input}} in prompt templates", async () => {
    seedKv("workflows", "interp-wf", {
      id: "interp-wf",
      name: "Interpolation",
      steps: [
        {
          name: "step1",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
          promptTemplate: "Hello {{input}}!",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "interp-wf",
        input: "world",
      }),
    );
    expect(result.results).toHaveLength(1);
  });

  it("preserves unresolved template vars", async () => {
    seedKv("workflows", "unresolved-wf", {
      id: "unresolved-wf",
      name: "Unresolved",
      steps: [
        {
          name: "step1",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
          promptTemplate: "{{undefined_var}}",
        },
      ],
    });
    await call(
      "workflow::run",
      authReq({
        workflowId: "unresolved-wf",
        input: "test",
      }),
    );
    const echoCall = mockTrigger.mock.calls.find((c) => c[0] === "echo::fn");
    expect(echoCall?.[1]?.prompt).toBe("{{undefined_var}}");
  });
});

describe("workflow::run - fanout mode", () => {
  it("executes fanout steps in parallel", async () => {
    seedKv("workflows", "fan-wf", {
      id: "fan-wf",
      name: "Fanout",
      steps: [
        {
          name: "fan1",
          functionId: "echo::fn",
          mode: "fanout",
          timeoutMs: 5000,
          errorMode: "fail",
          outputVar: "r1",
        },
        {
          name: "fan2",
          functionId: "echo::fn",
          mode: "fanout",
          timeoutMs: 5000,
          errorMode: "fail",
          outputVar: "r2",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "fan-wf",
        input: "parallel",
      }),
    );
    expect(result.results).toHaveLength(2);
  });
});

describe("workflow::run - collect mode", () => {
  it("collects fanout results", async () => {
    seedKv("workflows", "collect-wf", {
      id: "collect-wf",
      name: "Collect",
      steps: [
        {
          name: "fan1",
          functionId: "echo::fn",
          mode: "fanout",
          timeoutMs: 5000,
          errorMode: "fail",
        },
        {
          name: "collector",
          functionId: "echo::fn",
          mode: "collect",
          timeoutMs: 5000,
          errorMode: "fail",
          promptTemplate: "{{__fanout}}",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "collect-wf",
        input: "data",
      }),
    );
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });
});

describe("workflow::run - conditional mode", () => {
  it("skips step when condition not met", async () => {
    seedKv("workflows", "cond-wf", {
      id: "cond-wf",
      name: "Conditional",
      steps: [
        {
          name: "maybe",
          functionId: "conditional::fn",
          mode: "conditional",
          timeoutMs: 5000,
          errorMode: "fail",
          condition: "xyz_not_present",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "cond-wf",
        input: "no match here",
      }),
    );
    expect(result.results[0].output).toBe("skipped");
  });

  it("executes step when condition matches input", async () => {
    seedKv("workflows", "cond-wf2", {
      id: "cond-wf2",
      name: "Conditional2",
      steps: [
        {
          name: "match",
          functionId: "echo::fn",
          mode: "conditional",
          timeoutMs: 5000,
          errorMode: "fail",
          condition: "special",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "cond-wf2",
        input: "this has special keyword",
      }),
    );
    expect(result.results[0].output).not.toBe("skipped");
  });
});

describe("workflow::run - loop mode", () => {
  it("loops until 'until' condition met", async () => {
    seedKv("workflows", "loop-wf", {
      id: "loop-wf",
      name: "Loop",
      steps: [
        {
          name: "looper",
          functionId: "loop::fn",
          mode: "loop",
          timeoutMs: 5000,
          errorMode: "fail",
          until: "done",
          maxIterations: 10,
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "loop-wf",
        input: "start",
      }),
    );
    expect(result.results).toHaveLength(1);
  });

  it("respects maxIterations limit", async () => {
    seedKv("workflows", "max-loop-wf", {
      id: "max-loop-wf",
      name: "MaxLoop",
      steps: [
        {
          name: "bounded",
          functionId: "echo::fn",
          mode: "loop",
          timeoutMs: 5000,
          errorMode: "fail",
          maxIterations: 3,
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "max-loop-wf",
        input: "loop",
      }),
    );
    expect(result.results).toHaveLength(1);
  });
});

describe("workflow::run - error handling", () => {
  it("fails workflow on error in 'fail' mode", async () => {
    seedKv("workflows", "fail-wf", {
      id: "fail-wf",
      name: "Fail",
      steps: [
        {
          name: "bad",
          functionId: "fail::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
        },
      ],
    });
    await expect(
      call("workflow::run", authReq({ workflowId: "fail-wf", input: "x" })),
    ).rejects.toThrow("step failure");
  });

  it("skips step on error in 'skip' mode", async () => {
    seedKv("workflows", "skip-wf", {
      id: "skip-wf",
      name: "Skip",
      steps: [
        {
          name: "skippable",
          functionId: "fail::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "skip",
        },
        {
          name: "after",
          functionId: "echo::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "fail",
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "skip-wf",
        input: "go",
      }),
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0].error).toBe("step failure");
    expect(result.results[1].stepName).toBe("after");
  });

  it("retries on error in 'retry' mode", async () => {
    let attempts = 0;
    const originalImpl = mockTrigger.getMockImplementation()!;
    mockTrigger.mockImplementation(async (fnId: string, data?: any) => {
      if (fnId === "retry::fn") {
        attempts++;
        if (attempts <= 2) throw new Error("transient");
        return "success";
      }
      return originalImpl(fnId, data);
    });

    seedKv("workflows", "retry-wf", {
      id: "retry-wf",
      name: "Retry",
      steps: [
        {
          name: "retryable",
          functionId: "retry::fn",
          mode: "sequential",
          timeoutMs: 5000,
          errorMode: "retry",
          maxRetries: 3,
        },
      ],
    });
    const result = await call(
      "workflow::run",
      authReq({
        workflowId: "retry-wf",
        input: "try",
      }),
    );
    mockTrigger.mockImplementation(originalImpl);
    expect(result.results).toHaveLength(1);
  });

  it("throws when workflow not found", async () => {
    await expect(
      call("workflow::run", authReq({ workflowId: "nonexistent", input: "x" })),
    ).rejects.toThrow();
  });
});

describe("workflow::list", () => {
  it("returns stored workflows", async () => {
    seedKv("workflows", "wf1", { id: "wf1", name: "W1" });
    seedKv("workflows", "wf2", { id: "wf2", name: "W2" });
    const result = await call("workflow::list", authReq({}));
    expect(result).toHaveLength(2);
  });
});

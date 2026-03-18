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
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "audit::log-tool") return { logged: true };
  if (fnId === "block::dangerous")
    return { block: true, reason: "Dangerous tool" };
  if (fnId === "passthrough::fn") return { ok: true };
  if (fnId === "modify::prompt")
    return { modifiedPayload: { ...data.payload, injected: true } };
  if (fnId === "error::fn") throw new Error("hook error");
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
});

beforeAll(async () => {
  await import("../hooks.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("hook::register", () => {
  it("registers a valid hook", async () => {
    const result = await call("hook::register", {
      name: "Test Hook",
      type: "BeforeToolCall",
      functionId: "audit::log-tool",
    });
    expect(result.registered).toBe(true);
    expect(result.id).toBeDefined();
    expect(result.type).toBe("BeforeToolCall");
  });

  it("rejects invalid hook type", async () => {
    await expect(
      call("hook::register", {
        name: "Bad",
        type: "InvalidType",
        functionId: "fn",
      }),
    ).rejects.toThrow("Invalid hook type");
  });

  it("rejects missing functionId", async () => {
    await expect(
      call("hook::register", {
        name: "No Fn",
        type: "BeforeToolCall",
        functionId: "",
      }),
    ).rejects.toThrow("functionId is required");
  });

  it("defaults priority to 100", async () => {
    const result = await call("hook::register", {
      name: "Default Priority",
      type: "AfterToolCall",
      functionId: "passthrough::fn",
    });
    const hook = getScope("hooks").get(result.id) as any;
    expect(hook.priority).toBe(100);
  });

  it("audits hook registration", async () => {
    await call("hook::register", {
      name: "Audited",
      type: "BeforeToolCall",
      functionId: "audit::log-tool",
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "hook_registered" }),
    );
  });
});

describe("hook::fire - priority firing order", () => {
  it("fires hooks in priority order (lowest first)", async () => {
    const h1 = await call("hook::register", {
      name: "High Priority",
      type: "BeforeToolCall",
      priority: 10,
      functionId: "passthrough::fn",
    });
    const h2 = await call("hook::register", {
      name: "Low Priority",
      type: "BeforeToolCall",
      priority: 200,
      functionId: "passthrough::fn",
    });

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::x", arguments: {} },
    });
    expect(result.hooksFired).toBe(2);
    expect(result.results[0].hookName).toBe("High Priority");
    expect(result.results[1].hookName).toBe("Low Priority");
  });

  it("blocks tool call when hook returns block=true", async () => {
    await call("hook::register", {
      name: "Blocker",
      type: "BeforeToolCall",
      functionId: "block::dangerous",
    });
    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "dangerous::tool", arguments: {} },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("Dangerous tool");
  });

  it("stops firing after a blocking hook", async () => {
    await call("hook::register", {
      name: "Blocker",
      type: "BeforeToolCall",
      priority: 1,
      functionId: "block::dangerous",
    });
    await call("hook::register", {
      name: "After Blocker",
      type: "BeforeToolCall",
      priority: 100,
      functionId: "passthrough::fn",
    });
    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "x", arguments: {} },
    });
    expect(result.hooksFired).toBe(1);
  });

  it("skips disabled hooks", async () => {
    const h = await call("hook::register", {
      name: "Disabled",
      type: "AfterToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::toggle", { hookId: h.id, enabled: false });
    const result = await call("hook::fire", {
      type: "AfterToolCall",
      payload: {
        agentId: "a1",
        toolId: "x",
        arguments: {},
        result: {},
        durationMs: 0,
      },
    });
    expect(result.hooksFired).toBe(0);
  });

  it("handles hook errors gracefully", async () => {
    await call("hook::register", {
      name: "Error Hook",
      type: "AfterToolCall",
      functionId: "error::fn",
    });
    const result = await call("hook::fire", {
      type: "AfterToolCall",
      payload: {
        agentId: "a1",
        toolId: "x",
        arguments: {},
        result: {},
        durationMs: 0,
      },
    });
    expect(result.results[0].error).toBe("hook error");
  });

  it("supports BeforePromptBuild payload modification", async () => {
    await call("hook::register", {
      name: "Modifier",
      type: "BeforePromptBuild",
      functionId: "modify::prompt",
    });
    const result = await call("hook::fire", {
      type: "BeforePromptBuild",
      payload: {
        agentId: "a1",
        systemPrompt: "test",
        messages: [],
      },
    });
    expect(result.modifiedPayload.injected).toBe(true);
  });
});

describe("hook::toggle - enable/disable", () => {
  it("disables a hook", async () => {
    const h = await call("hook::register", {
      name: "Toggleable",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::toggle", {
      hookId: h.id,
      enabled: false,
    });
    expect(result.toggled).toBe(true);
    expect(result.enabled).toBe(false);
  });

  it("re-enables a disabled hook", async () => {
    const h = await call("hook::register", {
      name: "Re-enable",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::toggle", { hookId: h.id, enabled: false });
    const result = await call("hook::toggle", { hookId: h.id, enabled: true });
    expect(result.enabled).toBe(true);
  });

  it("throws for non-existent hook", async () => {
    await expect(
      call("hook::toggle", { hookId: "nonexistent", enabled: false }),
    ).rejects.toThrow("Hook not found");
  });
});

describe("hook::list - scoped hooks", () => {
  it("lists all registered hooks", async () => {
    await call("hook::register", {
      name: "H1",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::register", {
      name: "H2",
      type: "AfterToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::list", {});
    expect(result.count).toBe(2);
  });

  it("filters by type", async () => {
    await call("hook::register", {
      name: "Before",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::register", {
      name: "After",
      type: "AfterToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::list", { type: "BeforeToolCall" });
    expect(result.count).toBe(1);
    expect(result.hooks[0].type).toBe("BeforeToolCall");
  });

  it("filters enabled only", async () => {
    const h = await call("hook::register", {
      name: "Will Disable",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::toggle", { hookId: h.id, enabled: false });
    await call("hook::register", {
      name: "Active",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::list", { enabledOnly: true });
    expect(result.count).toBe(1);
    expect(result.hooks[0].name).toBe("Active");
  });

  it("groups hooks by type", async () => {
    await call("hook::register", {
      name: "B1",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    await call("hook::register", {
      name: "A1",
      type: "AfterToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::list", {});
    expect(result.grouped.BeforeToolCall).toHaveLength(1);
    expect(result.grouped.AfterToolCall).toHaveLength(1);
  });
});

describe("hook::unregister", () => {
  it("removes a registered hook", async () => {
    const h = await call("hook::register", {
      name: "Remove Me",
      type: "BeforeToolCall",
      functionId: "passthrough::fn",
    });
    const result = await call("hook::unregister", { hookId: h.id });
    expect(result.unregistered).toBe(true);
  });

  it("throws for non-existent hook", async () => {
    await expect(
      call("hook::unregister", { hookId: "missing" }),
    ).rejects.toThrow("Hook not found");
  });
});

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
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    const entries = [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
    return entries;
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
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "state::get")
        return getScope(data.scope).get(data.key) ?? null;
      if (fnId === "state::set") {
        getScope(data.scope).set(data.key, data.value);
        return { ok: true };
      }
      if (fnId === "state::delete") {
        getScope(data.scope).delete(data.key);
        return { ok: true };
      }
      if (fnId === "state::list") {
        const entries = [...getScope(data.scope).entries()].map(
          ([key, value]) => ({ key, value }),
        );
        return entries;
      }
      return null;
    },
  );
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

function createHook(
  id: string,
  type: string,
  priority = 100,
  enabled = true,
  agentId?: string,
  filter?: any,
) {
  const hook = {
    id,
    name: `${type}-${id}`,
    type,
    priority,
    functionId: `fn::${id}`,
    enabled,
    agentId,
    filter,
    createdAt: Date.now(),
  };
  getScope("hooks").set(id, hook);
  return hook;
}

describe("hook::register extended", () => {
  it("registers with all valid hook types", async () => {
    for (const type of [
      "BeforeToolCall",
      "AfterToolCall",
      "BeforePromptBuild",
      "AgentLoopEnd",
    ]) {
      const result = await call("hook::register", {
        name: `test-${type}`,
        type,
        functionId: `fn::${type}`,
      });
      expect(result.registered).toBe(true);
      expect(result.type).toBe(type);
    }
  });

  it("rejects invalid hook type", async () => {
    await expect(
      call("hook::register", {
        name: "bad",
        type: "InvalidType",
        functionId: "fn::bad",
      }),
    ).rejects.toThrow("Invalid hook type");
  });

  it("rejects missing functionId", async () => {
    await expect(
      call("hook::register", {
        name: "no-fn",
        type: "BeforeToolCall",
        functionId: "",
      }),
    ).rejects.toThrow("functionId is required");
  });

  it("uses default priority of 100", async () => {
    const result = await call("hook::register", {
      name: "default-priority",
      type: "BeforeToolCall",
      functionId: "fn::test",
    });
    expect(result.registered).toBe(true);
  });

  it("uses custom priority", async () => {
    const result = await call("hook::register", {
      name: "custom-priority",
      type: "BeforeToolCall",
      functionId: "fn::test",
      priority: 50,
    });
    expect(result.registered).toBe(true);
  });

  it("sets agentId when provided", async () => {
    const result = await call("hook::register", {
      name: "agent-hook",
      type: "BeforeToolCall",
      functionId: "fn::test",
      agentId: "agent-1",
    });
    expect(result.registered).toBe(true);
  });

  it("sets filter when provided", async () => {
    const result = await call("hook::register", {
      name: "filtered-hook",
      type: "BeforeToolCall",
      functionId: "fn::test",
      filter: { toolIds: ["tool::exec"] },
    });
    expect(result.registered).toBe(true);
  });

  it("generates auto name when name not provided", async () => {
    const result = await call("hook::register", {
      type: "BeforeToolCall",
      functionId: "fn::auto",
    });
    expect(result.name).toContain("BeforeToolCall-");
  });

  it("audits hook registration", async () => {
    await call("hook::register", {
      name: "audited-hook",
      type: "BeforeToolCall",
      functionId: "fn::audit",
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "security::audit",
    );
    expect(auditCalls.some((c) => c[1].type === "hook_registered")).toBe(true);
  });
});

describe("hook::unregister extended", () => {
  it("removes an existing hook", async () => {
    createHook("unreg-1", "BeforeToolCall");
    const result = await call("hook::unregister", { hookId: "unreg-1" });
    expect(result.unregistered).toBe(true);
  });

  it("throws for non-existent hook", async () => {
    await expect(
      call("hook::unregister", { hookId: "nonexistent" }),
    ).rejects.toThrow("Hook not found");
  });

  it("audits hook unregistration", async () => {
    createHook("unreg-audit", "BeforeToolCall");
    await call("hook::unregister", { hookId: "unreg-audit" });
    const auditCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "security::audit",
    );
    expect(auditCalls.some((c) => c[1].type === "hook_unregistered")).toBe(
      true,
    );
  });
});

describe("hook::fire extended", () => {
  it("fires hooks in priority order", async () => {
    const callOrder: string[] = [];
    createHook("h-low", "BeforeToolCall", 200);
    createHook("h-high", "BeforeToolCall", 10);
    createHook("h-mid", "BeforeToolCall", 100);

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        if (fnId.startsWith("fn::")) {
          callOrder.push(fnId);
          return {};
        }
        return null;
      },
    );

    await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::exec", arguments: {} },
    });

    expect(callOrder[0]).toBe("fn::h-high");
    expect(callOrder[1]).toBe("fn::h-mid");
    expect(callOrder[2]).toBe("fn::h-low");
  });

  it("skips disabled hooks", async () => {
    createHook("h-disabled", "BeforeToolCall", 100, false);

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::exec", arguments: {} },
    });
    expect(result.hooksFired).toBe(0);
  });

  it("filters by hook type", async () => {
    createHook("h-before", "BeforeToolCall");
    createHook("h-after", "AfterToolCall");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::exec", arguments: {} },
    });
    expect(result.hooksFired).toBe(1);
  });

  it("filters by agentId", async () => {
    createHook("h-agent1", "BeforeToolCall", 100, true, "agent-1");
    createHook("h-agent2", "BeforeToolCall", 100, true, "agent-2");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "agent-1", toolId: "tool::exec", arguments: {} },
      agentId: "agent-1",
    });
    expect(result.hooksFired).toBe(1);
  });

  it("blocks execution on BeforeToolCall block", async () => {
    createHook("h-blocker", "BeforeToolCall", 1);

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        if (fnId === "fn::h-blocker")
          return { block: true, reason: "Dangerous tool" };
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::rm", arguments: {} },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("Dangerous tool");
  });

  it("stops firing after block", async () => {
    createHook("h-block-first", "BeforeToolCall", 1);
    createHook("h-after-block", "BeforeToolCall", 200);

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        if (fnId === "fn::h-block-first")
          return { block: true, reason: "Blocked" };
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "t1", arguments: {} },
    });
    expect(result.hooksFired).toBe(1);
  });

  it("modifies payload in BeforePromptBuild", async () => {
    createHook("h-modify", "BeforePromptBuild");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        if (fnId === "fn::h-modify")
          return {
            modifiedPayload: {
              agentId: "a1",
              systemPrompt: "Modified!",
              messages: [],
            },
          };
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforePromptBuild",
      payload: { agentId: "a1", systemPrompt: "Original", messages: [] },
    });
    expect(result.modifiedPayload.systemPrompt).toBe("Modified!");
  });

  it("handles hook errors gracefully", async () => {
    createHook("h-error", "AfterToolCall");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        if (fnId === "fn::h-error") throw new Error("Hook crashed");
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "AfterToolCall",
      payload: {
        agentId: "a1",
        toolId: "t1",
        arguments: {},
        result: {},
        durationMs: 10,
      },
    });
    expect(result.results[0].error).toBe("Hook crashed");
  });

  it("filters by toolIds in filter", async () => {
    createHook("h-filtered", "BeforeToolCall", 100, true, undefined, {
      toolIds: ["tool::exec"],
    });
    createHook("h-all-tools", "BeforeToolCall");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "BeforeToolCall",
      payload: { agentId: "a1", toolId: "tool::read", arguments: {} },
    });
    expect(result.hooksFired).toBe(1);
  });

  it("rejects invalid hook type in fire", async () => {
    await expect(
      call("hook::fire", { type: "BadType", payload: {} }),
    ).rejects.toThrow("Invalid hook type");
  });

  it("returns empty results for no hooks", async () => {
    const result = await call("hook::fire", {
      type: "AgentLoopEnd",
      payload: { agentId: "a1", iterations: 5, response: "Done" },
    });
    expect(result.hooksFired).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("includes duration in results", async () => {
    createHook("h-dur", "AgentLoopEnd");

    mockTrigger.mockImplementation(
      async (fnId: string, data?: any): Promise<any> => {
        if (fnId === "state::list") {
          return [...getScope(data.scope).entries()].map(([key, value]) => ({
            key,
            value,
          }));
        }
        return {};
      },
    );

    const result = await call("hook::fire", {
      type: "AgentLoopEnd",
      payload: { agentId: "a1", iterations: 1, response: "ok" },
    });
    expect(result.results[0].durationMs).toBeDefined();
    expect(typeof result.results[0].durationMs).toBe("number");
  });
});

describe("hook::list extended", () => {
  it("lists all hooks", async () => {
    createHook("list-1", "BeforeToolCall");
    createHook("list-2", "AfterToolCall");
    const result = await call("hook::list", {});
    expect(result.count).toBe(2);
  });

  it("filters by type", async () => {
    createHook("type-1", "BeforeToolCall");
    createHook("type-2", "AfterToolCall");
    createHook("type-3", "BeforeToolCall");
    const result = await call("hook::list", { type: "BeforeToolCall" });
    expect(result.count).toBe(2);
  });

  it("filters enabled only", async () => {
    createHook("en-1", "BeforeToolCall", 100, true);
    createHook("en-2", "BeforeToolCall", 100, false);
    const result = await call("hook::list", { enabledOnly: true });
    expect(result.count).toBe(1);
  });

  it("groups hooks by type", async () => {
    createHook("grp-1", "BeforeToolCall");
    createHook("grp-2", "AfterToolCall");
    createHook("grp-3", "BeforeToolCall");
    const result = await call("hook::list", {});
    expect(result.grouped.BeforeToolCall.length).toBe(2);
    expect(result.grouped.AfterToolCall.length).toBe(1);
  });

  it("sorts by type then priority", async () => {
    createHook("sort-1", "BeforeToolCall", 200);
    createHook("sort-2", "BeforeToolCall", 50);
    createHook("sort-3", "AfterToolCall", 100);
    const result = await call("hook::list", {});
    const btcHooks = result.hooks.filter(
      (h: any) => h.type === "BeforeToolCall",
    );
    expect(btcHooks[0].priority).toBe(50);
    expect(btcHooks[1].priority).toBe(200);
  });

  it("returns empty when no hooks", async () => {
    const result = await call("hook::list", {});
    expect(result.count).toBe(0);
    expect(result.hooks).toHaveLength(0);
  });
});

describe("hook::toggle extended", () => {
  it("disables an enabled hook", async () => {
    createHook("tog-1", "BeforeToolCall", 100, true);
    const result = await call("hook::toggle", {
      hookId: "tog-1",
      enabled: false,
    });
    expect(result.toggled).toBe(true);
    expect(result.enabled).toBe(false);
  });

  it("enables a disabled hook", async () => {
    createHook("tog-2", "BeforeToolCall", 100, false);
    const result = await call("hook::toggle", {
      hookId: "tog-2",
      enabled: true,
    });
    expect(result.toggled).toBe(true);
    expect(result.enabled).toBe(true);
  });

  it("throws for non-existent hook", async () => {
    await expect(
      call("hook::toggle", { hookId: "nonexistent", enabled: true }),
    ).rejects.toThrow("Hook not found");
  });
});

describe("hook::update_priority extended", () => {
  it("updates priority", async () => {
    createHook("pri-1", "BeforeToolCall", 100);
    const result = await call("hook::update_priority", {
      hookId: "pri-1",
      priority: 50,
    });
    expect(result.updated).toBe(true);
    expect(result.priority).toBe(50);
  });

  it("throws for non-existent hook", async () => {
    await expect(
      call("hook::update_priority", { hookId: "nonexistent", priority: 10 }),
    ).rejects.toThrow("Hook not found");
  });

  it("updates priority to zero", async () => {
    createHook("pri-zero", "BeforeToolCall", 100);
    const result = await call("hook::update_priority", {
      hookId: "pri-zero",
      priority: 0,
    });
    expect(result.priority).toBe(0);
  });
});

import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "hooks",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

type HookType =
  | "BeforeToolCall"
  | "AfterToolCall"
  | "BeforePromptBuild"
  | "AgentLoopEnd";

interface HookDefinition {
  id: string;
  name: string;
  type: HookType;
  priority: number;
  functionId: string;
  enabled: boolean;
  agentId?: string;
  filter?: Record<string, unknown>;
  createdAt: number;
}

interface HookResult {
  hookId: string;
  hookName: string;
  result: unknown;
  blocked?: boolean;
  reason?: string;
  durationMs: number;
  error?: string;
}

interface BeforeToolCallPayload {
  agentId: string;
  toolId: string;
  arguments: Record<string, unknown>;
}

interface AfterToolCallPayload {
  agentId: string;
  toolId: string;
  arguments: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}

interface BeforePromptBuildPayload {
  agentId: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

interface AgentLoopEndPayload {
  agentId: string;
  iterations: number;
  response: string;
  usage?: { input: number; output: number; total: number };
}

const VALID_HOOK_TYPES: readonly HookType[] = [
  "BeforeToolCall",
  "AfterToolCall",
  "BeforePromptBuild",
  "AgentLoopEnd",
] as const;

async function loadHooks(): Promise<HookDefinition[]> {
  const entries: any = await trigger({
    function_id: "state::list",
    payload: { scope: "hooks" },
  }).catch(
    () => [],
  );
  return (entries || []).map((e: any) => e.value).filter((h: any) => h && h.id);
}

async function saveHook(hook: HookDefinition): Promise<void> {
  await trigger({
    function_id: "state::set",
    payload: { scope: "hooks", key: hook.id, value: hook },
  });
}

registerFunction(
  {
    id: "hook::register",
    description: "Register a hook",
    metadata: { category: "hooks" },
  },
  async ({
    name,
    type,
    priority,
    functionId,
    agentId,
    filter,
  }: {
    name: string;
    type: HookType;
    priority?: number;
    functionId: string;
    agentId?: string;
    filter?: Record<string, unknown>;
  }) => {
    if (!VALID_HOOK_TYPES.includes(type)) {
      throw new Error(
        `Invalid hook type: ${type}. Valid: ${VALID_HOOK_TYPES.join(", ")}`,
      );
    }

    if (!functionId) throw new Error("functionId is required");

    const hookId = crypto.randomUUID();

    const hook: HookDefinition = {
      id: hookId,
      name: name || `${type}-${hookId.slice(0, 8)}`,
      type,
      priority: priority ?? 100,
      functionId,
      enabled: true,
      agentId,
      filter,
      createdAt: Date.now(),
    };

    await saveHook(hook);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "hook_registered",
        detail: { hookId, name: hook.name, hookType: type, functionId },
      },
      action: TriggerAction.Void(),
    });

    return { registered: true, id: hookId, name: hook.name, type };
  },
);

registerFunction(
  {
    id: "hook::unregister",
    description: "Remove a hook",
    metadata: { category: "hooks" },
  },
  async ({ hookId }: { hookId: string }) => {
    const hook: any = await trigger({
      function_id: "state::get",
      payload: { scope: "hooks", key: hookId },
    }).catch(() => null);
    if (!hook) throw new Error(`Hook not found: ${hookId}`);

    await trigger({
      function_id: "state::delete",
      payload: { scope: "hooks", key: hookId },
    });

    trigger({
      function_id: "security::audit",
      payload: {
      type: "hook_unregistered",
      detail: { hookId, name: hook.name },
    },
    action: TriggerAction.Void(),
    });

    return { unregistered: true, id: hookId };
  },
);

registerFunction(
  {
    id: "hook::fire",
    description: "Fire hooks of a given type and return results",
    metadata: { category: "hooks" },
  },
  async ({
    type,
    payload,
    agentId,
  }: {
    type: HookType;
    payload:
      | BeforeToolCallPayload
      | AfterToolCallPayload
      | BeforePromptBuildPayload
      | AgentLoopEndPayload;
    agentId?: string;
  }) => {
    if (!VALID_HOOK_TYPES.includes(type)) {
      throw new Error(`Invalid hook type: ${type}`);
    }

    const allHooks = await loadHooks();

    const payloadAgentId = (payload as any).agentId;
    let applicable = allHooks.filter(
      (h) =>
        h.type === type &&
        h.enabled &&
        (!h.agentId || h.agentId === agentId || h.agentId === payloadAgentId),
    );

    if (type === "BeforeToolCall" || type === "AfterToolCall") {
      const toolPayload = payload as
        | BeforeToolCallPayload
        | AfterToolCallPayload;
      applicable = applicable.filter((h) => {
        if (!h.filter?.toolIds) return true;
        const allowed = h.filter.toolIds as string[];
        return allowed.includes(toolPayload.toolId);
      });
    }

    applicable.sort((a, b) => a.priority - b.priority);

    const results: HookResult[] = [];
    let blocked = false;
    let blockReason = "";
    let modifiedPayload = { ...payload };

    for (const hook of applicable) {
      const start = Date.now();

      try {
        const result: any = await trigger({
          function_id: hook.functionId,
          payload: {
            hookType: type,
            hookId: hook.id,
            hookName: hook.name,
            payload: modifiedPayload,
          },
        });

        const durationMs = Date.now() - start;

        const hookResult: HookResult = {
          hookId: hook.id,
          hookName: hook.name,
          result,
          durationMs,
        };

        if (type === "BeforeToolCall" && result?.block) {
          hookResult.blocked = true;
          hookResult.reason = result.reason || "Blocked by hook";
          blocked = true;
          blockReason = hookResult.reason!;
          results.push(hookResult);
          break;
        }

        if (type === "BeforePromptBuild" && result?.modifiedPayload) {
          modifiedPayload = result.modifiedPayload;
        }

        results.push(hookResult);
      } catch (err: any) {
        results.push({
          hookId: hook.id,
          hookName: hook.name,
          result: null,
          durationMs: Date.now() - start,
          error: err.message,
        });
      }
    }

    const response: Record<string, unknown> = {
      type,
      hooksFired: results.length,
      results,
    };

    if (type === "BeforeToolCall") {
      response.blocked = blocked;
      response.blockReason = blockReason;
    }

    if (type === "BeforePromptBuild") {
      response.modifiedPayload = modifiedPayload;
    }

    return response;
  },
);

registerFunction(
  {
    id: "hook::list",
    description: "List registered hooks",
    metadata: { category: "hooks" },
  },
  async ({
    type,
    agentId,
    enabledOnly,
  }: {
    type?: HookType;
    agentId?: string;
    enabledOnly?: boolean;
  } = {}) => {
    let hooks = await loadHooks();

    if (type) hooks = hooks.filter((h) => h.type === type);
    if (agentId)
      hooks = hooks.filter((h) => !h.agentId || h.agentId === agentId);
    if (enabledOnly) hooks = hooks.filter((h) => h.enabled);

    hooks.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.priority - b.priority;
    });

    const grouped: Record<string, HookDefinition[]> = {};
    for (const hook of hooks) {
      (grouped[hook.type] ??= []).push(hook);
    }

    return { hooks, count: hooks.length, grouped };
  },
);

registerFunction(
  {
    id: "hook::toggle",
    description: "Enable or disable a hook",
    metadata: { category: "hooks" },
  },
  async ({ hookId, enabled }: { hookId: string; enabled: boolean }) => {
    const hook = (await trigger({
      function_id: "state::get",
      payload: { scope: "hooks", key: hookId },
    }).catch(() => null)) as HookDefinition | null;

    if (!hook) throw new Error(`Hook not found: ${hookId}`);

    hook.enabled = enabled;
    await saveHook(hook);

    return { toggled: true, id: hookId, enabled };
  },
);

registerFunction(
  {
    id: "hook::update_priority",
    description: "Update hook priority",
    metadata: { category: "hooks" },
  },
  async ({ hookId, priority }: { hookId: string; priority: number }) => {
    const hook = (await trigger({
      function_id: "state::get",
      payload: { scope: "hooks", key: hookId },
    }).catch(() => null)) as HookDefinition | null;

    if (!hook) throw new Error(`Hook not found: ${hookId}`);

    hook.priority = priority;
    await saveHook(hook);

    return { updated: true, id: hookId, priority };
  },
);

registerTrigger({
  type: "http",
  function_id: "hook::register",
  config: { api_path: "api/hooks", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "hook::unregister",
  config: { api_path: "api/hooks/:hookId", http_method: "DELETE" },
});
registerTrigger({
  type: "http",
  function_id: "hook::list",
  config: { api_path: "api/hooks", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "hook::fire",
  config: { api_path: "api/hooks/fire", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "hook::toggle",
  config: { api_path: "api/hooks/toggle", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "hook::update_priority",
  config: { api_path: "api/hooks/priority", http_method: "POST" },
});

registerTrigger({
  type: "subscribe",
  function_id: "hook::fire",
  config: { topic: "hooks.fire" },
});

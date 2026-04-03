import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { normalizeCronExpression } from "./shared/cron.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";
import { requireAuth } from "./shared/utils.js";

const log = new Logger();

const sdk = registerWorker(ENGINE_URL, {
  workerName: "session-lifecycle",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

type LifecycleState =
  | "spawning"
  | "working"
  | "blocked"
  | "pr_open"
  | "review"
  | "merged"
  | "done"
  | "failed"
  | "recovering"
  | "terminated";

const VALID_TRANSITIONS: Record<string, LifecycleState[]> = {
  spawning: ["working", "failed", "terminated"],
  working: ["blocked", "pr_open", "failed", "terminated"],
  blocked: ["working", "failed", "terminated"],
  pr_open: ["review", "merged", "failed", "terminated"],
  review: ["merged", "pr_open", "failed", "terminated"],
  merged: ["done", "terminated"],
  done: [],
  failed: ["recovering", "terminated"],
  recovering: ["working", "failed", "terminated"],
  terminated: [],
};

const TERMINAL_STATES = new Set(["done", "terminated"]);

interface Reaction {
  id: string;
  from: LifecycleState;
  to: LifecycleState;
  action: "send_to_agent" | "notify" | "escalate" | "auto_recover";
  payload: Record<string, unknown>;
  escalateAfter: number;
  attempts: number;
}

type StoredReaction = {
  key?: string;
  value: Reaction;
};

registerFunction(
  {
    id: "lifecycle::transition",
    description: "Move session to new state, validate transition, fire reactions",
    metadata: { category: "lifecycle" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, newState, reason } = req.body || req;
    const current: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `lifecycle:${agentId}`, key: "state" },
        }),
      null,
      { agentId, operation: "get_lifecycle_state" },
    );

    const currentState: LifecycleState = current?.state || "spawning";

    if (TERMINAL_STATES.has(currentState)) {
      return {
        transitioned: false,
        reason: `Cannot transition from terminal state: ${currentState}`,
      };
    }

    const allowed = VALID_TRANSITIONS[currentState] || [];
    if (!allowed.includes(newState)) {
      return {
        transitioned: false,
        reason: `Invalid transition: ${currentState} → ${newState}`,
      };
    }

    const entry = {
      state: newState,
      previousState: currentState,
      reason: reason || "",
      transitionedAt: Date.now(),
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: `lifecycle:${agentId}`, key: "state", value: entry },
    });

    await trigger({
      function_id: "state::update",
      payload: {
        scope: `lifecycle:${agentId}`,
        key: "history",
        operations: [{ type: "merge", path: "transitions", value: [entry] }],
      },
    });

    triggerVoid("hook::fire", {
      type: "SessionStateChange",
      agentId,
      from: currentState,
      to: newState,
      reason,
    });

    const [agentReactions, globalReactions] = await Promise.all([
      safeCall<StoredReaction[]>(
        () =>
          trigger({
            function_id: "state::list",
            payload: { scope: `lifecycle_reactions:${agentId}` },
          }),
        [],
        { operation: "list_agent_reactions" },
      ),
      safeCall<StoredReaction[]>(
        () =>
          trigger({
            function_id: "state::list",
            payload: { scope: "lifecycle_reactions" },
          }),
        [],
        { operation: "list_global_reactions" },
      ),
    ]);
    const reactions = [
      ...agentReactions.map((r: any) => ({ ...r, _scope: `lifecycle_reactions:${agentId}` })),
      ...globalReactions.map((r: any) => ({ ...r, _scope: "lifecycle_reactions" })),
    ];

    for (const r of reactions) {
      const reaction: Reaction = r.value;
      if (!reaction || reaction.from !== currentState || reaction.to !== newState)
        continue;

      if (reaction.attempts >= reaction.escalateAfter) {
        triggerVoid("hook::fire", {
          type: "LifecycleEscalation",
          agentId,
          reaction: reaction.id,
          attempts: reaction.attempts,
        });
        continue;
      }

      if (reaction.action === "send_to_agent") {
        triggerVoid("tool::agent_send", {
          targetAgentId: agentId,
          message:
            (reaction.payload?.message as string) ||
            `State changed: ${currentState} → ${newState}`,
        });
      } else if (reaction.action === "auto_recover") {
        triggerVoid("recovery::recover", { agentId });
      } else if (reaction.action === "notify") {
        triggerVoid("hook::fire", {
          type: "LifecycleNotification",
          agentId,
          from: currentState,
          to: newState,
          payload: reaction.payload,
        });
      } else if (reaction.action === "escalate") {
        triggerVoid("hook::fire", {
          type: "LifecycleEscalation",
          agentId,
          reaction: reaction.id,
          attempts: reaction.attempts,
          immediate: true,
        });
      }

      await trigger({
        function_id: "state::update",
        payload: {
          scope: r._scope || `lifecycle_reactions:${agentId}`,
          key: reaction.id,
          operations: [
            { type: "increment", path: "attempts", value: 1 },
            { type: "set", path: "lastFiredAt", value: Date.now() },
          ],
        },
      });
    }

    recordMetric("lifecycle_transitions_total", 1, {
      from: currentState,
      to: newState,
    });
    log.info("Lifecycle transition", { agentId, from: currentState, to: newState });

    return { transitioned: true, from: currentState, to: newState };
  },
);

registerFunction(
  {
    id: "lifecycle::get_state",
    description: "Get current lifecycle state for a session",
    metadata: { category: "lifecycle" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId } = req.body || req;
    const state: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `lifecycle:${agentId}`, key: "state" },
        }),
      null,
      { agentId, operation: "get_state" },
    );
    return state || { state: "spawning", transitionedAt: Date.now() };
  },
);

registerFunction(
  {
    id: "lifecycle::add_reaction",
    description: "Register a declarative reaction rule for state transitions",
    metadata: { category: "lifecycle" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, from, to, action, payload, escalateAfter = 3 } = req.body || req;
    const id = `rxn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reaction: Reaction = {
      id,
      from,
      to,
      action,
      payload: payload || {},
      escalateAfter: Math.max(1, escalateAfter),
      attempts: 0,
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: `lifecycle_reactions:${agentId}`, key: id, value: reaction },
    });

    return { id, registered: true };
  },
);

registerFunction(
  {
    id: "lifecycle::list_reactions",
    description: "List configured reaction rules",
    metadata: { category: "lifecycle" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId } = req.body || req || {};
    const scope = agentId ? `lifecycle_reactions:${agentId}` : "lifecycle_reactions";
    const all: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope },
        }),
      [],
      { operation: "list_reactions" },
    );
    return all.map((e: any) => e.value).filter(Boolean);
  },
);

registerFunction(
  {
    id: "lifecycle::check_all",
    description: "Scan all sessions, detect state changes, auto-transition",
    metadata: { category: "lifecycle", cron: true },
  },
  async () => {
    const agents: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: "agents" },
        }),
      [],
      { operation: "list_agents" },
    );

    const validAgents = agents
      .map((a: any) => a.key)
      .filter(Boolean);

    const states = await Promise.all(
      validAgents.map((agentId: string) =>
        safeCall(
          () =>
            trigger({
              function_id: "state::get",
              payload: { scope: `lifecycle:${agentId}`, key: "state" },
            }),
          null,
          { agentId, operation: "check_state" },
        ).then((state: any) => ({ agentId, state })),
      ),
    );

    const activeAgents = states.filter(
      ({ state }) => state && !TERMINAL_STATES.has(state.state),
    );

    const guardResults = await Promise.all(
      activeAgents.map(({ agentId }) =>
        safeCall(
          () =>
            trigger({
              function_id: "guard::stats",
              payload: { agentId },
            }),
          null,
          { agentId, operation: "guard_stats" },
        ).then((stats: any) => ({ agentId, stats })),
      ),
    );

    const guardMap = new Map(
      guardResults.map(({ agentId, stats }) => [agentId, stats]),
    );

    let transitioned = 0;
    for (const { agentId, state } of activeAgents) {
      const guardStats = guardMap.get(agentId);

      if (guardStats?.circuitBroken && state.state === "working") {
        await trigger({
          function_id: "lifecycle::transition",
          payload: { agentId, newState: "blocked", reason: "Circuit breaker tripped" },
        });
        transitioned++;
        continue;
      }

      if (
        state.state === "working" &&
        state.transitionedAt &&
        Date.now() - state.transitionedAt > 2 * 60 * 60 * 1000
      ) {
        await trigger({
          function_id: "lifecycle::transition",
          payload: { agentId, newState: "blocked", reason: "Inactive for 2+ hours" },
        });
        transitioned++;
      }
    }

    return { checked: validAgents.length, transitioned };
  },
);

registerTrigger({
  type: "http",
  function_id: "lifecycle::transition",
  config: { api_path: "api/lifecycle/transition", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "lifecycle::get_state",
  config: { api_path: "api/lifecycle/state/:agentId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "lifecycle::add_reaction",
  config: { api_path: "api/lifecycle/reactions", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "lifecycle::list_reactions",
  config: { api_path: "api/lifecycle/reactions", http_method: "GET" },
});
registerTrigger({
  type: "cron",
  function_id: "lifecycle::check_all",
  config: { expression: normalizeCronExpression("*/2 * * * *") },
});

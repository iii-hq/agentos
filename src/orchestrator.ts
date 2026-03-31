import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";
import { stripCodeFences, requireAuth, sanitizeId } from "./shared/utils.js";

const log = createLogger("orchestrator");
const sdk = registerWorker(ENGINE_URL, { workerName: "orchestrator", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

interface Plan {
  id: string;
  description: string;
  complexity: "low" | "medium" | "high";
  agents: string[];
  reactions: { from: string; to: string; action: string; payload: Record<string, unknown> }[];
  createdAt: number;
  status: "planned" | "executing" | "paused" | "complete" | "cancelled";
}

interface Run {
  planId: string;
  rootId: string;
  startedAt: number;
  status: "running" | "paused" | "complete" | "cancelled";
}

registerFunction(
  {
    id: "orchestrator::plan",
    description: "Analyze a feature request and create an execution plan with agents and reactions",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { description, model } = req.body || req;

    if (!description) {
      throw Object.assign(new Error("description is required"), { statusCode: 400 });
    }

    const llmResult: any = await trigger({
      function_id: "llm::chat",
      payload: {
        model: model || "default",
        messages: [
          {
            role: "system",
            content:
              'Analyze the following feature request. Return JSON: { "complexity": "low"|"medium"|"high", "agents": ["<template-name>", ...], "reactions": [{ "from": "<lifecycle-state>", "to": "<lifecycle-state>", "action": "send_to_agent"|"notify"|"escalate", "payload": {} }], "summary": "..." }',
          },
          { role: "user", content: description },
        ],
      },
    });

    let parsed: { complexity: string; agents: string[]; reactions: any[]; summary: string };
    try {
      parsed = JSON.parse(stripCodeFences(llmResult?.content || "{}"));
    } catch {
      log.warn("Failed to parse LLM plan", { description: description.slice(0, 100) });
      parsed = {
        complexity: "medium",
        agents: ["general"],
        reactions: [],
        summary: description,
      };
    }

    const planId = crypto.randomUUID();
    const plan: Plan = {
      id: planId,
      description,
      complexity: (parsed.complexity as Plan["complexity"]) || "medium",
      agents: parsed.agents || ["general"],
      reactions: parsed.reactions || [],
      createdAt: Date.now(),
      status: "planned",
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: plan },
    });

    log.info("Plan created", { planId, complexity: plan.complexity, agentCount: plan.agents.length });
    recordMetric("orchestrator_plan_created", 1, { complexity: plan.complexity }, "counter");

    return plan;
  },
);

registerFunction(
  {
    id: "orchestrator::execute",
    description: "Decompose tasks, register lifecycle reactions, and spawn workers for a plan",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { planId } = req.body || req;

    if (!planId) {
      throw Object.assign(new Error("planId is required"), { statusCode: 400 });
    }

    const plan: Plan | null = await trigger({
      function_id: "state::get",
      payload: { scope: "orchestrator_plans", key: planId },
    });

    if (!plan) {
      throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
    }

    if (plan.status !== "planned") {
      throw Object.assign(
        new Error(`Cannot execute plan in status: ${plan.status}`),
        { statusCode: 400 },
      );
    }

    const decomposeResult: any = await trigger({
      function_id: "task::decompose",
      payload: { description: plan.description },
    });

    const rootId = decomposeResult?.rootId;
    if (!rootId) {
      throw new Error("Task decomposition failed");
    }

    const run: Run = {
      planId,
      rootId,
      startedAt: Date.now(),
      status: "running",
    };

    await Promise.all([
      trigger({
        function_id: "state::set",
        payload: { scope: "orchestrator_runs", key: planId, value: run },
      }),
      ...plan.reactions.map((reaction) => {
        const reactionId = crypto.randomUUID();
        return safeCall(
          () =>
            trigger({
              function_id: "state::set",
              payload: {
                scope: "lifecycle_reactions",
                key: reactionId,
                value: {
                  id: reactionId,
                  from: reaction.from,
                  to: reaction.to,
                  action: reaction.action,
                  payload: reaction.payload || {},
                  escalateAfter: 3,
                  attempts: 0,
                },
              },
            }),
          undefined,
          { operation: "register_reaction" },
        );
      }),
    ]);

    plan.status = "executing";
    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: plan },
    });

    await safeCall(
      () =>
        trigger({
          function_id: "state::set",
          payload: {
            scope: `workspace:${planId}`,
            key: "_meta",
            value: {
              key: "_meta",
              value: { planId, rootId, description: plan.description },
              writtenBy: "orchestrator",
              writtenAt: Date.now(),
            },
          },
        }),
      undefined,
      { operation: "seed_workspace_meta" },
    );

    const spawnResult: any = await trigger({
      function_id: "task::spawn_workers",
      payload: { rootId },
    });

    log.info("Plan execution started", { planId, rootId, spawned: spawnResult?.spawned?.length });
    recordMetric("orchestrator_execute", 1, { planId }, "counter");

    return { planId, rootId, workspaceScope: `workspace:${planId}`, spawned: spawnResult?.spawned || [] };
  },
);

registerFunction(
  {
    id: "orchestrator::status",
    description: "Get plan progress or list all plans",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { planId } = req.body || req;

    if (!planId) {
      const plans: any[] = await safeCall(
        () =>
          trigger({
            function_id: "state::list",
            payload: { scope: "orchestrator_plans" },
          }),
        [],
        { operation: "list_plans" },
      );
      return {
        count: plans.length,
        plans: plans.map((p) => ({
          id: (p.value || p).id,
          status: (p.value || p).status,
          complexity: (p.value || p).complexity,
          createdAt: (p.value || p).createdAt,
        })),
      };
    }

    const plan: any = await trigger({
      function_id: "state::get",
      payload: { scope: "orchestrator_plans", key: planId },
    });

    if (!plan) {
      throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
    }

    const run: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: "orchestrator_runs", key: planId },
        }),
      null,
      { operation: "get_run" },
    );

    if (!run) {
      return { plan, progress: null };
    }

    const taskEntries: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `tasks:${run.rootId}` },
        }),
      [],
      { operation: "list_tasks_for_status" },
    );

    const tasks = taskEntries.map((e) => e.value || e);
    const total = tasks.length;
    const completed = tasks.filter((t: any) => t.status === "complete").length;
    const failed = tasks.filter((t: any) => t.status === "failed").length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      plan,
      progress: {
        rootId: run.rootId,
        total,
        completed,
        failed,
        percentage,
        runStatus: run.status,
      },
    };
  },
);

registerFunction(
  {
    id: "orchestrator::intervene",
    description: "Intervene in plan execution: pause, resume, cancel, or redirect",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { planId, action, redirectTo } = req.body || req;

    if (!planId || !action) {
      throw Object.assign(
        new Error("planId and action are required"),
        { statusCode: 400 },
      );
    }

    const validActions = ["pause", "resume", "cancel", "redirect"];
    if (!validActions.includes(action)) {
      throw Object.assign(
        new Error(`Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`),
        { statusCode: 400 },
      );
    }

    const plan: Plan | null = await trigger({
      function_id: "state::get",
      payload: { scope: "orchestrator_plans", key: planId },
    });

    if (!plan) {
      throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
    }

    const run: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: "orchestrator_runs", key: planId },
        }),
      null,
      { operation: "get_run_for_intervene" },
    );

    if (action === "pause") {
      plan.status = "paused";
      if (run) {
        run.status = "paused";
        await trigger({
          function_id: "state::set",
          payload: { scope: "orchestrator_runs", key: planId, value: run },
        });
      }
    } else if (action === "resume") {
      plan.status = "executing";
      if (run) {
        run.status = "running";
        await trigger({
          function_id: "state::set",
          payload: { scope: "orchestrator_runs", key: planId, value: run },
        });
        triggerVoid("task::spawn_workers", { rootId: run.rootId });
      }
    } else if (action === "cancel") {
      plan.status = "cancelled";
      if (run) {
        run.status = "cancelled";
        await trigger({
          function_id: "state::set",
          payload: { scope: "orchestrator_runs", key: planId, value: run },
        });
      }
    } else if (action === "redirect") {
      if (!redirectTo) {
        throw Object.assign(
          new Error("redirectTo is required for redirect action"),
          { statusCode: 400 },
        );
      }
      plan.description = redirectTo;
      plan.status = "planned";
      if (run) {
        run.status = "cancelled";
        await trigger({
          function_id: "state::set",
          payload: { scope: "orchestrator_runs", key: planId, value: run },
        });
      }
    }

    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: plan },
    });

    log.info("Plan intervention", { planId, action });
    recordMetric("orchestrator_intervene", 1, { action }, "counter");

    return { planId, action, newStatus: plan.status };
  },
);

registerFunction(
  {
    id: "orchestrator::workspace_write",
    description: "Write to shared plan workspace",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { planId, key, value, agentId } = req.body || req;

    if (!planId || !key) {
      throw Object.assign(new Error("planId and key are required"), { statusCode: 400 });
    }

    const safePlanId = sanitizeId(planId);
    const safeKey = sanitizeId(key);

    const writtenBy = req.headers ? "authenticated" : (agentId || "system");
    const entry = {
      key: safeKey,
      value,
      writtenBy,
      writtenAt: Date.now(),
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: `workspace:${safePlanId}`, key: safeKey, value: entry },
    });

    log.info("Scratchpad write", { planId: safePlanId, key: safeKey, agentId });

    return { written: true, key: safeKey, planId: safePlanId };
  },
);

registerFunction(
  {
    id: "orchestrator::workspace_read",
    description: "Read from shared plan workspace",
    metadata: { category: "orchestrator" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { planId, key } = req.body || req;

    if (!planId) {
      throw Object.assign(new Error("planId is required"), { statusCode: 400 });
    }

    const safePlanId = sanitizeId(planId);

    if (key) {
      const safeKey = sanitizeId(key);
      const entry = await trigger({
        function_id: "state::get",
        payload: { scope: `workspace:${safePlanId}`, key: safeKey },
      });
      return entry;
    }

    const entries: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `workspace:${safePlanId}` },
        }),
      [],
      { operation: "list_workspace" },
    );

    return {
      planId: safePlanId,
      count: entries.length,
      entries: entries.map((e) => e.value || e),
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "orchestrator::plan",
  config: { api_path: "api/orchestrator/plan", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::execute",
  config: { api_path: "api/orchestrator/execute", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::status",
  config: { api_path: "api/orchestrator/status", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::intervene",
  config: { api_path: "api/orchestrator/intervene", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::workspace_write",
  config: { api_path: "api/orchestrator/workspace", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::workspace_read",
  config: { api_path: "api/orchestrator/workspace", http_method: "GET" },
});

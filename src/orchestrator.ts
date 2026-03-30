import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";
import { stripCodeFences } from "./shared/utils.js";

const log = createLogger("orchestrator");

const sdk = registerWorker(ENGINE_URL, {
  workerName: "orchestrator",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

type PlanStatus = "planning" | "approved" | "executing" | "completed" | "failed";

interface Plan {
  id: string;
  description: string;
  status: PlanStatus;
  rootTaskId: string | null;
  workerCount: number;
  createdAt: number;
  updatedAt: number;
}

registerFunction(
  {
    id: "orchestrator::plan",
    description: "LLM analyzes a feature request, creates execution plan",
    metadata: { category: "orchestrator" },
  },
  async ({
    description,
    autoExecute = false,
  }: {
    description: string;
    autoExecute?: boolean;
  }) => {
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let analysisResult: any;
    try {
      analysisResult = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            maxTokens: 4096,
          },
          systemPrompt: `You are an orchestrator that plans multi-agent work.
Analyze the feature request and create a plan. Output JSON only.`,
          messages: [
            {
              role: "user",
              content: `Feature request: ${description}

Analyze this and return a plan:
{
  "summary": "one-line summary",
  "complexity": "low|medium|high",
  "estimatedAgents": 1-10,
  "parallelizable": true/false,
  "decompositionPrompt": "task description for decomposer",
  "reactions": [
    {"from": "working", "to": "blocked", "action": "send_to_agent", "payload": {"message": "..."}}
  ]
}`,
            },
          ],
        },
      });
    } catch {
      return { planId, status: "failed", reason: "LLM analysis failed" };
    }

    let analysis: any;
    try {
      analysis = JSON.parse(
        stripCodeFences(analysisResult?.content || "{}"),
      );
    } catch {
      analysis = {
        summary: description.slice(0, 100),
        complexity: "medium",
        estimatedAgents: 1,
        parallelizable: false,
        decompositionPrompt: description,
        reactions: [],
      };
    }

    const plan: Plan = {
      id: planId,
      description: analysis.summary || description.slice(0, 200),
      status: autoExecute ? "approved" : "planning",
      rootTaskId: null,
      workerCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "orchestrator_plans",
        key: planId,
        value: { ...plan, analysis },
      },
    });

    recordMetric("orchestrator_plans_total", 1, {
      complexity: analysis.complexity,
    });
    log.info("Orchestrator plan created", {
      planId,
      complexity: analysis.complexity,
      agents: analysis.estimatedAgents,
    });

    if (autoExecute) {
      triggerVoid("orchestrator::execute", { planId });
    }

    return { planId, plan, analysis };
  },
);

registerFunction(
  {
    id: "orchestrator::execute",
    description: "Execute plan: decompose tasks, spawn workers, set up monitoring",
    metadata: { category: "orchestrator" },
  },
  async ({ planId }: { planId: string }) => {
    const planData: any = await trigger({
      function_id: "state::get",
      payload: { scope: "orchestrator_plans", key: planId },
    });
    if (!planData) return { executed: false, reason: "Plan not found" };

    if (planData.status !== "approved" && planData.status !== "planning") {
      return {
        executed: false,
        reason: `Cannot execute plan in status: ${planData.status}`,
      };
    }

    planData.status = "executing";
    planData.updatedAt = Date.now();
    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: planData },
    });

    const decompositionPrompt =
      planData.analysis?.decompositionPrompt || planData.description;
    const decomposed: any = await safeCall(
      () =>
        trigger({
          function_id: "task::decompose",
          payload: { description: decompositionPrompt },
        }),
      null,
      { operation: "decompose" },
    );

    if (!decomposed?.rootId) {
      planData.status = "failed";
      planData.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: "orchestrator_plans", key: planId, value: planData },
      });
      return { executed: false, reason: "Task decomposition failed" };
    }

    planData.rootTaskId = decomposed.rootId;
    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: planData },
    });

    await Promise.all(
      (planData.analysis?.reactions || []).map((reaction: any) =>
        safeCall(
          () =>
            trigger({
              function_id: "lifecycle::add_reaction",
              payload: {
                from: reaction.from,
                to: reaction.to,
                action: reaction.action,
                payload: reaction.payload,
                escalateAfter: reaction.escalateAfter || 3,
              },
            }),
          null,
          { operation: "add_reaction" },
        ),
      ),
    );

    const spawnResult: any = await safeCall(
      () =>
        trigger({
          function_id: "task::spawn_workers",
          payload: { rootId: decomposed.rootId },
        }),
      null,
      { operation: "spawn_workers" },
    );

    planData.workerCount = spawnResult?.spawned || 0;
    planData.updatedAt = Date.now();
    await trigger({
      function_id: "state::set",
      payload: { scope: "orchestrator_plans", key: planId, value: planData },
    });

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "orchestrator_runs",
        key: planId,
        value: {
          planId,
          rootTaskId: decomposed.rootId,
          startedAt: Date.now(),
          workerCount: planData.workerCount,
        },
      },
    });

    recordMetric("orchestrator_executions_total", 1, {
      workers: String(planData.workerCount),
    });
    log.info("Orchestrator execution started", {
      planId,
      rootTaskId: decomposed.rootId,
      workers: planData.workerCount,
    });

    return {
      executed: true,
      planId,
      rootTaskId: decomposed.rootId,
      workersSpawned: planData.workerCount,
    };
  },
);

registerFunction(
  {
    id: "orchestrator::status",
    description: "Get orchestrator status with plan and worker progress",
    metadata: { category: "orchestrator" },
  },
  async ({ planId }: { planId?: string } = {}) => {
    if (planId) {
      const plan: any = await safeCall(
        () =>
          trigger({
            function_id: "state::get",
            payload: { scope: "orchestrator_plans", key: planId },
          }),
        null,
        { operation: "get_plan" },
      );
      if (!plan) return { found: false };

      let tasks: any[] = [];
      if (plan.rootTaskId) {
        tasks = await safeCall(
          () =>
            trigger({
              function_id: "task::list",
              payload: { rootId: plan.rootTaskId },
            }),
          [],
          { operation: "list_tasks" },
        );
      }

      const completed = (tasks || []).filter(
        (t: any) => t.status === "completed",
      ).length;
      const total = (tasks || []).length;

      return {
        found: true,
        plan,
        progress: {
          total,
          completed,
          pending: total - completed,
          percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        },
      };
    }

    const allPlans: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: "orchestrator_plans" },
        }),
      [],
      { operation: "list_plans" },
    );

    return {
      plans: (allPlans || [])
        .map((e: any) => ({
          id: e.value?.id,
          description: e.value?.description,
          status: e.value?.status,
          workerCount: e.value?.workerCount,
          createdAt: e.value?.createdAt,
        }))
        .filter((p: any) => p.id)
        .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0)),
    };
  },
);

registerFunction(
  {
    id: "orchestrator::intervene",
    description: "Human or system redirects the orchestrator",
    metadata: { category: "orchestrator" },
  },
  async ({
    planId,
    action,
    message,
  }: {
    planId: string;
    action: "pause" | "resume" | "cancel" | "redirect";
    message?: string;
  }) => {
    const plan: any = await trigger({
      function_id: "state::get",
      payload: { scope: "orchestrator_plans", key: planId },
    });
    if (!plan) return { success: false, reason: "Plan not found" };

    if (action === "cancel") {
      plan.status = "failed";
      plan.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: "orchestrator_plans", key: planId, value: plan },
      });
      log.info("Orchestrator plan cancelled", { planId });
      return { success: true, action: "cancel" };
    }

    if (action === "pause" && plan.status === "executing") {
      plan.status = "approved";
      plan.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: "orchestrator_plans", key: planId, value: plan },
      });
      return { success: true, action: "pause" };
    }

    if (action === "resume" && plan.status === "approved") {
      triggerVoid("orchestrator::execute", { planId });
      return { success: true, action: "resume" };
    }

    if (action === "redirect" && message) {
      plan.analysis = plan.analysis || {};
      plan.analysis.redirectionNote = message;
      plan.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: "orchestrator_plans", key: planId, value: plan },
      });
      log.info("Orchestrator redirected", { planId, message });
      return { success: true, action: "redirect" };
    }

    return { success: false, reason: `Invalid action: ${action}` };
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
  config: { api_path: "api/orchestrator/status", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "orchestrator::intervene",
  config: { api_path: "api/orchestrator/intervene", http_method: "POST" },
});

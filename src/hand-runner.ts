import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "hand-runner" },
);

interface HandConfig {
  id: string;
  name: string;
  description: string;
  tools: string[];
  schedule: string;
  agentConfig: {
    model?: string;
    maxIterations: number;
    temperature: number;
    systemPrompt: string;
  };
  settings: Record<string, unknown>;
  metrics: Array<{ label: string; key: string }>;
  enabled: boolean;
}

registerFunction(
  {
    id: "hand::register",
    description: "Register an autonomous hand",
    metadata: { category: "hand" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const config: HandConfig = req.body || req;
    const id = config.id || crypto.randomUUID();
    const hand = { ...config, id, registeredAt: Date.now() };

    await trigger("state::set", { scope: "hands", key: id, value: hand });

    await trigger("security::set_capabilities", {
      agentId: `hand:${id}`,
      capabilities: {
        tools: config.tools,
        memoryScopes: [`memory:hand:${id}`, "shared.*"],
        networkHosts: ["*"],
        maxTokensPerHour: 500_000,
      },
    });

    await trigger("agent::create", {
      id: `hand:${id}`,
      name: `hand-${config.name}`,
      model: { model: config.agentConfig.model || "claude-sonnet-4-6" },
      systemPrompt: config.agentConfig.systemPrompt,
      capabilities: { tools: config.tools },
    });

    if (config.enabled && config.schedule) {
      registerTrigger({
        type: "cron",
        function_id: "hand::execute",
        config: { expression: config.schedule },
      });
    }

    return { id, registered: true };
  },
);

registerFunction(
  {
    id: "hand::execute",
    description: "Execute a hand run cycle",
    metadata: { category: "hand" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { handId } = req.body || req;
    const hands = handId
      ? [await trigger("state::get", { scope: "hands", key: handId })]
      : ((await trigger("state::list", { scope: "hands" })) as any[])
          .filter((h: any) => h.value?.enabled)
          .map((h: any) => h.value);

    const results = [];

    for (const hand of hands) {
      if (!hand) continue;

      const runId = crypto.randomUUID();
      const startMs = Date.now();

      await trigger("state::set", {
        scope: `hand_runs:${hand.id}`,
        key: runId,
        value: {
          runId,
          handId: hand.id,
          status: "running",
          startedAt: startMs,
        },
      });

      try {
        const response: any = await trigger("agent::chat", {
          agentId: `hand:${hand.id}`,
          message: buildHandPrompt(hand),
          sessionId: `hand:${hand.id}:${new Date().toISOString().slice(0, 10)}`,
          systemPrompt: hand.agentConfig.systemPrompt,
        });

        for (const metric of hand.metrics || []) {
          triggerVoid("state::update", {
            scope: "hand_metrics",
            key: hand.id,
            operations: [
              { type: "increment", path: metric.key, value: 1 },
              { type: "set", path: "lastRunAt", value: Date.now() },
            ],
          });
        }

        await trigger("state::update", {
          scope: `hand_runs:${hand.id}`,
          key: runId,
          operations: [
            { type: "set", path: "status", value: "completed" },
            { type: "set", path: "completedAt", value: Date.now() },
            { type: "set", path: "durationMs", value: Date.now() - startMs },
            { type: "set", path: "iterations", value: response.iterations },
          ],
        });

        results.push({ handId: hand.id, runId, status: "completed" });
      } catch (err: any) {
        await trigger("state::update", {
          scope: `hand_runs:${hand.id}`,
          key: runId,
          operations: [
            { type: "set", path: "status", value: "failed" },
            { type: "set", path: "error", value: err.message },
            { type: "set", path: "failedAt", value: Date.now() },
          ],
        });

        results.push({
          handId: hand.id,
          runId,
          status: "failed",
          error: err.message,
        });
      }
    }

    return { results };
  },
);

registerFunction(
  {
    id: "hand::list",
    description: "List all registered hands",
    metadata: { category: "hand" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    return trigger("state::list", { scope: "hands" });
  },
);

registerFunction(
  {
    id: "hand::metrics",
    description: "Get hand dashboard metrics",
    metadata: { category: "hand" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { handId } = req.body || req;
    const metrics = await trigger("state::get", {
      scope: "hand_metrics",
      key: handId,
    }).catch(() => ({}));

    const recentRuns = (await trigger("state::list", {
      scope: `hand_runs:${handId}`,
    }).catch(() => [])) as any[];

    const last10 = recentRuns
      .map((r: any) => r.value)
      .sort((a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, 10);

    return { metrics, recentRuns: last10 };
  },
);

registerTrigger({
  type: "http",
  function_id: "hand::register",
  config: { api_path: "api/hands", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "hand::list",
  config: { api_path: "api/hands", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "hand::execute",
  config: { api_path: "api/hands/run", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "hand::metrics",
  config: { api_path: "api/hands/:handId/metrics", http_method: "GET" },
});

function buildHandPrompt(hand: HandConfig): string {
  const now = new Date();
  return [
    `[${hand.name} — Autonomous Run — ${now.toISOString()}]`,
    "",
    "Review your current task queue and execute pending work.",
    `Available tools: ${hand.tools.join(", ")}`,
    "",
    Object.entries(hand.settings || {})
      .map(([k, v]) => `Setting ${k}: ${v}`)
      .join("\n"),
  ].join("\n");
}

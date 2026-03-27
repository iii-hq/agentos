import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createRecordMetric } from "./shared/metrics.js";
import { requireAuth, sanitizeId } from "./shared/utils.js";
import { safeCall } from "./shared/errors.js";
import type { FeedbackPolicy, ReviewResult } from "./types.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "feedback",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const log = new Logger();
const recordMetric = createRecordMetric(triggerVoid);

const MAX_IMPROVE_DEPTH = 3;

const DEFAULT_POLICY: FeedbackPolicy = {
  minScoreToKeep: 0.5,
  minEvalsToPromote: 5,
  maxFailuresToKill: 3,
  autoReviewIntervalMs: 6 * 60 * 60 * 1000,
};

type Decision = "keep" | "improve" | "promote" | "demote" | "kill";

function generateId(): string {
  return `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function numOrDefault<K extends keyof FeedbackPolicy>(
  stored: any,
  key: K,
): FeedbackPolicy[K] {
  return typeof stored?.[key] === "number" ? stored[key] : DEFAULT_POLICY[key];
}

async function getPolicy(): Promise<FeedbackPolicy> {
  const stored: any = await safeCall(
    () =>
      trigger({ function_id: "state::get", payload: { scope: "feedback_policy", key: "default" } }),
    null,
    { operation: "get_policy" },
  );
  if (!stored) return { ...DEFAULT_POLICY };
  return {
    minScoreToKeep: numOrDefault(stored, "minScoreToKeep"),
    minEvalsToPromote: numOrDefault(stored, "minEvalsToPromote"),
    maxFailuresToKill: numOrDefault(stored, "maxFailuresToKill"),
    autoReviewIntervalMs: numOrDefault(stored, "autoReviewIntervalMs"),
  };
}

async function getRecentEvals(
  functionId: string,
  limit: number,
): Promise<any[]> {
  const all: any[] = await safeCall(
    () => trigger({ function_id: "state::list", payload: { scope: "eval_results" } }),
    [],
    { operation: "recent_evals" },
  );

  return (Array.isArray(all) ? all : [])
    .map((e: any) => e.value || e)
    .filter((r: any) => r.functionId === functionId)
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
}

function nextPromotionReasonCode(status: string | undefined): ReviewResult["reasonCode"] {
  if (status === "draft") return "ready_for_staging";
  if (status === "staging") return "ready_for_shadow";
  if (status === "shadow") return "ready_for_canary";
  if (status === "canary") return "ready_for_production";
  return undefined;
}

function syncRolloutState(fn: any) {
  fn.metadata = {
    ...(fn.metadata || {}),
    rolloutState: fn.status,
  };
}

registerFunction(
  {
    id: "feedback::review",
    description: "Analyze evals and decide keep/improve/kill",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const policy = await getPolicy();
    const fn: any = await safeCall(
      () => trigger({ function_id: "state::get", payload: { scope: "evolved_functions", key: functionId } }),
      null,
      { operation: "review_function" },
    );
    const recent = await getRecentEvals(functionId, 5);

    if (recent.length === 0) {
      const result: ReviewResult = {
        decisionId: generateId(),
        functionId,
        decision: "keep",
        reason: "No eval data yet",
        reasonCode: "no_eval_data",
        avgOverall: 0,
        recentFailures: 0,
        evalCount: 0,
        timestamp: Date.now(),
      };
      await trigger({ function_id: "state::set", payload: {
        scope: "feedback_decisions",
        key: `${functionId}:${result.decisionId}`,
        value: result,
      } });
      return result;
    }

    const recentFailures = recent.filter(
      (r: any) =>
        r.scores?.correctness !== null && r.scores?.correctness < 0.5,
    ).length;

    const avgOverall =
      recent.reduce((s: number, r: any) => s + (r.scores?.overall || 0), 0) /
      recent.length;

    let decision: Decision;
    let reason: string;
    let reasonCode: ReviewResult["reasonCode"];

    if (recentFailures >= policy.maxFailuresToKill) {
      decision = "kill";
      reason = `${recentFailures} failures in last ${recent.length} evals (threshold: ${policy.maxFailuresToKill})`;
      reasonCode = "too_many_failures";
    } else if (avgOverall < policy.minScoreToKeep) {
      decision = "improve";
      reason = `Average overall score ${avgOverall.toFixed(3)} below threshold ${policy.minScoreToKeep}`;
      reasonCode = "avg_below_threshold";
    } else if (recent.length >= policy.minEvalsToPromote && nextPromotionReasonCode(fn?.status)) {
      decision = "promote";
      reasonCode = nextPromotionReasonCode(fn?.status);
      reason = `Ready to advance rollout from ${fn?.status ?? "unknown"}`;
    } else {
      decision = "keep";
      reason = `Passing: avg overall ${avgOverall.toFixed(3)}, ${recentFailures} failures`;
    }

    const result: ReviewResult = {
      decisionId: generateId(),
      functionId,
      decision,
      reason,
      reasonCode,
      avgOverall,
      recentFailures,
      evalCount: recent.length,
      timestamp: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "feedback_decisions",
      key: `${functionId}:${result.decisionId}`,
      value: result,
    } });

    if (decision === "kill") {
      const fnToKill: any = await safeCall(
        () =>
          trigger({ function_id: "state::get", payload: {
            scope: "evolved_functions",
            key: functionId,
          } }),
        null,
        { operation: "auto_kill_get" },
      );
      if (fnToKill) {
        fnToKill.status = "killed";
        syncRolloutState(fnToKill);
        fnToKill.updatedAt = Date.now();
        await trigger({ function_id: "state::set", payload: {
          scope: "evolved_functions",
          key: functionId,
          value: fnToKill,
        } });
      }
      log.warn("Auto-killed function", { functionId, reason });
    } else if (decision === "improve") {
      triggerVoid("feedback::improve", {
        headers: { authorization: "Bearer internal" },
        body: { functionId, depth: 0 },
        functionId,
        depth: 0,
      });
      log.info("Triggered improvement", { functionId, reason });
    }

    recordMetric(
      "feedback_review",
      1,
      { functionId, decision },
      "counter",
    );

    return result;
  },
);

registerFunction(
  {
    id: "feedback::history",
    description: "List stored review decisions for a function",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "feedback_decisions" } }),
      [],
      { operation: "feedback_history" },
    );

    return (Array.isArray(all) ? all : [])
      .map((entry: any) => entry.value || entry)
      .filter((decision: any) => decision.functionId === functionId)
      .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
  },
);

registerFunction(
  {
    id: "feedback::improve",
    description:
      "Call evolve::generate with eval feedback, re-eval. Auto-recurses up to 3x.",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, depth: rawDepth, suiteId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const depth = typeof rawDepth === "number" ? rawDepth : 0;
    if (depth >= MAX_IMPROVE_DEPTH) {
      log.warn("Max improve depth reached", { functionId, depth });
      return {
        improved: false,
        reason: `Max improvement depth ${MAX_IMPROVE_DEPTH} reached`,
        depth,
      };
    }

    const fn: any = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    const recentEvals = await getRecentEvals(functionId, 5);
    const failureDescriptions = recentEvals
      .filter(
        (r: any) =>
          r.scores?.correctness !== null && r.scores?.correctness < 0.5,
      )
      .map(
        (r: any) =>
          `Input: ${JSON.stringify(r.input)?.slice(0, 200)}, Expected: ${JSON.stringify(r.expected)?.slice(0, 200)}, Got: ${JSON.stringify(r.output)?.slice(0, 200)}`,
      )
      .slice(0, 3);

    const feedbackSpec = `Previous version failed on these cases:\n${failureDescriptions.join("\n")}\n\nPrevious code:\n${fn.code}\n\nFix the issues and improve correctness.`;

    const nameParts = fn.functionId.match(/^evolved::(.+)_v\d+$/);
    const baseName = nameParts ? nameParts[1] : fn.functionId.replace("evolved::", "");

    const newFn: any = await trigger({ function_id: "evolve::generate", payload: {
      headers: { authorization: "Bearer internal" },
      body: {
        goal: fn.description,
        spec: feedbackSpec,
        name: baseName,
        agentId: fn.authorAgentId,
        metadata: { ...fn.metadata, improvedFrom: functionId, depth: depth + 1 },
      },
      goal: fn.description,
      spec: feedbackSpec,
      name: baseName,
      agentId: fn.authorAgentId,
      metadata: { ...fn.metadata, improvedFrom: functionId, depth: depth + 1 },
    } });

    if (!newFn?.functionId) {
      return { improved: false, reason: "Generation failed", depth };
    }

    const policy = await getPolicy();
    let newScore = 0;
    if (suiteId) {
      await trigger({ function_id: "evolve::register", payload: {
        headers: { authorization: "Bearer internal" },
        body: { functionId: newFn.functionId },
        functionId: newFn.functionId,
      } });

      const suiteResult: any = await safeCall(
        () =>
          trigger({ function_id: "eval::suite", payload: {
            headers: { authorization: "Bearer internal" },
            body: { suiteId },
            suiteId,
          } }),
        null,
        { operation: "improve_eval" },
      );
      newScore = suiteResult?.aggregate?.correctness ?? 0;

      if (newScore < policy.minScoreToKeep && depth + 1 < MAX_IMPROVE_DEPTH) {
        log.info("Recursing improvement", {
          functionId: newFn.functionId,
          depth: depth + 1,
          score: newScore,
        });
        return trigger({ function_id: "feedback::improve", payload: {
          headers: { authorization: "Bearer internal" },
          body: {
            functionId: newFn.functionId,
            depth: depth + 1,
            suiteId,
          },
          functionId: newFn.functionId,
          depth: depth + 1,
          suiteId,
        } });
      }
    } else {
      await trigger({ function_id: "evolve::register", payload: {
        headers: { authorization: "Bearer internal" },
        body: { functionId: newFn.functionId },
        functionId: newFn.functionId,
      } });
    }

    recordMetric("feedback_improve", 1, { functionId, depth: String(depth) }, "counter");

    return {
      improved: true,
      newFunctionId: newFn.functionId,
      depth: depth + 1,
      score: newScore,
    };
  },
);

registerFunction(
  {
    id: "feedback::promote",
    description: "draft->staging or staging->production",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: any = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    if (fn.status === "killed" || fn.status === "deprecated") {
      throw Object.assign(
        new Error(`Cannot promote from ${fn.status}`),
        { statusCode: 400 },
      );
    }

    const policy = await getPolicy();
    const recentEvals = await getRecentEvals(functionId, 10);

    if (recentEvals.length < policy.minEvalsToPromote) {
      return {
        promoted: false,
        reason: `Need ${policy.minEvalsToPromote} evals, have ${recentEvals.length}`,
      };
    }

    const avgOverall =
      recentEvals.reduce(
        (s: number, r: any) => s + (r.scores?.overall || 0),
        0,
      ) / recentEvals.length;

    if (avgOverall < policy.minScoreToKeep) {
      return {
        promoted: false,
        reason: `Average score ${avgOverall.toFixed(3)} below threshold ${policy.minScoreToKeep}`,
      };
    }

    if (fn.status === "draft") {
      fn.status = "staging";
    } else if (fn.status === "staging") {
      fn.status = "shadow";
    } else if (fn.status === "shadow") {
      fn.status = "canary";
    } else if (fn.status === "canary") {
      const minSafety = Math.min(
        ...recentEvals.map((r: any) => r.scores?.safety ?? 1),
      );
      if (minSafety < 0.8) {
        return {
          promoted: false,
          reason: `Safety score ${minSafety.toFixed(3)} below 0.8 threshold for production`,
        };
      }
      fn.status = "production";
    } else if (fn.status === "production") {
      return { promoted: false, reason: "Already in production" };
    }

    syncRolloutState(fn);
    fn.updatedAt = Date.now();
    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    } });

    log.info("Promoted function", { functionId, status: fn.status });
    recordMetric("feedback_promote", 1, { functionId, status: fn.status }, "counter");

    return { promoted: true, functionId, newStatus: fn.status };
  },
);

registerFunction(
  {
    id: "feedback::demote",
    description: "Downgrade or kill",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, kill } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: any = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    if (kill) {
      fn.status = "killed";
    } else if (fn.status === "killed") {
      return { demoted: false, functionId, reason: "Already killed" };
    } else if (fn.status === "production") {
      fn.status = "canary";
    } else if (fn.status === "canary") {
      fn.status = "shadow";
    } else if (fn.status === "shadow") {
      fn.status = "staging";
    } else if (fn.status === "staging") {
      fn.status = "draft";
    } else {
      fn.status = "deprecated";
    }

    syncRolloutState(fn);
    fn.updatedAt = Date.now();
    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    } });

    log.info("Demoted function", { functionId, status: fn.status });
    return { demoted: true, functionId, newStatus: fn.status };
  },
);

registerFunction(
  {
    id: "feedback::leaderboard",
    description: "Rank evolved functions by score",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { status, limit: rawLimit } = req.query || req.body || req;

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "leaderboard" },
    );

    let functions = (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter((f: any) => f.status !== "killed");

    if (status) {
      functions = functions.filter((f: any) => f.status === status);
    }

    functions.sort(
      (a: any, b: any) =>
        (b.evalScores?.overall || 0) - (a.evalScores?.overall || 0),
    );

    const parsed = Number(rawLimit);
    const limit = Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : 50, 100));
    return functions.slice(0, limit).map((f: any, i: number) => ({
      rank: i + 1,
      functionId: f.functionId,
      description: f.description,
      status: f.status,
      version: f.version,
      overall: f.evalScores?.overall ?? null,
      correctness: f.evalScores?.correctness ?? null,
      safety: f.evalScores?.safety ?? null,
      authorAgentId: f.authorAgentId,
    }));
  },
);

registerFunction(
  {
    id: "feedback::policy",
    description: "Get/set threshold policy",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const body = req.body || req;

    const policyKeys: (keyof FeedbackPolicy)[] = [
      "minScoreToKeep",
      "minEvalsToPromote",
      "maxFailuresToKill",
      "autoReviewIntervalMs",
    ];
    const hasUpdate = policyKeys.some((k) => body[k] !== undefined);

    if (!hasUpdate) return getPolicy();

    const current = await getPolicy();
    const updated: FeedbackPolicy = { ...current };
    for (const k of policyKeys) {
      if (typeof body[k] === "number" && Number.isFinite(body[k])) {
        const v = body[k];
        if (k === "maxFailuresToKill" || k === "minEvalsToPromote") {
          if (!Number.isInteger(v) || v < 0) {
            throw Object.assign(
              new Error(`${k} must be a non-negative integer`),
              { statusCode: 400 },
            );
          }
        }
        if (k === "minScoreToKeep" && (v < 0 || v > 1)) {
          throw Object.assign(
            new Error("minScoreToKeep must be between 0 and 1"),
            { statusCode: 400 },
          );
        }
        if (k === "autoReviewIntervalMs" && v < 0) {
          throw Object.assign(
            new Error("autoReviewIntervalMs must be non-negative"),
            { statusCode: 400 },
          );
        }
        (updated as any)[k] = v;
      }
    }
    await trigger({ function_id: "state::set", payload: {
      scope: "feedback_policy",
      key: "default",
      value: updated,
    } });
    log.info("Updated feedback policy", updated as any);
    return updated;
  },
);

registerFunction(
  {
    id: "feedback::auto_review",
    description: "Auto-review all staging+production functions",
    metadata: { category: "feedback", cron: true },
  },
  async () => {
    const policy = await getPolicy();

    const lastRun: any = await safeCall(
      () =>
        trigger({ function_id: "state::get", payload: {
          scope: "feedback_policy",
          key: "auto_review_last_run",
        } }),
      null,
      { operation: "get_last_run" },
    );
    if (lastRun && Date.now() - lastRun < policy.autoReviewIntervalMs) {
      log.info("Auto-review skipped: within interval", {
        lastRun,
        intervalMs: policy.autoReviewIntervalMs,
      });
      return { reviewed: 0, skipped: true, results: [] };
    }

    await trigger({ function_id: "state::set", payload: {
      scope: "feedback_policy",
      key: "auto_review_last_run",
      value: Date.now(),
    } });

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "auto_review" },
    );

    const reviewable = (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter(
        (f: any) =>
          f.status === "staging"
          || f.status === "shadow"
          || f.status === "canary"
          || f.status === "production",
      );

    const results: ReviewResult[] = [];
    for (const fn of reviewable) {
      const result: any = await safeCall(
        () =>
          trigger({ function_id: "feedback::review", payload: {
            headers: { authorization: "Bearer internal" },
            body: { functionId: fn.functionId },
            functionId: fn.functionId,
          } }),
        null,
        { operation: "auto_review_single", functionId: fn.functionId },
      );
      if (result) results.push(result);
    }

    log.info(`Auto-review completed: ${results.length} functions reviewed`);
    recordMetric("feedback_auto_review", results.length, {}, "counter");

    return { reviewed: results.length, results };
  },
);

const VALID_SIGNAL_TYPES = [
  "ci_failure",
  "review_comment",
  "merge_conflict",
  "dependency_update",
  "custom",
] as const;
type SignalType = (typeof VALID_SIGNAL_TYPES)[number];

const SIGNAL_PREFIX_MAP: Record<SignalType, string> = {
  ci_failure: "[CI Failure]",
  review_comment: "[Review Comment]",
  merge_conflict: "[Merge Conflict]",
  dependency_update: "[Dependency Update]",
  custom: "[Signal]",
};

registerFunction(
  {
    id: "feedback::inject_signal",
    description: "Push external signal into agent context",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, content, signalType, metadata: signalMeta } = req.body || req;

    if (!agentId || typeof agentId !== "string") {
      throw Object.assign(new Error("agentId is required"), { statusCode: 400 });
    }
    if (!content || typeof content !== "string") {
      throw Object.assign(new Error("content is required"), { statusCode: 400 });
    }
    if (!signalType || !VALID_SIGNAL_TYPES.includes(signalType)) {
      throw Object.assign(
        new Error(`signalType must be one of: ${VALID_SIGNAL_TYPES.join(", ")}`),
        { statusCode: 400 },
      );
    }

    const sanitizedId = sanitizeId(agentId);

    const signalId = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signal = {
      id: signalId,
      agentId: sanitizedId,
      content,
      signalType,
      metadata: signalMeta || {},
      createdAt: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: `feedback_signals:${sanitizedId}`,
      key: signalId,
      value: signal,
    } });

    const prefix = SIGNAL_PREFIX_MAP[signalType as SignalType] || "[Signal]";
    triggerVoid("tool::agent_send", {
      targetAgentId: sanitizedId,
      message: `${prefix} ${content}`,
    });

    recordMetric("feedback_signal_injected", 1, { signalType }, "counter");
    log.info("Signal injected", { agentId: sanitizedId, signalType, signalId });

    return { signalId, injected: true };
  },
);

registerFunction(
  {
    id: "feedback::register_source",
    description: "Register an external signal source",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    const { name, type: sourceType, config: sourceConfig } = req.body || req;

    if (!name || typeof name !== "string") {
      throw Object.assign(new Error("name is required"), { statusCode: 400 });
    }
    if (!sourceType || typeof sourceType !== "string") {
      throw Object.assign(new Error("type is required"), { statusCode: 400 });
    }

    const sourceId = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const source = {
      id: sourceId,
      name,
      type: sourceType,
      config: sourceConfig || {},
      registeredAt: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "feedback_sources",
      key: sourceId,
      value: source,
    } });

    return { sourceId, registered: true };
  },
);

registerFunction(
  {
    id: "feedback::list_signals",
    description: "List recent signals for an agent sorted by createdAt desc",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    const { agentId, limit: rawLimit } = req.body || req;

    if (!agentId || typeof agentId !== "string") {
      throw Object.assign(new Error("agentId is required"), { statusCode: 400 });
    }

    const parsed = Number(rawLimit);
    const limit = Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 50, 200));

    const entries: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: `feedback_signals:${agentId}` } }),
      [],
      { agentId, operation: "list_signals" },
    );

    const signals = (Array.isArray(entries) ? entries : [])
      .map((e: any) => e.value || e)
      .filter((s: any) => s.createdAt)
      .sort((a: any, b: any) => b.createdAt - a.createdAt)
      .slice(0, limit);

    return { agentId, count: signals.length, signals };
  },
);

registerTrigger({
  type: "http",
  function_id: "feedback::inject_signal",
  config: { api_path: "api/feedback/inject-signal", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::list_signals",
  config: { api_path: "api/feedback/signals", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "feedback::review",
  config: { api_path: "api/feedback/review", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::improve",
  config: { api_path: "api/feedback/improve", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::promote",
  config: { api_path: "api/feedback/promote", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::demote",
  config: { api_path: "api/feedback/demote", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::leaderboard",
  config: { api_path: "api/feedback/leaderboard", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::policy",
  config: { api_path: "api/feedback/policy", http_method: "POST" },
});
registerTrigger({
  type: "cron",
  function_id: "feedback::auto_review",
  config: { interval: "6h" },
});

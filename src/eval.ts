import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createRecordMetric } from "./shared/metrics.js";
import { requireAuth } from "./shared/utils.js";
import { safeCall } from "./shared/errors.js";
import type { EvalScores, EvalResult, EvalSuite } from "./types.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "eval",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const log = new Logger();
const recordMetric = createRecordMetric(triggerVoid);

const SCORE_WEIGHTS = {
  correctness: 0.5,
  latency: 0.15,
  cost: 0.1,
  safety: 0.25,
};

function generateId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function latencyScore(ms: number): number {
  return Math.max(0, 1.0 - ms / 30000);
}

function costScore(tokens: number): number {
  return Math.max(0, 1.0 - tokens / 100000);
}

function computeOverall(scores: EvalScores): number {
  const correctnessVal = scores.correctness ?? 0;
  return (
    correctnessVal * SCORE_WEIGHTS.correctness +
    latencyScore(scores.latency_ms) * SCORE_WEIGHTS.latency +
    costScore(scores.cost_tokens) * SCORE_WEIGHTS.cost +
    scores.safety * SCORE_WEIGHTS.safety
  );
}

async function runSuiteAggregate(functionId: string, testCases: EvalSuite["testCases"]) {
  let totalCorrectness = 0;
  let totalWeight = 0;
  let totalLatency = 0;
  let totalCost = 0;
  let minSafety = 1.0;
  let passCount = 0;

  for (const tc of testCases) {
    const weight = tc.weight ?? 1;
    const start = performance.now();
    let output: unknown;
    try {
      output = await trigger({ function_id: functionId, payload: tc.input });
    } catch (err: any) {
      output = { error: err.message };
    }
    const latency_ms = Math.round(performance.now() - start);

    const scorerType = tc.scorer || "exact_match";
    const correctness =
      tc.expected !== undefined
        ? await scoreOutput(output, tc.expected, tc.input, scorerType, tc.scorerFunctionId)
        : null;
    const safety = await checkSafety(output);
    const scores: EvalScores = {
      correctness,
      latency_ms,
      cost_tokens: 0,
      safety,
      overall: 0,
    };
    scores.overall = computeOverall(scores);

    if (correctness !== null) {
      totalCorrectness += correctness * weight;
      totalWeight += weight;
      if (correctness >= 0.5) passCount++;
    }
    totalLatency += latency_ms;
    totalCost += scores.cost_tokens;
    if (safety < minSafety) minSafety = safety;
  }

  return {
    correctness: totalWeight > 0 ? totalCorrectness / totalWeight : null,
    latency_ms: testCases.length > 0 ? Math.round(totalLatency / testCases.length) : 0,
    cost_tokens: totalCost,
    safety: minSafety,
    passRate: testCases.length > 0 ? passCount / testCases.length : 0,
    testCount: testCases.length,
  };
}

function aggregateFromResults(results: EvalResult[], testCount: number) {
  let totalCorrectness = 0;
  let totalWeight = 0;
  let totalLatency = 0;
  let totalCost = 0;
  let minSafety = 1.0;
  let passCount = 0;

  for (const result of results) {
    totalLatency += result.scores.latency_ms;
    totalCost += result.scores.cost_tokens;
    minSafety = Math.min(minSafety, result.scores.safety);

    if (result.scores.correctness !== null) {
      totalCorrectness += result.scores.correctness;
      totalWeight += 1;
      if (result.scores.correctness >= 0.5) passCount++;
    }
  }

  return {
    correctness: totalWeight > 0 ? totalCorrectness / totalWeight : null,
    latency_ms: results.length > 0 ? Math.round(totalLatency / results.length) : 0,
    cost_tokens: totalCost,
    safety: results.length > 0 ? minSafety : 1.0,
    passRate: testCount > 0 ? passCount / testCount : 0,
    testCount,
  };
}

async function scoreExactMatch(
  output: unknown,
  expected: unknown,
): Promise<number> {
  try {
    return JSON.stringify(output) === JSON.stringify(expected) ? 1 : 0;
  } catch {
    return 0;
  }
}

async function scoreLlmJudge(
  output: unknown,
  expected: unknown,
  input: unknown,
): Promise<number> {
  const result: any = await safeCall(
    () =>
      trigger({ function_id: "llm::complete", payload: {
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          maxTokens: 256,
        },
        systemPrompt:
          "You are an eval judge. Score the output 0.0-1.0 for correctness. Respond with ONLY a number.",
        messages: [
          {
            role: "user",
            content: `Input: ${JSON.stringify(input)}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(output)}\n\nScore (0.0-1.0):`,
          },
        ],
      }}),
    null,
    { operation: "llm_judge" },
  );
  if (!result?.content) return 0;
  const parsed = parseFloat(result.content.trim());
  return isNaN(parsed) ? 0 : Math.max(0, Math.min(1, parsed));
}

async function scoreSemanticSimilarity(
  output: unknown,
  expected: unknown,
): Promise<number> {
  const outStr = typeof output === "string" ? output : JSON.stringify(output);
  const expStr =
    typeof expected === "string" ? expected : JSON.stringify(expected);
  return jaccardSimilarity(wordSet(outStr), wordSet(expStr));
}

const ALLOWED_SCORER_PREFIXES = ["evolved::", "eval::", "tool::"];

async function scoreCustom(
  output: unknown,
  expected: unknown,
  input: unknown,
  scorerFunctionId: string,
): Promise<number> {
  if (!ALLOWED_SCORER_PREFIXES.some((p) => scorerFunctionId.startsWith(p))) {
    throw new Error(
      `Custom scorer must use ${ALLOWED_SCORER_PREFIXES.join(", ")} prefixes, got: ${scorerFunctionId}`,
    );
  }
  const result: any = await safeCall(
    () => trigger({ function_id: scorerFunctionId, payload: { output, expected, input } }),
    null,
    { operation: "custom_scorer" },
  );
  if (typeof result === "number") return Math.max(0, Math.min(1, result));
  if (typeof result?.score === "number")
    return Math.max(0, Math.min(1, result.score));
  return 0;
}

async function scoreOutput(
  output: unknown,
  expected: unknown,
  input: unknown,
  scorer: string,
  scorerFunctionId?: string,
): Promise<number> {
  switch (scorer) {
    case "exact_match":
      return scoreExactMatch(output, expected);
    case "llm_judge":
      return scoreLlmJudge(output, expected, input);
    case "semantic_similarity":
      return scoreSemanticSimilarity(output, expected);
    case "custom":
      if (!scorerFunctionId)
        throw new Error("scorerFunctionId required for custom scorer");
      return scoreCustom(output, expected, input, scorerFunctionId);
    default:
      return scoreExactMatch(output, expected);
  }
}

async function checkSafety(output: unknown): Promise<number> {
  const content =
    typeof output === "string" ? output : JSON.stringify(output);
  const result: any = await safeCall(
    () => trigger({ function_id: "security::scan_injection", payload: { content } }),
    null,
    { operation: "safety_scan" },
  );
  if (result === null) {
    log.warn("Safety scanner unavailable, failing closed");
    return 0;
  }
  return result?.safe === false ? 0 : 1.0;
}

registerFunction(
  {
    id: "eval::run",
    description: "Invoke function, measure latency/cost, score output",
    metadata: { category: "eval" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, input, expected, scorer, scorerFunctionId } =
      req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const start = performance.now();
    const output = await trigger({ function_id: functionId, payload: input });
    const latency_ms = Math.round(performance.now() - start);

    const scorerType = scorer || "exact_match";
    const correctness =
      expected !== undefined
        ? await scoreOutput(output, expected, input, scorerType, scorerFunctionId)
        : null;
    const safety = await checkSafety(output);

    const scores: EvalScores = {
      correctness,
      latency_ms,
      cost_tokens: 0,
      safety,
      overall: 0,
    };
    scores.overall = computeOverall(scores);

    const evalId = generateId();
    const result: EvalResult = {
      evalId,
      functionId,
      scores,
      scorerType,
      input,
      output,
      expected,
      timestamp: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "eval_results",
      key: `${functionId}:${evalId}`,
      value: result,
    } });

    const fn: any = await safeCall(
      () =>
        trigger({ function_id: "state::get", payload: { scope: "evolved_functions", key: functionId } }),
      null,
      { operation: "update_eval_scores" },
    );
    if (fn) {
      fn.evalScores = scores;
      fn.updatedAt = Date.now();
      await trigger({ function_id: "state::set", payload: {
        scope: "evolved_functions",
        key: functionId,
        value: fn,
      } });
    }

    recordMetric("eval_run", 1, { functionId }, "counter");
    log.info("Eval run completed", { functionId, overall: scores.overall });

    return result;
  },
);

registerFunction(
  {
    id: "eval::score_inline",
    description:
      "Auto-called by evolved function wrapper. Lightweight scoring.",
    metadata: { category: "eval", internal: true },
  },
  async (data: {
    functionId: string;
    input: unknown;
    output: unknown;
    latencyMs: number;
    costTokens: number;
  }) => {
    const safety = await checkSafety(data.output);

    const scores: EvalScores = {
      correctness: null,
      latency_ms: data.latencyMs,
      cost_tokens: data.costTokens,
      safety,
      overall: 0,
    };
    scores.overall = computeOverall(scores);

    const evalId = generateId();
    const result: EvalResult = {
      evalId,
      functionId: data.functionId,
      scores,
      scorerType: "inline",
      input: data.input,
      output: data.output,
      timestamp: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "eval_results",
      key: `${data.functionId}:${evalId}`,
      value: result,
    } });

    triggerVoid("eval::inline_recorded", {
      functionId: data.functionId,
      scores,
    });

    return result;
  },
);

registerFunction(
  {
    id: "eval::suite",
    description: "Run all test cases in a suite, aggregate scores",
    metadata: { category: "eval" },
  },
  async (req: any) => {
    requireAuth(req);
    const { suiteId } = req.body || req;
    if (!suiteId) {
      throw Object.assign(new Error("suiteId is required"), {
        statusCode: 400,
      });
    }

    const suite: EvalSuite | null = await trigger({ function_id: "state::get", payload: {
      scope: "eval_suites",
      key: suiteId,
    } });
    if (!suite) {
      throw Object.assign(new Error("Suite not found"), { statusCode: 404 });
    }

    const results: EvalResult[] = [];

    for (const tc of suite.testCases) {
      const weight = tc.weight ?? 1;
      const start = performance.now();
      let output: unknown;
      try {
        output = await trigger({ function_id: suite.functionId, payload: tc.input });
      } catch (err: any) {
        output = { error: err.message };
      }
      const latency_ms = Math.round(performance.now() - start);

      const scorerType = tc.scorer || "exact_match";
      const correctness =
        tc.expected !== undefined
          ? await scoreOutput(
              output,
              tc.expected,
              tc.input,
              scorerType,
              tc.scorerFunctionId,
            )
          : null;
      const safety = await checkSafety(output);

      const scores: EvalScores = {
        correctness,
        latency_ms,
        cost_tokens: 0,
        safety,
        overall: 0,
      };
      scores.overall = computeOverall(scores);

      const evalId = generateId();
      const result: EvalResult = {
        evalId,
        functionId: suite.functionId,
        scores,
        scorerType,
        input: tc.input,
        output,
        expected: tc.expected,
        timestamp: Date.now(),
      };
      results.push(result);

      await trigger({ function_id: "state::set", payload: {
        scope: "eval_results",
        key: `${suite.functionId}:${evalId}`,
        value: result,
      } });
    }

    const aggregate = aggregateFromResults(results, suite.testCases.length);
    const suiteMeta = suite.metadata ?? {};
    const baselineAggregate = suiteMeta.baselineFunctionId
      ? await runSuiteAggregate(suiteMeta.baselineFunctionId, suite.testCases)
      : null;

    recordMetric(
      "eval_suite_run",
      1,
      { suiteId, functionId: suite.functionId },
      "counter",
    );
    log.info("Eval suite completed", {
      suiteId,
      functionId: suite.functionId,
    });

    return {
      suiteId,
      functionId: suite.functionId,
      aggregate,
      metadata: {
        candidateClass: suiteMeta.candidateClass ?? null,
        baselineFunctionId: suiteMeta.baselineFunctionId ?? null,
        baselineAggregate,
      },
      results,
    };
  },
);

registerFunction(
  {
    id: "eval::history",
    description: "Eval results for a function",
    metadata: { category: "eval" },
  },
  async (req: any) => {
    requireAuth(req);
    const functionId = req.params?.functionId || req.functionId;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "eval_results" } }),
      [],
      { operation: "eval_history" },
    );

    return (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter((r: any) => r.functionId === functionId)
      .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
  },
);

registerFunction(
  {
    id: "eval::compare",
    description: "Side-by-side comparison of two function versions",
    metadata: { category: "eval" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionIdA, functionIdB, testCases } = req.body || req;
    if (!functionIdA || !functionIdB || !testCases?.length) {
      throw Object.assign(
        new Error("functionIdA, functionIdB, and testCases are required"),
        { statusCode: 400 },
      );
    }

    async function evalOne(fnId: string, tc: any, label: string): Promise<EvalScores> {
      const scorer = tc.scorer || "exact_match";
      const start = performance.now();
      const output = await safeCall(
        () => trigger({ function_id: fnId, payload: tc.input }),
        { error: "failed" },
        { operation: `compare_${label}` },
      );
      const latency_ms = Math.round(performance.now() - start);
      const correctness =
        tc.expected !== undefined
          ? await scoreOutput(output, tc.expected, tc.input, scorer)
          : null;
      const safety = await checkSafety(output);
      const scores: EvalScores = { correctness, latency_ms, cost_tokens: 0, safety, overall: 0 };
      scores.overall = computeOverall(scores);
      return scores;
    }

    const resultsA: EvalScores[] = [];
    const resultsB: EvalScores[] = [];
    for (const tc of testCases) {
      resultsA.push(await evalOne(functionIdA, tc, "a"));
      resultsB.push(await evalOne(functionIdB, tc, "b"));
    }

    const avgOverall = (arr: EvalScores[]) =>
      arr.length > 0
        ? arr.reduce((s, r) => s + r.overall, 0) / arr.length
        : 0;

    return {
      functionIdA,
      functionIdB,
      avgOverallA: avgOverall(resultsA),
      avgOverallB: avgOverall(resultsB),
      winner:
        avgOverall(resultsA) >= avgOverall(resultsB)
          ? functionIdA
          : functionIdB,
      detailsA: resultsA,
      detailsB: resultsB,
    };
  },
);

registerFunction(
  {
    id: "eval::create_suite",
    description: "Create a reusable eval suite",
    metadata: { category: "eval" },
  },
  async (req: any) => {
    requireAuth(req);
    const { name, functionId, testCases, suiteId: customId, metadata } =
      req.body || req;
    if (!name || !functionId || !testCases?.length) {
      throw Object.assign(
        new Error("name, functionId, and testCases are required"),
        { statusCode: 400 },
      );
    }

    const suiteId = customId || `suite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const suite: EvalSuite = {
      suiteId,
      name,
      functionId,
      metadata,
      testCases,
      createdAt: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "eval_suites",
      key: suiteId,
      value: suite,
    } });

    log.info("Created eval suite", { suiteId, functionId });
    return suite;
  },
);

registerTrigger({
  type: "http",
  function_id: "eval::run",
  config: { api_path: "api/eval/run", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "eval::suite",
  config: { api_path: "api/eval/suite", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "eval::history",
  config: { api_path: "api/eval/history/:functionId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "eval::compare",
  config: { api_path: "api/eval/compare", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "eval::create_suite",
  config: { api_path: "api/eval/suites", http_method: "POST" },
});

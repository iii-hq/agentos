import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createRecordMetric } from "./shared/metrics.js";
import { requireAuth, sanitizeId } from "./shared/utils.js";
import { safeCall } from "./shared/errors.js";
import type { EvolvedFunction } from "./types.js";
import * as vm from "node:vm";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "evolve",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const log = new Logger();
const recordMetric = createRecordMetric(triggerVoid);

const MAX_OUTPUT_LENGTH = 100_000;
const SANDBOX_TIMEOUT_MS = 10_000;
const ALLOWED_TRIGGER_PREFIXES = ["evolved::", "tool::", "llm::"];

interface LiveHandle {
  unregister: () => void;
}

const liveHandles = new Map<string, LiveHandle>();

function syncRolloutState(fn: EvolvedFunction) {
  fn.metadata = {
    ...fn.metadata,
    rolloutState: fn.status,
  };
}

function truncateResult(value: unknown): unknown {
  try {
    const str = JSON.stringify(value);
    if (!str || str.length <= MAX_OUTPUT_LENGTH) return value;
    return { truncated: true, preview: str.slice(0, MAX_OUTPUT_LENGTH) };
  } catch {
    return { truncated: true, preview: String(value).slice(0, 1000) };
  }
}

function createSandboxContext(functionId: string) {
  const sandboxTrigger = async (fnId: string, data: unknown) => {
    if (!ALLOWED_TRIGGER_PREFIXES.some((p) => fnId.startsWith(p))) {
      throw new Error(
        `Evolved function cannot call ${fnId}: only ${ALLOWED_TRIGGER_PREFIXES.join(", ")} prefixes allowed`,
      );
    }
    return trigger({ function_id: fnId, payload: data });
  };

  const ctx = vm.createContext(
    {
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      trigger: sandboxTrigger,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      fetch: undefined,
      setTimeout: undefined,
      setInterval: undefined,
      process: undefined,
      require: undefined,
      import: undefined,
      eval: undefined,
      Function: undefined,
      fs: undefined,
    },
    {
      codeGeneration: { strings: false, wasm: false },
    },
  );

  const hardenScript = new vm.Script(`
    (function() {
      var F = Object.getPrototypeOf(function(){}).constructor;
      Object.defineProperty(F.prototype, 'constructor', {
        get: function() { throw new Error('Sandbox: constructor access denied'); },
        configurable: false
      });
    })();
  `);
  hardenScript.runInContext(ctx);

  return ctx;
}

async function executeInSandbox(
  code: string,
  input: unknown,
  functionId: string,
): Promise<unknown> {
  const ctx = createSandboxContext(functionId);
  ctx.input = input;
  const script = new vm.Script(`(${code})(input)`, {
    filename: `evolved-${functionId}.js`,
  });
  const result = script.runInContext(ctx, {
    timeout: SANDBOX_TIMEOUT_MS,
    breakOnSigint: true,
  });
  let resolved: unknown;
  if (result instanceof Promise) {
    let timer: ReturnType<typeof setTimeout>;
    try {
      resolved = await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Async execution timeout")),
            SANDBOX_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  } else {
    resolved = result;
  }
  return truncateResult(resolved);
}

function registerLiveFunction(fn: EvolvedFunction) {
  const existing = liveHandles.get(fn.functionId);
  if (existing) {
    existing.unregister();
    liveHandles.delete(fn.functionId);
  }

  const handle = registerFunction(
    {
      id: fn.functionId,
      description: fn.description,
      metadata: { category: "evolved", authorAgentId: fn.authorAgentId },
    },
    async (input: unknown) => {
      const start = performance.now();
      const result = await executeInSandbox(fn.code, input, fn.functionId);
      const latencyMs = Math.round(performance.now() - start);

      const evalMode =
        (fn.metadata?.evalMode as string | undefined) || "auto";
      const shouldEval =
        evalMode === "auto" ||
        (evalMode === "sampled" && Math.random() < 0.1);
      if (shouldEval) {
        triggerVoid("eval::score_inline", {
          functionId: fn.functionId,
          input,
          output: result,
          latencyMs,
          costTokens: 0,
        });
      }

      recordMetric(
        "evolved_function_call",
        1,
        { functionId: fn.functionId },
        "counter",
      );
      recordMetric(
        "evolved_function_latency",
        latencyMs,
        { functionId: fn.functionId },
        "histogram",
      );

      return result;
    },
  );

  liveHandles.set(fn.functionId, { unregister: handle?.unregister || (() => {}) });
}

registerFunction(
  {
    id: "evolve::generate",
    description: "LLM writes function code from a goal/spec",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { goal, spec, name, agentId, metadata: extraMeta } = req.body || req;
    if (!goal || !name || !agentId) {
      throw Object.assign(
        new Error("goal, name, and agentId are required"),
        { statusCode: 400 },
      );
    }

    const safeName = sanitizeId(name);
    const existing: any[] = await safeCall(
      () =>
        trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "list_evolved" },
    );

    const sameNameEntries = (Array.isArray(existing) ? existing : []).filter(
      (e: any) => {
        const fn = e.value || e;
        return (
          typeof fn.functionId === "string" &&
          fn.functionId.startsWith(`evolved::${safeName}_v`)
        );
      },
    );
    const maxVersion = sameNameEntries.reduce((max: number, e: any) => {
      const fn = e.value || e;
      const match = fn.functionId.match(/_v(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextVersion = maxVersion + 1;
    const functionId = `evolved::${safeName}_v${nextVersion}`;

    const prompt = `Write a JavaScript function that accomplishes the following goal. Return ONLY the function body as an arrow function expression. Do not include markdown, explanations, or code fences.

Goal: ${goal}
${spec ? `Spec: ${spec}` : ""}

The function receives a single \`input\` parameter (any type) and must return a result.
It has access to: JSON, Math, Date, Array, Object, String, Number, Boolean, Map, Set, Promise, parseInt, parseFloat.
It can call \`await trigger({ function_id: fnId, payload: data })\` to invoke other functions (only evolved::, tool::, llm:: prefixes).
It CANNOT use: fetch, fs, process, require, setTimeout, eval, Function constructor.

Example: async (input) => { return { result: input.value * 2 }; }`;

    const llmResult: any = await trigger({ function_id: "llm::complete", payload: {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        maxTokens: 2048,
      },
      systemPrompt:
        "You are a code generator. Output only a single JavaScript arrow function expression. No markdown, no explanation.",
      messages: [{ role: "user", content: prompt }],
    }});

    let code = (llmResult?.content || "").trim();
    code = code.replace(/^```(?:javascript|js|typescript|ts)?\n?/g, "");
    code = code.replace(/```$/g, "");
    code = code.trim();

    const parentVersion =
      nextVersion > 1
        ? `evolved::${safeName}_v${nextVersion - 1}`
        : undefined;

    const record: EvolvedFunction = {
      functionId,
      code,
      description: goal,
      authorAgentId: agentId,
      version: nextVersion,
      status: "draft",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      evalScores: null,
      securityReport: { scanSafe: false, sandboxPassed: false, findingCount: 0 },
      parentVersion,
      metadata: {
        rolloutState: "draft",
        ...(extraMeta || {}),
      },
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: record,
    } });

    log.info("Generated evolved function", { functionId, agentId });
    recordMetric("evolved_function_generated", 1, { agentId }, "counter");

    return record;
  },
);

registerFunction(
  {
    id: "evolve::register",
    description:
      "Security scan + sandbox validation + register on iii bus",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: EvolvedFunction | null = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }
    if (fn.status === "killed") {
      throw Object.assign(new Error("Cannot register a killed function"), {
        statusCode: 400,
      });
    }

    const pipelineResult: any = await trigger({ function_id: "skill::pipeline", payload: {
      content: fn.code,
    } });

    const scanSafe = pipelineResult?.approved === true;
    const sandboxPassed = pipelineResult?.report?.sandbox?.passed === true;
    const findingCount =
      pipelineResult?.report?.scan?.findings?.length || 0;

    fn.securityReport = { scanSafe, sandboxPassed, findingCount };

    if (!scanSafe) {
      fn.status = "killed";
      syncRolloutState(fn);
      fn.updatedAt = Date.now();
      await trigger({ function_id: "state::set", payload: {
        scope: "evolved_functions",
        key: functionId,
        value: fn,
      } });
      triggerVoid("security::audit", {
        type: "evolved_function_rejected",
        detail: { functionId, reason: "security_scan_failed", findingCount },
      });
      return {
        registered: false,
        reason: "Security scan failed",
        securityReport: fn.securityReport,
      };
    }

    try {
      await executeInSandbox(fn.code, { __test: true }, functionId);
    } catch (err: any) {
      fn.securityReport.sandboxPassed = false;
      fn.status = "killed";
      syncRolloutState(fn);
      fn.updatedAt = Date.now();
      await trigger({ function_id: "state::set", payload: {
        scope: "evolved_functions",
        key: functionId,
        value: fn,
      } });
      return {
        registered: false,
        reason: `Sandbox validation failed: ${err.message}`,
        securityReport: fn.securityReport,
      };
    }

    fn.securityReport.sandboxPassed = true;
    fn.status = "staging";
    syncRolloutState(fn);
    fn.updatedAt = Date.now();
    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    } });

    registerLiveFunction(fn);

    log.info("Registered evolved function", { functionId });
    recordMetric("evolved_function_registered", 1, { functionId }, "counter");
    triggerVoid("security::audit", {
      type: "evolved_function_registered",
      detail: { functionId, securityReport: fn.securityReport },
    });

    return {
      registered: true,
      functionId,
      securityReport: fn.securityReport,
    };
  },
);

registerFunction(
  {
    id: "evolve::unregister",
    description: "Remove dynamic function, mark as killed",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, agentId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: EvolvedFunction | null = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }
    if (fn.authorAgentId !== agentId) {
      throw Object.assign(
        new Error("Only the author agent can unregister"),
        { statusCode: 403 },
      );
    }

    const handle = liveHandles.get(functionId);
    if (handle) {
      handle.unregister();
      liveHandles.delete(functionId);
    }

    fn.status = "killed";
    syncRolloutState(fn);
    fn.updatedAt = Date.now();
    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    } });

    log.info("Unregistered evolved function", { functionId });
    return { unregistered: true, functionId };
  },
);

registerFunction(
  {
    id: "evolve::list",
    description: "List all evolved functions (filter by status/agent)",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { status, agentId } =
      req.query || req.body || req;

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "list_evolved" },
    );

    let functions = (Array.isArray(all) ? all : []).map(
      (e: any) => e.value || e,
    );

    if (status) {
      functions = functions.filter((f: any) => f.status === status);
    }
    if (agentId) {
      functions = functions.filter((f: any) => f.authorAgentId === agentId);
    }

    return functions;
  },
);

registerFunction(
  {
    id: "evolve::get",
    description: "Get source code + metadata + eval scores",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const functionId = req.params?.functionId || req.functionId;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: EvolvedFunction | null = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: functionId,
    } });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    return fn;
  },
);

registerFunction(
  {
    id: "evolve::fork",
    description: "Branch from any version to create a new exploration path",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { sourceId, goal, agentId, metadata: extraMeta } = req.body || req;
    if (!sourceId || !goal || !agentId) {
      throw Object.assign(
        new Error("sourceId, goal, and agentId are required"),
        { statusCode: 400 },
      );
    }

    const source: EvolvedFunction | null = await trigger({ function_id: "state::get", payload: {
      scope: "evolved_functions",
      key: sourceId,
    } });
    if (!source) {
      throw Object.assign(new Error("Source function not found"), {
        statusCode: 404,
      });
    }

    const baseName = source.functionId
      .replace(/_v\d+$/, "")
      .replace("evolved::", "");
    const safeName = sanitizeId(baseName);

    const existing: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "list_evolved" },
    );

    const sameNameEntries = (Array.isArray(existing) ? existing : []).filter(
      (e: any) => {
        const fn = e.value || e;
        return (
          typeof fn.functionId === "string" &&
          fn.functionId.startsWith(`evolved::${safeName}_v`)
        );
      },
    );
    const maxVersion = sameNameEntries.reduce((max: number, e: any) => {
      const fn = e.value || e;
      const match = fn.functionId.match(/_v(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextVersion = maxVersion + 1;
    const functionId = `evolved::${safeName}_v${nextVersion}`;

    const prompt = `Improve the following JavaScript function based on the goal below. Return ONLY the function body as an arrow function expression. Do not include markdown, explanations, or code fences.

Current code:
${source.code}

Current description: ${source.description}

Improvement goal: ${goal}

The function receives a single \`input\` parameter and must return a result.
It has access to: JSON, Math, Date, Array, Object, String, Number, Boolean, Map, Set, Promise.
It can call \`await trigger({ function_id: fnId, payload: data })\` for evolved::, tool::, llm:: prefixes.`;

    const llmResult: any = await trigger({ function_id: "llm::complete", payload: {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        maxTokens: 2048,
      },
      systemPrompt:
        "You are a code generator. Output only a single JavaScript arrow function expression. No markdown, no explanation.",
      messages: [{ role: "user", content: prompt }],
    }});

    let code = (llmResult?.content || "").trim();
    code = code.replace(/^```(?:javascript|js|typescript|ts)?\n?/g, "");
    code = code.replace(/```$/g, "");
    code = code.trim();

    const record: EvolvedFunction = {
      functionId,
      code,
      description: `${source.description} (fork: ${goal})`,
      authorAgentId: agentId,
      version: nextVersion,
      status: "draft",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      evalScores: null,
      securityReport: { scanSafe: false, sandboxPassed: false, findingCount: 0 },
      parentVersion: sourceId,
      metadata: { ...(extraMeta || {}), forkedFrom: sourceId },
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "evolved_functions",
      key: functionId,
      value: record,
    } });

    log.info("Forked evolved function", { functionId, sourceId, agentId });
    recordMetric("evolved_function_forked", 1, { agentId }, "counter");

    return record;
  },
);

registerFunction(
  {
    id: "evolve::leaves",
    description: "Find frontier versions with no children",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { name, status } = req.body || req.query || req;

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
      [],
      { operation: "list_evolved_leaves" },
    );

    let functions = (Array.isArray(all) ? all : []).map(
      (e: any) => e.value || e,
    );

    if (name) {
      const safeName = sanitizeId(name);
      functions = functions.filter(
        (f: any) =>
          typeof f.functionId === "string" &&
          f.functionId.startsWith(`evolved::${safeName}_v`),
      );
    }

    if (status) {
      functions = functions.filter((f: any) => f.status === status);
    }

    const childParents = new Set(
      functions
        .map((f: any) => f.parentVersion)
        .filter(Boolean),
    );

    const leaves = functions.filter(
      (f: any) => !childParents.has(f.functionId) && f.status !== "killed",
    );

    return leaves.map((f: any) => ({
      functionId: f.functionId,
      version: f.version,
      status: f.status,
      parentVersion: f.parentVersion,
      description: f.description,
      evalScores: f.evalScores,
    }));
  },
);

registerFunction(
  {
    id: "evolve::lineage",
    description: "Trace ancestry from a version back to root",
    metadata: { category: "evolve" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req.query || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }
    const safeFunctionId = sanitizeId(functionId);

    const lineage: Array<{
      functionId: string;
      version: number;
      status: string;
      parentVersion?: string;
      description: string;
      evalScores: unknown;
    }> = [];

    let currentId: string | undefined = safeFunctionId;
    const visited = new Set<string>();
    const MAX_DEPTH = 100;

    while (currentId && !visited.has(currentId) && lineage.length < MAX_DEPTH) {
      visited.add(currentId);
      const fn: EvolvedFunction | null = await trigger({ function_id: "state::get", payload: {
        scope: "evolved_functions",
        key: currentId,
      } });
      if (!fn) break;

      lineage.push({
        functionId: fn.functionId,
        version: fn.version,
        status: fn.status,
        parentVersion: fn.parentVersion,
        description: fn.description,
        evalScores: fn.evalScores,
      });
      currentId = fn.parentVersion;
    }

    return { functionId: safeFunctionId, depth: lineage.length, lineage };
  },
);

async function reloadEvolvedFunctions() {
  const all: any[] = await safeCall(
    () => trigger({ function_id: "state::list", payload: { scope: "evolved_functions" } }),
    [],
    { operation: "reload_evolved" },
  );

  let count = 0;
  for (const entry of Array.isArray(all) ? all : []) {
    const fn: EvolvedFunction = entry.value || entry;
    if (
      fn.status === "killed" ||
      fn.status === "deprecated" ||
      fn.status === "draft"
    ) {
      continue;
    }
    if (!fn.securityReport?.scanSafe || !fn.securityReport?.sandboxPassed) {
      continue;
    }
    try {
      registerLiveFunction(fn);
      count++;
    } catch (err: any) {
      log.warn("Failed to reload evolved function", {
        functionId: fn.functionId,
      });
    }
  }
  if (count > 0) {
    log.info(`Reloaded ${count} evolved functions`);
  }
}

if (process.env.NODE_ENV !== "test" && typeof globalThis.vitest === "undefined") {
  setTimeout(() => {
    reloadEvolvedFunctions().catch(() => {});
  }, 2000);
}

registerTrigger({
  type: "http",
  function_id: "evolve::generate",
  config: { api_path: "api/evolve/generate", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::register",
  config: { api_path: "api/evolve/register", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::unregister",
  config: { api_path: "api/evolve/unregister", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::list",
  config: { api_path: "api/evolve", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::get",
  config: { api_path: "api/evolve/:functionId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::fork",
  config: { api_path: "api/evolve/fork", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::leaves",
  config: { api_path: "api/evolve/leaves", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "evolve::lineage",
  config: { api_path: "api/evolve/lineage", http_method: "GET" },
});

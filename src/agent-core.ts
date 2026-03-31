import { createHash } from "crypto";
import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  Division,
  ToolCall,
} from "./types.js";
import { filterToolsByProfile } from "./tool-profiles.js";
import { safeCall } from "./shared/errors.js";
import { shutdownManager } from "./shared/shutdown.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";

const log = createLogger("agent-core");

const sdk = registerWorker(ENGINE_URL, {
  workerName: "agent-core",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, listFunctions } = sdk;
const trigger = (id: string, payload: unknown, timeoutMs?: number) =>
  sdk.trigger(
    timeoutMs !== undefined
      ? { function_id: id, payload, timeoutMs }
      : { function_id: id, payload },
  );
const triggerVoid = (id: string, payload: unknown) =>
  sdk.trigger({ function_id: id, payload, action: TriggerAction.Void() });

const MAX_ITERATIONS = 50;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_CHAT_TIMEOUT_MS = 300_000;
const CONTEXT_HEALTH_CHECK_INTERVAL = 10;
const CONTEXT_HEALTH_THRESHOLD = 60;

function earlyResponse(content: string): ChatResponse {
  return { content, model: undefined, usage: undefined, iterations: 0 };
}

type TriggerFn = typeof trigger;
type TriggerVoidFn = typeof triggerVoid;

async function validateRequest(
  input: ChatRequest,
  triggerFn: TriggerFn,
): Promise<ChatResponse | null> {
  if (shutdownManager.isShuttingDown()) {
    return earlyResponse("Service is shutting down. Please retry later.");
  }

  if (
    !input.agentId ||
    typeof input.agentId !== "string" ||
    input.agentId.trim() === ""
  ) {
    return earlyResponse("Missing or invalid agentId.");
  }

  const { agentId } = input;

  const agentRate: any = await safeCall(
    () => triggerFn("rate::check_agent", { agentId, operation: "message" }, 10_000),
    { allowed: false, retryAfter: 60 },
    { agentId, operation: "rate_check_agent" },
  );
  if (!agentRate.allowed) {
    return earlyResponse(
      `Rate limit exceeded for agent ${agentId}. Retry after ${agentRate.retryAfter}s.`,
    );
  }

  const concSlot: any = await safeCall(
    () => triggerFn("rate::acquire_concurrent", { agentId }, 10_000),
    { acquired: false, current: 0, limit: 0 },
    { agentId, operation: "acquire_concurrent" },
  );
  if (!concSlot.acquired) {
    return earlyResponse(
      `Agent ${agentId} has too many concurrent requests (${concSlot.current}/${concSlot.limit}).`,
    );
  }

  return null;
}

interface PreparedContext {
  config: AgentConfig;
  model: any;
  messages: any[];
  tools: any;
  allowedToolIds: Set<string>;
  replaySessionId: string;
  profilePrompt: string;
}

async function prepareContext(
  agentId: string,
  message: string,
  sessionId: string | undefined,
  triggerFn: TriggerFn,
): Promise<PreparedContext | ChatResponse> {
  const config: AgentConfig = await triggerFn("state::get", {
    scope: "agents",
    key: agentId,
  }, 10_000);

  if (!config) {
    return earlyResponse(`Agent ${agentId} not found.`);
  }

  const recallHash = createHash("sha256").update(message).digest("hex").slice(0, 16);
  const memories: any = await triggerFn("context_cache::get_or_fetch", {
    agentId,
    key: `recall:${recallHash}`,
    fetchFunctionId: "memory::recall",
    fetchPayload: { agentId, query: message, limit: 20 },
    ttlMs: 30_000,
  }, 30_000);

  const userProfile: any = await safeCall(
    () => triggerFn("context_cache::get_or_fetch", {
      agentId,
      key: "user_profile",
      fetchFunctionId: "memory::user_profile::get",
      fetchPayload: { agentId },
      ttlMs: 60_000,
    }, 5_000),
    null,
    { agentId, operation: "get_user_profile" },
  );

  const tools: any = await triggerFn("agent::list_tools", { agentId }, 10_000);
  const allowedToolIds = new Set<string>(
    tools.map((t: any) => t.function_id || t.id),
  );

  const model = await triggerFn("llm::route", {
    message,
    toolCount: tools.length,
    config: config?.model,
    agentTier: config?.agentTier,
  }, 10_000);

  let profilePrompt = "";
  if (userProfile) {
    const profileSummary = Object.entries(userProfile)
      .filter(([k, v]) => k !== "updatedAt" && v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n")
      .slice(0, 2000);
    if (profileSummary) {
      profilePrompt = `\n\n[User Profile]\n${profileSummary}`;
    }
  }

  const messages: any[] = [];
  messages.push(...(memories || []));
  messages.push({ role: "user", content: message });

  const injectionScan: any = await safeCall(
    () => triggerFn("security::scan_injection", { text: message }, 10_000),
    { riskScore: 1.0, safe: false },
    { agentId, operation: "scan_injection" },
  );
  if (injectionScan.riskScore > 0.5) {
    return earlyResponse("Message rejected: potential injection detected.");
  }

  const budgetStatus: any = await safeCall(
    () => triggerFn("cost::budget_check", { agentId }, 10_000),
    { withinBudget: false, spent: 0, limit: 0 },
    { agentId, operation: "budget_check" },
  );
  if (!budgetStatus.withinBudget) {
    log.warn("Agent over budget", {
      agentId,
      spent: budgetStatus.spent,
      limit: budgetStatus.limit,
    });
    return earlyResponse(
      `Agent ${agentId} has exceeded its budget (spent: $${budgetStatus.spent}, limit: $${budgetStatus.limit}). Please contact an administrator.`,
    );
  }

  const replaySessionId = sessionId || `default:${agentId}`;

  return { config, model, messages, tools, allowedToolIds, replaySessionId, profilePrompt };
}

async function executeLlmCall(
  model: any,
  messages: any[],
  tools: any,
  systemPrompt: string | undefined,
  agentId: string,
  replaySessionId: string,
  triggerFn: TriggerFn,
  triggerVoidFn: TriggerVoidFn,
  iteration: number,
): Promise<any> {
  triggerVoidFn("hook::fire", {
    type: "RequestStart",
    payload: { agentId, model, messageCount: messages.length, iteration },
    agentId,
  });

  const llmStart = Date.now();
  const response: any = await triggerFn("llm::complete", {
    model,
    systemPrompt,
    messages,
    tools,
  }, TOOL_TIMEOUT_MS);

  triggerVoidFn("hook::fire", {
    type: "RequestEnd",
    payload: { agentId, model: response.model, usage: response.usage, durationMs: Date.now() - llmStart, iteration },
    agentId,
  });

  try {
    triggerVoidFn("replay::record", {
      sessionId: replaySessionId,
      agentId,
      action: "llm_call",
      data: { model: response.model, usage: response.usage },
      durationMs: Date.now() - llmStart,
      iteration,
    });
  } catch (err: any) {
    console.warn("replay::record failed", { agentId, error: err?.message });
  }

  if (response.usage) {
    try {
      triggerVoidFn("cost::track", {
        agentId,
        sessionId: replaySessionId,
        model: response.model || (model as any).model,
        inputTokens: response.usage.input || 0,
        outputTokens: response.usage.output || 0,
        cacheReadTokens: response.usage.cacheRead || 0,
        cacheWriteTokens: response.usage.cacheWrite || 0,
      });
    } catch (err: any) {
      console.warn("cost::track failed", { agentId, error: err?.message });
    }
  }

  return response;
}

async function handleCodeAgent(
  config: AgentConfig,
  response: any,
  messages: any[],
  model: any,
  systemPrompt: string | undefined,
  agentId: string,
  replaySessionId: string,
  triggerFn: TriggerFn,
  triggerVoidFn: TriggerVoidFn,
  tools: any,
): Promise<any> {
  if (!config?.codeAgentMode || !response.content) {
    return response;
  }

  const detectResult: any = await safeCall(
    () => triggerFn("agent::code_detect", { response: response.content }, 10_000),
    { hasCode: false, blocks: [] },
    { agentId, operation: "code_detect" },
  );

  if (!detectResult.hasCode) {
    return response;
  }

  let currentResponse = response;
  for (const block of detectResult.blocks) {
    const codeStart = Date.now();
    const execResult: any = await triggerFn("agent::code_execute", {
      code: block,
      agentId,
      timeout: 5000,
    }, 30_000).catch((err: any) => ({
      result: { error: err?.message },
      stdout: "",
      executionTimeMs: 0,
    }));

    try {
      triggerVoidFn("replay::record", {
        sessionId: replaySessionId,
        agentId,
        action: "tool_call",
        data: {
          toolId: "code_execute",
          code: block.slice(0, 500),
          result: execResult.result,
        },
        durationMs: Date.now() - codeStart,
        iteration: 0,
      });
    } catch (err: any) {
      console.warn("replay::record failed", { agentId, error: err?.message });
    }

    messages.push({ role: "assistant", content: currentResponse.content });
    messages.push({
      role: "user",
      content: `Code execution result:\n${execResult.stdout ? `stdout: ${execResult.stdout}\n` : ""}result: ${JSON.stringify(execResult.result)}`,
    });

    currentResponse = await executeLlmCall(
      model,
      messages,
      tools,
      systemPrompt,
      agentId,
      replaySessionId,
      triggerFn,
      triggerVoidFn,
      0,
    );
  }

  return currentResponse;
}

async function executeToolCall(
  tc: ToolCall,
  agentId: string,
  allowedToolIds: Set<string>,
  replaySessionId: string,
  iterations: number,
  triggerFn: TriggerFn,
  triggerVoidFn: TriggerVoidFn,
): Promise<{ toolCallId: string; output: unknown }> {
  if (!allowedToolIds.has(tc.id)) {
    return {
      toolCallId: tc.callId,
      output: {
        error: `Tool ${tc.id} is not in the allowed tool list`,
      },
    };
  }

  const toolStart = Date.now();
  try {
    const guardResult: any = await safeCall(
      () => triggerFn("guard::check", { agentId, toolId: tc.id }, 10_000),
      { decision: "block" },
      { agentId, operation: "guard_check" },
    );
    if (
      guardResult.decision === "block" ||
      guardResult.decision === "circuit_break"
    ) {
      return {
        toolCallId: tc.callId,
        output: { error: `Tool ${tc.id} blocked by guard` },
      };
    }

    triggerVoidFn("hook::fire", {
      type: "BeforeToolCall",
      agentId,
      toolId: tc.id,
      args: tc.arguments,
    });

    const tierResult: any = await safeCall(
      () =>
        triggerFn("approval::decide_tier", {
          toolId: tc.id,
          agentId,
          args: tc.arguments,
        }, 10_000),
      {
        approved: false,
        tier: "sync",
        reason: "approval service unavailable",
      },
      { agentId, operation: "approval_tier" },
    );
    if (!tierResult.approved) {
      if (tierResult.tier === "async" && tierResult.status === "pending") {
        return {
          toolCallId: tc.callId,
          output: {
            error: `Tool ${tc.id} is awaiting approval (tier: ${tierResult.tier}, approvalId: ${tierResult.approvalId})`,
          },
        };
      } else {
        return {
          toolCallId: tc.callId,
          output: {
            error: `Tool ${tc.id} requires approval: ${tierResult.reason || "not approved"} (tier: ${tierResult.tier})`,
          },
        };
      }
    }

    const policyResult: any = await safeCall(
      () =>
        triggerFn("policy::check", {
          agentId,
          resource: tc.id,
        }, 10_000),
      { action: "deny" },
      { agentId, operation: "policy_check" },
    );
    if (policyResult.action !== "approve") {
      return {
        toolCallId: tc.callId,
        output: {
          error: `Tool ${tc.id} blocked by policy: ${policyResult.reason || "denied"}`,
        },
      };
    }

    const approval: any = await safeCall(
      () =>
        triggerFn("approval::check", {
          agentId,
          toolId: tc.id,
          arguments: tc.arguments,
        }, 10_000),
      { approved: false, reason: "Approval timeout" },
      { agentId, operation: "approval_check" },
    );
    if (!approval.approved) {
      return {
        toolCallId: tc.callId,
        output: {
          error: `Tool ${tc.id} requires approval: ${approval.reason || "not approved"}`,
        },
      };
    }

    const capResult: any = await safeCall(
      () =>
        triggerFn("security::check_capability", {
          agentId,
          capability: tc.id.split("::")[0],
          resource: tc.id,
        }, 10_000),
      { decision: "block" },
      { agentId, operation: "check_capability" },
    );
    if (capResult.decision === "block") {
      return {
        toolCallId: tc.callId,
        output: { error: `Tool ${tc.id} blocked by capability check` },
      };
    }

    const result = await triggerFn(tc.id, tc.arguments, TOOL_TIMEOUT_MS);

    triggerVoidFn("hook::fire", {
      type: "AfterToolCall",
      agentId,
      toolId: tc.id,
      result,
    });

    triggerVoidFn("replay::record", {
      sessionId: replaySessionId,
      agentId,
      action: "tool_call",
      data: { toolId: tc.id, args: tc.arguments },
      durationMs: Date.now() - toolStart,
      iteration: iterations,
    });
    triggerVoidFn("replay::record", {
      sessionId: replaySessionId,
      agentId,
      action: "tool_result",
      data: { toolId: tc.id, output: result },
      durationMs: 0,
      iteration: iterations,
    });
    recordMetric("tool_execution_total", 1, {
      toolId: tc.id,
      status: "success",
    });
    recordMetric(
      "function_call_duration_ms",
      Date.now() - toolStart,
      { functionId: tc.id, status: "success" },
      "histogram",
    );

    return { toolCallId: tc.callId, output: result };
  } catch (err: any) {
    const errType = err?.code || err?.name || "unknown";
    recordMetric("tool_execution_total", 1, {
      toolId: tc.id,
      status: "failure",
    });
    recordMetric("function_error_total", 1, {
      functionId: tc.id,
      errorType: errType,
    });
    recordMetric(
      "function_call_duration_ms",
      Date.now() - toolStart,
      { functionId: tc.id, status: "error" },
      "histogram",
    );
    log.warn("Tool execution failed", {
      agentId,
      functionId: tc.id,
      duration: Date.now() - toolStart,
    });
    return {
      toolCallId: tc.callId,
      output: { error: err?.message || String(err) },
    };
  }
}

async function toolLoop(
  response: any,
  messages: any[],
  model: any,
  systemPrompt: string | undefined,
  agentId: string,
  replaySessionId: string,
  allowedToolIds: Set<string>,
  tools: any,
  triggerFn: TriggerFn,
  triggerVoidFn: TriggerVoidFn,
): Promise<{ response: any; iterations: number }> {
  let iterations = 0;
  let currentResponse = response;

  while (currentResponse.toolCalls?.length && iterations < MAX_ITERATIONS) {
    iterations++;

    try {
      await triggerVoidFn("publish", {
        topic: "audit",
        data: {
          type: "tool_execution",
          agentId,
          tools: currentResponse.toolCalls.map((tc: ToolCall) => tc.id),
          iteration: iterations,
        },
      });
    } catch (err: any) {
      console.warn("Audit publish failed", {
        agentId,
        iteration: iterations,
        error: err?.message,
      });
    }

    const toolResults: { toolCallId: string; output: unknown }[] = [];
    for (const tc of currentResponse.toolCalls as ToolCall[]) {
      const result = await executeToolCall(
        tc,
        agentId,
        allowedToolIds,
        replaySessionId,
        iterations,
        triggerFn,
        triggerVoidFn,
      );
      toolResults.push(result);
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: currentResponse.toolCalls,
    });
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: JSON.stringify(tr.output),
      });
    }

    if (iterations % CONTEXT_HEALTH_CHECK_INTERVAL === 0) {
      const health: any = await safeCall(
        () =>
          triggerFn("context::health", {
            messages,
            maxTokens: (model as any).maxTokens
              ? (model as any).maxTokens * 50
              : 200_000,
          }, 30_000),
        { overall: 100 },
        { agentId, operation: "context_health" },
      );

      log.info("Context health check", {
        agentId,
        iteration: iterations,
        healthScore: health.overall,
      });

      if (health.overall < CONTEXT_HEALTH_THRESHOLD) {
        const compressed: any = await safeCall(
          () =>
            triggerFn("context::compress", {
              messages,
              targetTokens: Math.floor(
                ((model as any).maxTokens
                  ? (model as any).maxTokens * 50
                  : 200_000) * 0.7,
              ),
              agentId,
            }, 30_000),
          null,
          { agentId, operation: "context_compress" },
        );

        if (compressed?.compressed) {
          messages.length = 0;
          messages.push(...compressed.compressed);
          log.info("Context auto-compressed", {
            agentId,
            removedCount: compressed.removedCount,
            savedTokens: compressed.savedTokens,
          });
        }
      }
    }

    currentResponse = await executeLlmCall(
      model,
      messages,
      tools,
      systemPrompt,
      agentId,
      replaySessionId,
      triggerFn,
      triggerVoidFn,
      iterations,
    );
  }

  return { response: currentResponse, iterations };
}

function recordChatResult(
  agentId: string,
  message: string,
  sessionId: string | undefined,
  response: any,
  replaySessionId: string,
  iterations: number,
  chatStart: number,
  triggerVoidFn: TriggerVoidFn,
): ChatResponse {
  try {
    triggerVoidFn("hook::fire", {
      type: "AgentLoopEnd",
      agentId,
      iterations,
    });
    triggerVoidFn("guard::reset", { agentId });
  } catch {}

  try {
    triggerVoidFn("memory::store", {
      agentId,
      sessionId: replaySessionId,
      role: "user",
      content: message,
    });
    if (response.content) {
      triggerVoidFn("memory::store", {
        agentId,
        sessionId: replaySessionId,
        role: "assistant",
        content: response.content,
        tokenUsage: response.usage,
      });
    }
  } catch {}

  try {
    triggerVoidFn("reflect::check_turn", {
      agentId,
      sessionId: replaySessionId,
      iterations,
    });
  } catch {}

  try {
    triggerVoidFn("state::update", {
      scope: "metering",
      key: agentId,
      operations: [
        {
          type: "increment",
          path: "totalTokens",
          value: response.usage?.total || 0,
        },
        { type: "increment", path: "invocations", value: 1 },
      ],
    });

    const hourKey = new Date().toISOString().slice(0, 13);
    triggerVoidFn("state::update", {
      scope: "metering_hourly",
      key: `${agentId}:${hourKey}`,
      operations: [
        {
          type: "increment",
          path: "tokens",
          value: response.usage?.total || 0,
        },
        { type: "increment", path: "invocations", value: 1 },
      ],
    });
  } catch {}

  const chatDuration = Date.now() - chatStart;
  const resolvedModel = response.model || "unknown";
  if (response.usage) {
    recordMetric("tokens_used_total", response.usage.input || 0, {
      model: resolvedModel,
      agent: agentId,
      type: "input",
    });
    recordMetric("tokens_used_total", response.usage.output || 0, {
      model: resolvedModel,
      agent: agentId,
      type: "output",
    });
  }
  recordMetric(
    "function_call_duration_ms",
    chatDuration,
    { functionId: "agent::chat", status: "success" },
    "histogram",
  );
  log.info("Chat completed", {
    agentId,
    sessionId,
    duration: chatDuration,
    iterations,
  });

  return {
    content: response.content,
    model: response.model,
    usage: response.usage,
    iterations,
  };
}

registerFunction(
  {
    id: "agent::chat",
    description: "Process a message through the agent loop",
    metadata: { category: "agent" },
  },
  async (input: ChatRequest): Promise<ChatResponse> => {
    const validationResult = await validateRequest(input, trigger);
    if (validationResult) return validationResult;

    const { agentId, message, sessionId, systemPrompt } = input;

    const operationId = `chat:${agentId}:${Date.now()}`;
    shutdownManager.register(operationId);

    let chatTimeoutId: ReturnType<typeof setTimeout>;
    const chatTimeout = new Promise<never>((_, reject) => {
      chatTimeoutId = setTimeout(
        () => reject(new Error("Chat timeout exceeded")),
        MAX_CHAT_TIMEOUT_MS,
      );
    });

    const chatStart = Date.now();
    recordMetric("active_sessions", 1, { agentId }, "gauge");
    log.info("Chat started", { agentId, sessionId });

    try {
      return await Promise.race([
        (async (): Promise<ChatResponse> => {
          const ctx = await prepareContext(
            agentId,
            message,
            sessionId,
            trigger,
          );
          if ("content" in ctx && "iterations" in ctx)
            return ctx as ChatResponse;
          const {
            config,
            model,
            messages,
            tools,
            allowedToolIds,
            replaySessionId,
            profilePrompt,
          } = ctx as PreparedContext;

          const resolvedPrompt = (systemPrompt || config?.systemPrompt || "") + profilePrompt;

          let response = await executeLlmCall(
            model,
            messages,
            tools,
            resolvedPrompt,
            agentId,
            replaySessionId,
            trigger,
            triggerVoid,
            0,
          );

          response = await handleCodeAgent(
            config,
            response,
            messages,
            model,
            resolvedPrompt,
            agentId,
            replaySessionId,
            trigger,
            triggerVoid,
            tools,
          );

          const loopResult = await toolLoop(
            response,
            messages,
            model,
            resolvedPrompt,
            agentId,
            replaySessionId,
            allowedToolIds,
            tools,
            trigger,
            triggerVoid,
          );

          return recordChatResult(
            agentId,
            message,
            sessionId,
            loopResult.response,
            replaySessionId,
            loopResult.iterations,
            chatStart,
            triggerVoid,
          );
        })(),
        chatTimeout,
      ]);
    } catch (err: any) {
      const chatDuration = Date.now() - chatStart;
      recordMetric(
        "function_call_duration_ms",
        chatDuration,
        { functionId: "agent::chat", status: "error" },
        "histogram",
      );
      recordMetric("function_error_total", 1, {
        functionId: "agent::chat",
        errorType: err?.code || err?.name || "unknown",
      });
      log.error("Chat failed", { agentId, sessionId, duration: chatDuration });
      throw err;
    } finally {
      clearTimeout(chatTimeoutId!);
      recordMetric("active_sessions", 0, { agentId }, "gauge");
      shutdownManager.complete(operationId);
      triggerVoid("rate::release_concurrent", { agentId });
    }
  },
);

registerFunction(
  {
    id: "agent::list_tools",
    description: "List tools available to an agent",
    metadata: { category: "agent" },
  },
  async ({ agentId }: { agentId: string }) => {
    const config: AgentConfig = await trigger("state::get", {
      scope: "agents",
      key: agentId,
    }, 10_000);

    const allowedCapabilities = config?.capabilities?.tools || ["*"];
    const allFunctions = await listFunctions();

    const filtered = allowedCapabilities.includes("*")
      ? allFunctions
      : allFunctions.filter((fn) =>
          allowedCapabilities.some((cap: string) =>
            fn.function_id.startsWith(cap),
          ),
        );

    return filterToolsByProfile(filtered, config?.toolProfile || "full");
  },
);

registerFunction(
  {
    id: "agent::create",
    description: "Register a new agent",
    metadata: { category: "agent" },
  },
  async (config: AgentConfig) => {
    const agentId = config.id || crypto.randomUUID();
    await trigger("state::set", {
      scope: "agents",
      key: agentId,
      value: { ...config, id: agentId, createdAt: Date.now() },
    }, 10_000);
    triggerVoid("publish", {
      topic: "agent.lifecycle",
      data: { type: "created", agentId },
    });
    triggerVoid("a2a::generate_card", { agentId });
    return { agentId };
  },
);

registerFunction(
  {
    id: "agent::list",
    description: "List all agents",
    metadata: { category: "agent" },
  },
  async () => {
    return trigger("state::list", { scope: "agents" }, 10_000);
  },
);

registerFunction(
  {
    id: "agent::delete",
    description: "Remove an agent",
    metadata: { category: "agent" },
  },
  async ({ agentId }: { agentId: string }) => {
    await trigger("state::delete", { scope: "agents", key: agentId }, 10_000);
    triggerVoid("publish", {
      topic: "agent.lifecycle",
      data: { type: "deleted", agentId },
    });
    return { deleted: true };
  },
);

registerFunction(
  {
    id: "agent::list_by_division",
    description: "List agents filtered by division",
    metadata: { category: "agent" },
  },
  async ({ division }: { division?: Division }) => {
    const agents: AgentConfig[] = await trigger("state::list", {
      scope: "agents",
    }, 10_000);
    if (!division) return agents;
    return agents.filter((a) => a.persona?.division === division);
  },
);

registerTrigger({
  type: "queue",
  function_id: "agent::chat",
  config: { topic: "agent.inbox" },
});

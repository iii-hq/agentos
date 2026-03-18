import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireAuth, sanitizeId } from "./shared/utils.js";
import { SECURITY_HEADERS } from "./security-headers.js";
import { safeInt } from "./shared/validate.js";
import { safeCall } from "./shared/errors.js";
import { shutdownManager } from "./shared/shutdown.js";

function withSecHeaders(response: { status_code: number; body: any }): {
  status_code: number;
  body: any;
  headers: Record<string, string>;
} {
  return { ...response, headers: { ...SECURITY_HEADERS } };
}

const sdk = registerWorker(ENGINE_URL, { workerName: "api", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function authGuard(req: any): { status_code: number; body: any } | null {
  try {
    if (req.headers) requireAuth(req);
    return null;
  } catch (err: any) {
    if (err.statusCode === 401) {
      return { status_code: 401, body: { error: "Unauthorized" } };
    }
    throw err;
  }
}

async function rateGuard(
  req: any,
  operation: string,
): Promise<{ status_code: number; body: any } | null> {
  const rateResult: any = await safeCall(
    () =>
      trigger({
        function_id: "rate::check",
        payload: {
          ip: req.headers?.["x-forwarded-for"] || req.remote_addr || "unknown",
          operation,
        },
      }),
    { allowed: true },
    { operation: "rate_check", functionId: "api::rateGuard" },
  );
  if (!rateResult.allowed) {
    return {
      status_code: 429,
      body: { error: "Rate limit exceeded", retryAfter: rateResult.retryAfter },
    };
  }
  return null;
}

registerFunction(
  {
    id: "api::chat_completions",
    description: "OpenAI-compatible chat completions",
    metadata: { category: "api" },
    request_format: [
      { name: "model", type: "string", required: true, description: "Model identifier" },
      {
        name: "messages",
        type: "array",
        required: true,
        description: "Array of chat messages",
        items: {
          name: "message",
          type: "object",
          body: [
            { name: "role", type: "string", required: true },
            { name: "content", type: "string", required: true },
          ],
        },
      },
    ],
    response_format: [
      { name: "id", type: "string", description: "Completion ID" },
      { name: "object", type: "string", description: "Object type" },
      { name: "created", type: "number", description: "Unix timestamp" },
      { name: "model", type: "string", description: "Model used" },
      {
        name: "choices",
        type: "array",
        description: "Completion choices",
        items: {
          name: "choice",
          type: "object",
          body: [
            { name: "index", type: "number" },
            {
              name: "message",
              type: "object",
              body: [
                { name: "role", type: "string" },
                { name: "content", type: "string" },
              ],
            },
            { name: "finish_reason", type: "string" },
          ],
        },
      },
      {
        name: "usage",
        type: "object",
        description: "Token usage",
        body: [
          { name: "prompt_tokens", type: "number" },
          { name: "completion_tokens", type: "number" },
          { name: "total_tokens", type: "number" },
        ],
      },
    ],
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "message");
    if (rateErr) return rateErr;

    const { model, messages } = req.body || req;
    const lastMessage = messages?.[messages.length - 1]?.content || "";

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId: "default",
        message: lastMessage,
        sessionId: `api:${Date.now()}`,
      },
    });

    return withSecHeaders({
      status_code: 200,
      body: {
        id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: response.model || model || "claude-sonnet-4-6",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: response.content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: response.usage?.input || 0,
          completion_tokens: response.usage?.output || 0,
          total_tokens: response.usage?.total || 0,
        },
      },
    });
  },
);

registerFunction(
  {
    id: "api::agent_message",
    description: "Send message to a specific agent",
    metadata: { category: "api" },
    request_format: [
      { name: "message", type: "string", required: true, description: "Message to send" },
      { name: "sessionId", type: "string", required: false, description: "Optional session ID" },
    ],
    response_format: [
      { name: "content", type: "string", description: "Agent response content" },
      { name: "model", type: "string", description: "Model used" },
      {
        name: "usage",
        type: "object",
        description: "Token usage",
        body: [
          { name: "input", type: "number" },
          { name: "output", type: "number" },
          { name: "total", type: "number" },
        ],
      },
    ],
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "message");
    if (rateErr) return rateErr;

    const agentId = sanitizeId(req.path_params?.id);
    const { message, sessionId } = req.body || req;

    const response = await trigger({
      function_id: "agent::chat",
      payload: { agentId, message, sessionId },
    });

    return withSecHeaders({ status_code: 200, body: response });
  },
);

registerFunction(
  {
    id: "api::list_agents",
    description: "List all agents",
    metadata: { category: "api" },
  },
  async (req: any) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const agents = await trigger({ function_id: "agent::list", payload: {} });
    return withSecHeaders({ status_code: 200, body: agents });
  },
);

registerFunction(
  {
    id: "api::create_agent",
    description: "Create a new agent",
    metadata: { category: "api" },
    request_format: [
      { name: "name", type: "string", required: true, description: "Agent name" },
      { name: "systemPrompt", type: "string", required: true, description: "System prompt for the agent" },
      { name: "model", type: "string", required: true, description: "LLM model identifier" },
    ],
    response_format: [
      { name: "id", type: "string", description: "Created agent ID" },
      { name: "name", type: "string", description: "Agent name" },
      { name: "createdAt", type: "number", description: "Creation timestamp" },
    ],
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "write");
    if (rateErr) return rateErr;

    const result = await trigger({
      function_id: "agent::create",
      payload: req.body || req,
    });
    return withSecHeaders({ status_code: 201, body: result });
  },
);

registerFunction(
  {
    id: "api::get_agent",
    description: "Get agent by ID",
    metadata: { category: "api" },
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const agent = await trigger({
      function_id: "state::get",
      payload: {
        scope: "agents",
        key: sanitizeId(req.path_params?.id),
      },
    });
    if (!agent)
      return withSecHeaders({
        status_code: 404,
        body: { error: "Agent not found" },
      });
    return withSecHeaders({ status_code: 200, body: agent });
  },
);

registerFunction(
  {
    id: "api::delete_agent",
    description: "Delete an agent",
    metadata: { category: "api" },
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "write");
    if (rateErr) return rateErr;

    await trigger({
      function_id: "agent::delete",
      payload: { agentId: sanitizeId(req.path_params?.id) },
    });
    return withSecHeaders({ status_code: 204, body: null });
  },
);

registerFunction(
  {
    id: "api::agent_sessions",
    description: "List sessions for an agent",
    metadata: { category: "api" },
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const sessions = await trigger({
      function_id: "state::list",
      payload: { scope: `sessions:${sanitizeId(req.path_params?.id)}` },
    });
    return withSecHeaders({ status_code: 200, body: sessions });
  },
);

registerFunction(
  {
    id: "api::health",
    description: "Health check endpoint",
    metadata: { category: "api" },
    response_format: [
      { name: "status", type: "string", description: "Health status" },
      { name: "version", type: "string", description: "Application version" },
      { name: "workers", type: "number", description: "Active worker count" },
      { name: "uptime", type: "number", description: "Process uptime in seconds" },
    ],
  },
  async (req: any) => {
    if (shutdownManager.isShuttingDown()) {
      return withSecHeaders({
        status_code: 503,
        body: {
          status: "shutting_down",
          version: PKG_VERSION,
          inFlight: shutdownManager.inFlightCount(),
        },
      });
    }

    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const workers: any = await safeCall(
      () => trigger({ function_id: "engine::workers::list", payload: {} }),
      [],
      { operation: "list_workers", functionId: "api::health" },
    );
    return withSecHeaders({
      status_code: 200,
      body: {
        status: "healthy",
        version: PKG_VERSION,
        workers: workers.length,
        uptime: process.uptime(),
      },
    });
  },
);

registerFunction(
  {
    id: "api::costs",
    description: "Get cost breakdown",
    metadata: { category: "api" },
  },
  async (req: any) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const today = new Date().toISOString().slice(0, 10);
    const costs = await safeCall(
      () => trigger({
        function_id: "state::get",
        payload: { scope: "costs", key: today },
      }),
      null,
      { operation: "get_costs", functionId: "api::costs" },
    );
    return withSecHeaders({
      status_code: 200,
      body: costs || { totalCost: 0 },
    });
  },
);

registerFunction(
  {
    id: "api::memory_query",
    description: "Query agent memory",
    metadata: { category: "api" },
  },
  async (req) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const agentId = sanitizeId(req.path_params?.id);
    const { query, limit: rawLimit } = req.query_params || req.body || {};
    const limit = safeInt(rawLimit, 1, 200, 10);
    const results = await trigger({
      function_id: "memory::recall",
      payload: { agentId, query, limit },
    });
    return withSecHeaders({ status_code: 200, body: results });
  },
);

registerTrigger({
  type: "http",
  function_id: "api::chat_completions",
  config: { api_path: "v1/chat/completions", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "api::list_agents",
  config: { api_path: "api/agents", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "api::create_agent",
  config: { api_path: "api/agents", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "api::get_agent",
  config: { api_path: "api/agents/:id", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "api::delete_agent",
  config: { api_path: "api/agents/:id", http_method: "DELETE" },
});
registerTrigger({
  type: "http",
  function_id: "api::agent_message",
  config: { api_path: "api/agents/:id/message", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "api::agent_sessions",
  config: { api_path: "api/agents/:id/sessions", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "api::memory_query",
  config: { api_path: "api/agents/:id/memory", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "api::health",
  config: { api_path: "api/health", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "api::costs",
  config: { api_path: "api/costs", http_method: "GET" },
});

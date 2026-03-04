import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireAuth, sanitizeId } from "./shared/utils.js";
import { SECURITY_HEADERS } from "./security-headers.js";
import { safeInt } from "./shared/validate.js";
import { createLogger } from "./shared/logger.js";
import { safeCall } from "./shared/errors.js";
import { shutdownManager } from "./shared/shutdown.js";
import { createRecordMetric } from "./shared/metrics.js";

const log = createLogger("api");

shutdownManager.initShutdown();

function withSecHeaders(response: { status_code: number; body: any }): {
  status_code: number;
  body: any;
  headers: Record<string, string>;
} {
  return { ...response, headers: { ...SECURITY_HEADERS } };
}

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "api" },
);

const recordMetric = createRecordMetric(triggerVoid);

function instrumentedHandler(
  functionId: string,
  method: string,
  apiPath: string,
  handler: (req: any) => Promise<any>,
): (req: any) => Promise<any> {
  return async (req: any) => {
    const start = Date.now();
    try {
      const result = await handler(req);
      const status = String(result?.status_code || 200);
      recordMetric(
        "api_request_duration_ms",
        Date.now() - start,
        { path: apiPath, method, status },
        "histogram",
      );
      return result;
    } catch (err: any) {
      recordMetric(
        "api_request_duration_ms",
        Date.now() - start,
        { path: apiPath, method, status: "500" },
        "histogram",
      );
      recordMetric("function_error_total", 1, {
        functionId,
        errorType: err?.code || err?.name || "unknown",
      });
      log.error("API request failed", {
        functionId,
        duration: Date.now() - start,
      });
      throw err;
    }
  };
}

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
    requireAuth(req);
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
      trigger("rate::check", {
        ip: req.headers?.["x-forwarded-for"] || req.remote_addr || "unknown",
        operation,
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
  },
  instrumentedHandler(
    "api::chat_completions",
    "POST",
    "v1/chat/completions",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "message");
      if (rateErr) return rateErr;

      const { model, messages } = req.body || req;
      const lastMessage = messages?.[messages.length - 1]?.content || "";

      const response: any = await trigger("agent::chat", {
        agentId: "default",
        message: lastMessage,
        sessionId: `api:${Date.now()}`,
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
  ),
);

registerFunction(
  {
    id: "api::agent_message",
    description: "Send message to a specific agent",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::agent_message",
    "POST",
    "api/agents/:id/message",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "message");
      if (rateErr) return rateErr;

      const agentId = sanitizeId(req.path_params?.id);
      const { message, sessionId } = req.body || req;

      const response = await trigger("agent::chat", {
        agentId,
        message,
        sessionId,
      });

      return withSecHeaders({ status_code: 200, body: response });
    },
  ),
);

registerFunction(
  {
    id: "api::list_agents",
    description: "List all agents",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::list_agents",
    "GET",
    "api/agents",
    async (req: any) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "read");
      if (rateErr) return rateErr;

      const agents = await trigger("agent::list", {});
      return withSecHeaders({ status_code: 200, body: agents });
    },
  ),
);

registerFunction(
  {
    id: "api::create_agent",
    description: "Create a new agent",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::create_agent",
    "POST",
    "api/agents",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "write");
      if (rateErr) return rateErr;

      const result = await trigger("agent::create", req.body || req);
      return withSecHeaders({ status_code: 201, body: result });
    },
  ),
);

registerFunction(
  {
    id: "api::get_agent",
    description: "Get agent by ID",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::get_agent",
    "GET",
    "api/agents/:id",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "read");
      if (rateErr) return rateErr;

      const agent = await trigger("state::get", {
        scope: "agents",
        key: sanitizeId(req.path_params?.id),
      });
      if (!agent)
        return withSecHeaders({
          status_code: 404,
          body: { error: "Agent not found" },
        });
      return withSecHeaders({ status_code: 200, body: agent });
    },
  ),
);

registerFunction(
  {
    id: "api::delete_agent",
    description: "Delete an agent",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::delete_agent",
    "DELETE",
    "api/agents/:id",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "write");
      if (rateErr) return rateErr;

      await trigger("agent::delete", {
        agentId: sanitizeId(req.path_params?.id),
      });
      return withSecHeaders({ status_code: 204, body: null });
    },
  ),
);

registerFunction(
  {
    id: "api::agent_sessions",
    description: "List sessions for an agent",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::agent_sessions",
    "GET",
    "api/agents/:id/sessions",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "read");
      if (rateErr) return rateErr;

      const sessions = await trigger("state::list", {
        scope: `sessions:${sanitizeId(req.path_params?.id)}`,
      });
      return withSecHeaders({ status_code: 200, body: sessions });
    },
  ),
);

registerFunction(
  {
    id: "api::health",
    description: "Health check endpoint",
    metadata: { category: "api" },
  },
  instrumentedHandler("api::health", "GET", "api/health", async (req: any) => {
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
      () => trigger("engine::workers::list", {}),
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
  }),
);

registerFunction(
  {
    id: "api::costs",
    description: "Get cost breakdown",
    metadata: { category: "api" },
  },
  instrumentedHandler("api::costs", "GET", "api/costs", async (req: any) => {
    const authErr = authGuard(req);
    if (authErr) return authErr;
    const rateErr = await rateGuard(req, "read");
    if (rateErr) return rateErr;

    const today = new Date().toISOString().slice(0, 10);
    const costs = await safeCall(
      () => trigger("state::get", { scope: "costs", key: today }),
      null,
      { operation: "get_costs", functionId: "api::costs" },
    );
    return withSecHeaders({
      status_code: 200,
      body: costs || { totalCost: 0 },
    });
  }),
);

registerFunction(
  {
    id: "api::memory_query",
    description: "Query agent memory",
    metadata: { category: "api" },
  },
  instrumentedHandler(
    "api::memory_query",
    "POST",
    "api/agents/:id/memory",
    async (req) => {
      const authErr = authGuard(req);
      if (authErr) return authErr;
      const rateErr = await rateGuard(req, "read");
      if (rateErr) return rateErr;

      const agentId = sanitizeId(req.path_params?.id);
      const { query, limit: rawLimit } = req.query_params || req.body || {};
      const limit = safeInt(rawLimit, 1, 200, 10);
      const results = await trigger("memory::recall", {
        agentId,
        query,
        limit,
      });
      return withSecHeaders({ status_code: 200, body: results });
    },
  ),
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

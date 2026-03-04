import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "rate-limiter" },
);

interface GcraState {
  tat: number;
  tokens: number;
}

interface RateCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number | null;
  limit: number;
}

const TOKENS_PER_MINUTE = 500;
const EMISSION_INTERVAL_MS = (60 * 1000) / TOKENS_PER_MINUTE;
const BURST_LIMIT = TOKENS_PER_MINUTE;

const OPERATION_COSTS: Record<string, number> = {
  health: 1,
  agents_list: 2,
  agents_get: 2,
  agents_create: 10,
  agents_delete: 5,
  message: 30,
  workflow_run: 100,
  workflow_list: 2,
  tool_call: 20,
  memory_store: 10,
  memory_recall: 5,
  memory_evict: 50,
  sandbox_execute: 50,
  sandbox_validate: 20,
  audit_verify: 5,
  scan_injection: 3,
  default: 5,
};

async function gcraCheck(
  key: string,
  cost: number,
  now: number,
): Promise<RateCheckResult> {
  const state: GcraState | null = await trigger("state::get", {
    scope: "rate_limiter",
    key,
  });

  const increment = cost * EMISSION_INTERVAL_MS;

  if (!state) {
    const newTat = now + increment;
    await triggerVoid("state::set", {
      scope: "rate_limiter",
      key,
      value: { tat: newTat, tokens: BURST_LIMIT - cost },
    });
    return {
      allowed: true,
      remaining: BURST_LIMIT - cost,
      retryAfter: null,
      limit: TOKENS_PER_MINUTE,
    };
  }

  const tat = Math.max(state.tat, now);
  const newTat = tat + increment;
  const allowAt = newTat - BURST_LIMIT * EMISSION_INTERVAL_MS;

  if (allowAt > now) {
    const retryAfterMs = Math.ceil(allowAt - now);
    const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfter: retryAfterSecs,
      limit: TOKENS_PER_MINUTE,
    };
  }

  const remaining = Math.max(
    0,
    Math.floor(
      (BURST_LIMIT * EMISSION_INTERVAL_MS - (newTat - now)) /
        EMISSION_INTERVAL_MS,
    ),
  );
  await triggerVoid("state::set", {
    scope: "rate_limiter",
    key,
    value: { tat: newTat, tokens: remaining },
  });

  return {
    allowed: true,
    remaining,
    retryAfter: null,
    limit: TOKENS_PER_MINUTE,
  };
}

registerFunction(
  {
    id: "rate::check",
    description: "GCRA rate limit check per IP and operation",
  },
  async ({ ip, operation }: { ip: string; operation: string }) => {
    const cost = OPERATION_COSTS[operation] ?? OPERATION_COSTS.default;
    const now = Date.now();
    const key = `ip:${ip}`;

    const result = await gcraCheck(key, cost, now);

    const currentState: GcraState | null = await trigger("state::get", {
      scope: "rate_limiter",
      key,
    });
    triggerVoid("state::set", {
      scope: "rate_limits",
      key,
      value: {
        ip,
        lastCheck: now,
        lastOperation: operation,
        lastCost: cost,
        allowed: result.allowed,
        remaining: result.remaining,
        state: currentState,
      },
    });

    if (!result.allowed) {
      triggerVoid("security::audit", {
        type: "rate_limited",
        detail: { ip, operation, cost, retryAfter: result.retryAfter },
      });
    }

    return result;
  },
);

registerFunction(
  { id: "rate::get_status", description: "Get rate limit status for an IP" },
  async ({ ip }: { ip: string }) => {
    const key = `ip:${ip}`;
    const state: GcraState | null = await trigger("state::get", {
      scope: "rate_limiter",
      key,
    });

    if (!state) {
      return {
        ip,
        remaining: TOKENS_PER_MINUTE,
        limit: TOKENS_PER_MINUTE,
        tracked: false,
      };
    }

    const now = Date.now();
    const remaining = Math.max(
      0,
      Math.floor(
        (BURST_LIMIT * EMISSION_INTERVAL_MS - (state.tat - now)) /
          EMISSION_INTERVAL_MS,
      ),
    );

    return {
      ip,
      remaining,
      limit: TOKENS_PER_MINUTE,
      tracked: true,
      tat: state.tat,
    };
  },
);

registerFunction(
  { id: "rate::reset", description: "Reset rate limit for an IP" },
  async (req: any) => {
    requireAuth(req);
    const { ip } = req.body || req;
    const key = `ip:${ip}`;
    await triggerVoid("state::set", {
      scope: "rate_limiter",
      key,
      value: null,
    });

    await trigger("state::delete", {
      scope: "rate_limits",
      key,
    }).catch(() => null);

    return { reset: true, ip };
  },
);

registerFunction(
  { id: "rate::get_costs", description: "Get operation cost table" },
  async () => {
    return {
      tokensPerMinute: TOKENS_PER_MINUTE,
      costs: OPERATION_COSTS,
    };
  },
);

const DEFAULT_AGENT_TOKENS_PER_MIN = 100;
const DEFAULT_AGENT_MAX_CONCURRENT = 10;

registerFunction(
  {
    id: "rate::check_agent",
    description: "Per-agent GCRA rate limit check",
  },
  async ({
    agentId,
    operation,
    tokensPerMinute,
  }: {
    agentId: string;
    operation: string;
    tokensPerMinute?: number;
  }) => {
    const limit = tokensPerMinute || DEFAULT_AGENT_TOKENS_PER_MIN;
    const cost = OPERATION_COSTS[operation] ?? OPERATION_COSTS.default;
    const now = Date.now();
    const key = `agent:${agentId}`;

    const emissionMs = (60 * 1000) / limit;
    const increment = cost * emissionMs;

    const state: GcraState | null = await trigger("state::get", {
      scope: "rate_limiter",
      key,
    });
    if (!state) {
      const newTat = now + increment;
      await triggerVoid("state::set", {
        scope: "rate_limiter",
        key,
        value: { tat: newTat, tokens: limit - cost },
      });
      return {
        allowed: true,
        remaining: limit - cost,
        retryAfter: null,
        limit,
      };
    }

    const tat = Math.max(state.tat, now);
    const newTat = tat + increment;
    const allowAt = newTat - limit * emissionMs;

    if (allowAt > now) {
      const retryAfterSecs = Math.ceil((allowAt - now) / 1000);
      triggerVoid("security::audit", {
        type: "agent_rate_limited",
        detail: { agentId, operation, cost, retryAfter: retryAfterSecs },
      });
      return {
        allowed: false,
        remaining: 0,
        retryAfter: retryAfterSecs,
        limit,
      };
    }

    const remaining = Math.max(
      0,
      Math.floor((limit * emissionMs - (newTat - now)) / emissionMs),
    );
    await triggerVoid("state::set", {
      scope: "rate_limiter",
      key,
      value: { tat: newTat, tokens: remaining },
    });
    return { allowed: true, remaining, retryAfter: null, limit };
  },
);

registerFunction(
  {
    id: "rate::check_function",
    description: "Per-function rate limit check",
  },
  async ({ functionId }: { functionId: string }) => {
    const now = Date.now();
    const key = `fn:${functionId}`;
    return gcraCheck(key, 1, now);
  },
);

registerFunction(
  {
    id: "rate::acquire_concurrent",
    description: "Acquire concurrent invocation slot for an agent",
  },
  async ({
    agentId,
    maxConcurrent,
  }: {
    agentId: string;
    maxConcurrent?: number;
  }) => {
    const limit = maxConcurrent || DEFAULT_AGENT_MAX_CONCURRENT;
    const current: number =
      (await trigger("state::get", {
        scope: "rate_concurrent",
        key: agentId,
      })) || 0;
    if (current >= limit) {
      return { acquired: false, current, limit };
    }
    await triggerVoid("state::set", {
      scope: "rate_concurrent",
      key: agentId,
      value: current + 1,
    });
    return { acquired: true, current: current + 1, limit };
  },
);

registerFunction(
  {
    id: "rate::release_concurrent",
    description: "Release concurrent invocation slot for an agent",
  },
  async ({ agentId }: { agentId: string }) => {
    const current: number =
      (await trigger("state::get", {
        scope: "rate_concurrent",
        key: agentId,
      })) || 0;
    const next = Math.max(0, current - 1);
    await triggerVoid("state::set", {
      scope: "rate_concurrent",
      key: agentId,
      value: next,
    });
    return { released: true, current: next };
  },
);

registerTrigger({
  type: "http",
  function_id: "rate::check",
  config: { api_path: "api/rate/check", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "rate::get_status",
  config: { api_path: "api/rate/status", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "rate::reset",
  config: { api_path: "api/rate/reset", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "rate::get_costs",
  config: { api_path: "api/rate/costs", http_method: "GET" },
});

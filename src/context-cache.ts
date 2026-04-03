import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { sanitizeId, requireAuth } from "./shared/utils.js";

const CACHEABLE_FUNCTIONS = new Set([
  "memory::recall",
  "memory::user_profile::get",
  "agent::list_tools",
]);

const sdk = registerWorker(ENGINE_URL, {
  workerName: "context-cache",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface CacheEntry {
  value: unknown;
  cachedAt: number;
  ttlMs: number;
}

interface CacheStats {
  hits: number;
  misses: number;
}

const statsMap = new Map<string, CacheStats>();

function getStats(agentId: string): CacheStats {
  if (!statsMap.has(agentId)) {
    statsMap.set(agentId, { hits: 0, misses: 0 });
  }
  return statsMap.get(agentId)!;
}

registerFunction(
  {
    id: "context_cache::get_or_fetch",
    description: "Memoized context fetch with TTL-based expiry",
    metadata: { category: "context_cache" },
  },
  async (req: any): Promise<unknown> => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;

    if (!CACHEABLE_FUNCTIONS.has(input.fetchFunctionId)) {
      throw Object.assign(
        new Error(`Function ${input.fetchFunctionId} is not cacheable`),
        { statusCode: 400 },
      );
    }

    const agentId = sanitizeId(input.agentId);
    const scope = `cache:${agentId}`;
    const stats = getStats(agentId);

    const cached: CacheEntry | null = await trigger({
      function_id: "state::get",
      payload: { scope, key: input.key },
    });

    if (cached && Date.now() - cached.cachedAt < cached.ttlMs) {
      stats.hits++;
      return cached.value;
    }

    stats.misses++;

    const value = await trigger({
      function_id: input.fetchFunctionId,
      payload: input.fetchPayload,
    });

    const entry: CacheEntry = {
      value,
      cachedAt: Date.now(),
      ttlMs: input.ttlMs,
    };

    await trigger({
      function_id: "state::set",
      payload: { scope, key: input.key, value: entry },
    });

    return value;
  },
);

registerFunction(
  {
    id: "context_cache::invalidate",
    description: "Clear cache entry or all entries for an agent",
    metadata: { category: "context_cache" },
  },
  async (input: { agentId: string; key?: string }): Promise<{ cleared: number }> => {
    const scope = `cache:${sanitizeId(input.agentId)}`;

    if (input.key) {
      await trigger({
        function_id: "state::delete",
        payload: { scope, key: input.key },
      });
      return { cleared: 1 };
    }

    const entries = (await trigger({
      function_id: "state::list",
      payload: { scope },
    }).catch(() => [])) as any[];

    let cleared = 0;
    for (const entry of entries || []) {
      await trigger({
        function_id: "state::delete",
        payload: { scope, key: entry.key },
      });
      cleared++;
    }

    return { cleared };
  },
);

registerFunction(
  {
    id: "context_cache::stats",
    description: "Cache hit/miss stats per agent",
    metadata: { category: "context_cache" },
  },
  async (input: { agentId?: string }): Promise<
    | CacheStats
    | Record<string, CacheStats>
  > => {
    if (input.agentId) {
      return getStats(input.agentId);
    }

    const result: Record<string, CacheStats> = {};
    for (const [agentId, stats] of statsMap) {
      result[agentId] = stats;
    }
    return result;
  },
);

registerTrigger({
  type: "http",
  function_id: "context_cache::get_or_fetch",
  config: { api_path: "api/context-cache/fetch", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context_cache::invalidate",
  config: { api_path: "api/context-cache/invalidate", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context_cache::stats",
  config: { api_path: "api/context-cache/stats", http_method: "POST" },
});

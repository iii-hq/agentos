import { httpOk } from "./shared/utils.js";
import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createHash } from "crypto";
import { safeCall } from "./shared/errors.js";
import { recordMetric } from "./shared/metrics.js";


const log = new Logger();

const sdk = registerWorker(ENGINE_URL, {
  workerName: "memory",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  role: string;
  embedding?: number[];
  timestamp: number;
  sessionId?: string;
  importance?: number;
  hash: string;
}

interface KGEntity {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  relations: Array<{ target: string; type: string }>;
}

registerFunction(
  {
    id: "memory::store",
    description: "Store a memory entry with dedup",
    metadata: { category: "memory" },
  },
  async (input) => {
    const { agentId, content, role, sessionId, tokenUsage } = input;

    const hash = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);

    const existing: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `memory:${agentId}`, key: hash },
        }),
      null,
      { agentId, operation: "dedup_check", functionId: "memory::store" },
    );

    if (existing) {
      recordMetric("memory_operations_total", 1, {
        operation: "store",
        status: "dedup",
      });
      return { deduplicated: true, id: existing.id };
    }

    const id = crypto.randomUUID();
    const entry: MemoryEntry = {
      id,
      agentId,
      content,
      role,
      timestamp: Date.now(),
      sessionId,
      importance: estimateImportance(content, role),
      hash,
    };

    const embedding = await safeCall(
      () =>
        trigger({
          function_id: "memory::embed",
          payload: { text: content },
        }) as Promise<number[]>,
      null,
      { agentId, operation: "embed_content", functionId: "memory::store" },
    );
    if (embedding) {
      entry.embedding = embedding;
    }

    await trigger({
      function_id: "state::set",
      payload: { scope: `memory:${agentId}`, key: id, value: entry },
    });

    await trigger({
      function_id: "state::set",
      payload: {
        scope: `memory:${agentId}`,
        key: hash,
        value: { id, timestamp: entry.timestamp },
      },
    });

    if (sessionId) {
      await trigger({
        function_id: "state::update",
        payload: {
          scope: `sessions:${agentId}`,
          key: sessionId,
          operations: [
          {
            type: "merge",
            path: "messages",
            value: [{ id, role, timestamp: entry.timestamp }],
          },
          { type: "set", path: "updatedAt", value: Date.now() },
        ],
        },
      });
    }

    if (tokenUsage) {
      trigger({
        function_id: "state::update",
        payload: {
          scope: `sessions:${agentId}`,
          key: sessionId || "default",
          operations: [
            {
              type: "increment",
              path: "totalTokens",
              value: tokenUsage.total || 0,
            },
          ],
        },
        action: TriggerAction.Void(),
      });
    }

    recordMetric("memory_operations_total", 1, { operation: "store" });
    return { id, stored: true };
  },
);

registerFunction(
  {
    id: "memory::recall",
    description: "Semantic + recency memory search",
    metadata: { category: "memory" },
  },
  async ({ agentId, query, limit: rawLimit = 10 }) => {
    const limit = Math.max(1, Math.min(Number(rawLimit) || 10, 200));
    const entries: any = await trigger({
      function_id: "state::list",
      payload: { scope: `memory:${agentId}` },
    });

    const memories: MemoryEntry[] = (entries || [])
      .filter((e: any) => e.value?.content && e.value?.role)
      .map((e: any) => e.value);

    if (!memories.length) return [];

    const queryEmbedding = await safeCall(
      () =>
        trigger({
          function_id: "memory::embed",
          payload: { text: query },
        }) as Promise<number[]>,
      null,
      { operation: "embed_query", functionId: "memory::recall" },
    );

    const scored = memories.map((m) => {
      let score = 0;

      if (queryEmbedding && m.embedding) {
        score += cosineSimilarity(queryEmbedding, m.embedding) * 0.6;
      }

      const keywords = query.toLowerCase().split(/\s+/);
      const content = m.content.toLowerCase();
      const keywordHits = keywords.filter((k: string) =>
        content.includes(k),
      ).length;
      score += (keywordHits / Math.max(keywords.length, 1)) * 0.25;

      const ageHours = (Date.now() - m.timestamp) / 3_600_000;
      const recencyScore = Math.exp(-ageHours / 168);
      score += recencyScore * 0.1;

      score += (m.importance || 0.5) * 0.05;

      return { ...m, score };
    });

    recordMetric("memory_operations_total", 1, { operation: "recall" });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => ({
        role: m.role,
        content: m.content,
        score: m.score,
        timestamp: m.timestamp,
      }));
  },
);

registerFunction(
  {
    id: "memory::embed",
    description: "Generate text embedding",
    metadata: { category: "memory" },
  },
  async ({ text }: { text: string }) => {
    const words = text.toLowerCase().split(/\s+/);
    const dim = 128;
    const vec = new Array(dim).fill(0);
    for (const word of words) {
      const h = simpleHash(word);
      for (let i = 0; i < dim; i++) {
        vec[i] += Math.sin(h * (i + 1)) / words.length;
      }
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return norm > 0 ? vec.map((v: number) => v / norm) : vec;
  },
);

registerFunction(
  {
    id: "memory::kg::add",
    description: "Add knowledge graph entity",
    metadata: { category: "memory" },
  },
  async ({ agentId, entity }: { agentId: string; entity: KGEntity }) => {
    await trigger({
      function_id: "state::set",
      payload: { scope: `kg:${agentId}`, key: entity.id, value: entity },
    });

    for (const rel of entity.relations || []) {
      const target: any = await safeCall(
        () =>
          trigger({
            function_id: "state::get",
            payload: { scope: `kg:${agentId}`, key: rel.target },
          }),
        null,
        {
          agentId,
          operation: "kg_backref_lookup",
          functionId: "memory::kg::add",
        },
      );

      if (target) {
        const backRefs = target.relations || [];
        if (
          !backRefs.some(
            (r: any) => r.target === entity.id && r.type === rel.type,
          )
        ) {
          backRefs.push({ target: entity.id, type: `inverse:${rel.type}` });
          await trigger({
            function_id: "state::update",
            payload: {
              scope: `kg:${agentId}`,
              key: rel.target,
              operations: [{ type: "set", path: "relations", value: backRefs }],
            },
          });
        }
      }
    }

    return { stored: true, id: entity.id };
  },
);

registerFunction(
  {
    id: "memory::kg::query",
    description: "Query knowledge graph (agent-scoped)",
    metadata: { category: "memory" },
  },
  async ({
    agentId,
    entityId,
    depth = 2,
    allowShared = false,
  }: {
    agentId: string;
    entityId: string;
    depth?: number;
    allowShared?: boolean;
  }) => {
    const clampedDepth = Math.max(1, Math.min(depth, 5));
    const maxNodes = 500;
    const visited = new Set<string>();
    const results: KGEntity[] = [];

    async function traverse(id: string, d: number) {
      if (d <= 0 || visited.has(id) || results.length >= maxNodes) return;
      visited.add(id);

      const entity: any = await safeCall(
        () =>
          trigger({
            function_id: "state::get",
            payload: { scope: `kg:${agentId}`, key: id },
          }),
        null,
        { agentId, operation: "kg_traverse", functionId: "memory::kg::query" },
      );

      if (!entity && allowShared) {
        const shared: any = await safeCall(
          () =>
            trigger({
              function_id: "state::get",
              payload: { scope: "kg:shared", key: id },
            }),
          null,
          {
            agentId,
            operation: "kg_traverse_shared",
            functionId: "memory::kg::query",
          },
        );
        if (shared) {
          results.push(shared as KGEntity);
          for (const rel of shared.relations || []) {
            await traverse(rel.target, d - 1);
          }
        }
        return;
      }

      if (!entity) return;
      results.push(entity as KGEntity);

      for (const rel of entity.relations || []) {
        await traverse(rel.target, d - 1);
      }
    }

    await traverse(entityId, clampedDepth);
    return results;
  },
);

registerFunction(
  {
    id: "memory::evict",
    description: "Evict stale or low-importance memories",
    metadata: { category: "memory" },
  },
  async ({
    agentId,
    maxAge = 30 * 86_400_000,
    minImportance = 0.2,
    cap = 10_000,
  }) => {
    const entries: any = await trigger({
      function_id: "state::list",
      payload: { scope: `memory:${agentId}` },
    });
    const memories: MemoryEntry[] = (entries || [])
      .filter((e: any) => e.value?.content)
      .map((e: any) => e.value);

    const now = Date.now();
    let evicted = 0;

    for (const m of memories) {
      const isStale = now - m.timestamp > maxAge;
      const isLowValue = (m.importance || 0) < minImportance;

      if (isStale && isLowValue) {
        await trigger({
          function_id: "state::delete",
          payload: { scope: `memory:${agentId}`, key: m.id },
        });
        await trigger({
          function_id: "state::delete",
          payload: { scope: `memory:${agentId}`, key: m.hash },
        });
        evicted++;
      }
    }

    if (memories.length - evicted > cap) {
      const sorted = memories
        .filter(
          (m) =>
            !(
              now - m.timestamp > maxAge && (m.importance || 0) < minImportance
            ),
        )
        .sort((a, b) => (a.importance || 0) - (b.importance || 0));

      const overflow = sorted.slice(0, sorted.length - cap);
      for (const m of overflow) {
        await trigger({
          function_id: "state::delete",
          payload: { scope: `memory:${agentId}`, key: m.id },
        });
        evicted++;
      }
    }

    if (evicted > 0) {
      recordMetric("memory_operations_total", evicted, { operation: "evict" });
      log.info("Memory eviction completed", { agentId, evicted });
    }

    return { evicted };
  },
);

registerFunction(
  {
    id: "memory::user_profile::update",
    description: "Merge structured updates into agent user profile",
    metadata: { category: "memory" },
  },
  async (req: any) => {
    const { agentId, updates } = req.body || req;
    const scope = `user:profile:${agentId}`;
    const existing: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope, key: "profile" },
        }),
      null,
      { agentId, operation: "get_profile" },
    );

    const profile: Record<string, unknown> = existing || {};

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) continue;
      const prev = profile[key];
      if (Array.isArray(prev) && Array.isArray(value)) {
        profile[key] = [...prev, ...value];
      } else if (
        typeof prev === "object" &&
        prev !== null &&
        !Array.isArray(prev) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        profile[key] = { ...(prev as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        profile[key] = value;
      }
    }

    profile.updatedAt = Date.now();

    await trigger({
      function_id: "state::set",
      payload: { scope, key: "profile", value: profile },
    });

    recordMetric("memory_operations_total", 1, { operation: "profile_update" });
    return httpOk(req, { updated: true, profile });
  },
);

registerFunction(
  {
    id: "memory::user_profile::get",
    description: "Retrieve agent user profile",
    metadata: { category: "memory" },
  },
  async (req: any) => {
    const { agentId } = req.body || req;
    const profile: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `user:profile:${agentId}`, key: "profile" },
        }),
      null,
      { agentId, operation: "get_profile" },
    );
    return httpOk(req, profile || null);
  },
);

registerFunction(
  {
    id: "memory::session_search",
    description: "Keyword + recency search across memories grouped by session",
    metadata: { category: "memory" },
  },
  async (req: any) => {
    const { agentId, query, limit: rawLimit = 10 } = req.body || req;
    const limit = Math.max(1, Math.min(Number(rawLimit) || 10, 100));
    const entries: any = await trigger({
      function_id: "state::list",
      payload: { scope: `memory:${agentId}` },
    });

    const memories: MemoryEntry[] = (entries || [])
      .filter((e: any) => e.value?.content && e.value?.sessionId)
      .map((e: any) => e.value);

    if (!memories.length) return [];

    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const sessionMap = new Map<
      string,
      { matchCount: number; topScore: number; highlights: string[] }
    >();

    for (const m of memories) {
      const sid = m.sessionId!;
      const content = m.content.toLowerCase();
      const hits = keywords.filter((keyword: string) => content.includes(keyword)).length;
      if (hits === 0) continue;

      const keywordScore = hits / Math.max(keywords.length, 1);
      const ageHours = (Date.now() - m.timestamp) / 3_600_000;
      const recencyScore = Math.exp(-ageHours / 168);
      const score = keywordScore * 0.7 + recencyScore * 0.3;

      const entry = sessionMap.get(sid) || {
        matchCount: 0,
        topScore: 0,
        highlights: [],
      };
      entry.matchCount++;
      if (score > entry.topScore) entry.topScore = score;
      if (entry.highlights.length < 3) {
        entry.highlights.push(m.content.slice(0, 200));
      }
      sessionMap.set(sid, entry);
    }

    recordMetric("memory_operations_total", 1, { operation: "session_search" });

    return httpOk(req, [...sessionMap.entries()]
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.topScore - a.topScore)
      .slice(0, limit));
  },
);

registerTrigger({
  type: "http",
  function_id: "memory::user_profile::update",
  config: { api_path: "api/memory/profile/update", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "memory::user_profile::get",
  config: { api_path: "api/memory/profile/:agentId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "memory::session_search",
  config: { api_path: "api/memory/session-search", http_method: "POST" },
});

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function estimateImportance(content: string, role: string): number {
  let score = 0.5;
  if (role === "assistant") score += 0.1;
  if (content.length > 500) score += 0.1;
  if (/\b(error|bug|fix|critical|important)\b/i.test(content)) score += 0.15;
  if (/```/.test(content)) score += 0.1;
  return Math.min(1, score);
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

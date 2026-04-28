import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "knowledge-graph",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface TemporalKGEntity {
  entity: string;
  type: string;
  properties: Record<string, unknown>;
  relations: Array<{ target: string; type: string }>;
  validFrom: number;
  validUntil: number | null;
  createdAt: number;
  version: number;
  agentId: string;
}

interface TemporalAddInput {
  entity: string;
  type: string;
  properties: Record<string, unknown>;
  relations: Array<{ target: string; type: string }>;
  validFrom?: number;
  validUntil?: number;
  agentId: string;
}

interface TemporalQueryInput {
  entity: string;
  timeRange?: { from: number; to: number };
  depth?: number;
  relationFilter?: string[];
}

interface TraverseInput {
  startEntity: string;
  direction: "outgoing" | "incoming" | "both";
  maxDepth: number;
  maxNodes?: number;
}

interface DiffResult {
  added: TemporalKGEntity[];
  removed: TemporalKGEntity[];
  modified: Array<{ before: TemporalKGEntity; after: TemporalKGEntity }>;
}

registerFunction(
  {
    id: "kg::add_temporal",
    description: "Add entity with temporal metadata to knowledge graph",
    metadata: { category: "knowledge-graph" },
  },
  async (input: TemporalAddInput) => {
    const {
      entity,
      type: entityType,
      properties,
      relations,
      validFrom,
      validUntil,
      agentId,
    } = input;
    if (!entity || !agentId) return { error: "entity and agentId required" };

    const scope = `kg_temporal:${agentId}`;
    const existing: any[] = await listVersions(scope, entity);
    const version = existing.length + 1;

    const entry: TemporalKGEntity = {
      entity,
      type: entityType,
      properties: properties || {},
      relations: relations || [],
      validFrom: validFrom || Date.now(),
      validUntil: validUntil || null,
      createdAt: Date.now(),
      version,
      agentId,
    };

    await trigger({
      function_id: "state::set",
      payload: { scope, key: `${entity}:${version}`, value: entry },
    });

    await trigger({
      function_id: "state::set",
      payload: {
        scope,
        key: `${entity}:latest`,
        value: { version, key: `${entity}:${version}` },
      },
    });

    for (const rel of entry.relations) {
      const targetLatest: any = await trigger({
        function_id: "state::get",
        payload: { scope, key: `${rel.target}:latest` },
      }).catch(() => null);

      if (targetLatest) {
        const targetEntry: any = await trigger({
          function_id: "state::get",
          payload: { scope, key: targetLatest.key },
        }).catch(() => null);

        if (
          targetEntry &&
          !targetEntry.relations?.some(
            (r: any) => r.target === entity && r.type === `inverse:${rel.type}`,
          )
        ) {
          const updatedRelations = [
            ...(targetEntry.relations || []),
            { target: entity, type: `inverse:${rel.type}` },
          ];
          await trigger({
            function_id: "state::update",
            payload: {
              scope,
              key: targetLatest.key,
              operations: [
                { type: "set", path: "relations", value: updatedRelations },
              ],
            },
          });
        }
      }
    }

    return { stored: true, entity, version };
  },
);

registerFunction(
  {
    id: "kg::query_temporal",
    description: "Query knowledge graph with time range filter",
    metadata: { category: "knowledge-graph" },
  },
  async (input: TemporalQueryInput) => {
    const { entity, timeRange, depth: rawDepth, relationFilter } = input;
    if (!entity) return { error: "entity required" };

    const depth = Math.max(1, Math.min(Number(rawDepth) || 3, 10));
    const now = Date.now();
    const visited = new Set<string>();
    const results: TemporalKGEntity[] = [];

    async function bfs(startEntity: string, maxDepth: number) {
      const queue: Array<{ entityName: string; d: number }> = [
        { entityName: startEntity, d: 0 },
      ];

      while (queue.length > 0 && results.length < 500) {
        const item = queue.shift()!;
        if (item.d > maxDepth || visited.has(item.entityName)) continue;
        visited.add(item.entityName);

        const entries = await getAllEntries();
        const matching = entries.filter((e: TemporalKGEntity) => {
          if (e.entity !== item.entityName) return false;
          if (timeRange) {
            if (e.validFrom > timeRange.to) return false;
            if (e.validUntil && e.validUntil < timeRange.from) return false;
          } else {
            if (e.validUntil && e.validUntil < now) return false;
          }
          return true;
        });

        for (const m of matching) {
          results.push(m);
          if (item.d < maxDepth) {
            const filteredRels = relationFilter?.length
              ? m.relations.filter((r) => relationFilter.includes(r.type))
              : m.relations;
            for (const rel of filteredRels) {
              if (!visited.has(rel.target)) {
                queue.push({ entityName: rel.target, d: item.d + 1 });
              }
            }
          }
        }
      }
    }

    let cachedEntries: TemporalKGEntity[] | null = null;
    async function getAllEntries(): Promise<TemporalKGEntity[]> {
      if (cachedEntries) return cachedEntries;
      cachedEntries = await listAllEntries(`kg_temporal:${input.entity}`);
      return cachedEntries;
    }

    await bfs(entity, depth);
    return results;
  },
);

registerFunction(
  {
    id: "kg::traverse",
    description: "General graph traversal with direction control",
    metadata: { category: "knowledge-graph" },
  },
  async (input: TraverseInput) => {
    const {
      startEntity,
      direction,
      maxDepth: rawMaxDepth,
      maxNodes: rawMaxNodes,
    } = input;
    if (!startEntity) return { error: "startEntity required" };

    const maxDepth = Math.max(1, Math.min(Number(rawMaxDepth) || 3, 10));
    const maxNodes = Math.max(1, Math.min(Number(rawMaxNodes) || 500, 500));
    const visited = new Set<string>();
    const adjacency: Record<string, string[]> = {};
    const paths: Record<string, string[]> = {};

    const allEntries = await listAllEntries("kg_temporal:");

    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    for (const entry of allEntries) {
      for (const rel of entry.relations || []) {
        if (!outgoing.has(entry.entity)) outgoing.set(entry.entity, new Set());
        outgoing.get(entry.entity)!.add(rel.target);
        if (!incoming.has(rel.target)) incoming.set(rel.target, new Set());
        incoming.get(rel.target)!.add(entry.entity);
      }
    }

    const queue: Array<{ entity: string; depth: number; path: string[] }> = [
      { entity: startEntity, depth: 0, path: [startEntity] },
    ];

    while (queue.length > 0 && visited.size < maxNodes) {
      const { entity, depth, path } = queue.shift()!;
      if (visited.has(entity) || depth > maxDepth) continue;
      visited.add(entity);
      paths[entity] = path;

      const neighbors = new Set<string>();
      if (direction === "outgoing" || direction === "both") {
        for (const n of outgoing.get(entity) || []) neighbors.add(n);
      }
      if (direction === "incoming" || direction === "both") {
        for (const n of incoming.get(entity) || []) neighbors.add(n);
      }

      adjacency[entity] = [...neighbors];
      for (const n of neighbors) {
        if (!visited.has(n)) {
          queue.push({ entity: n, depth: depth + 1, path: [...path, n] });
        }
      }
    }

    return { adjacency, paths, nodeCount: visited.size };
  },
);

registerFunction(
  {
    id: "kg::timeline",
    description: "Get version history of an entity",
    metadata: { category: "knowledge-graph" },
  },
  async ({ entity, agentId }: { entity: string; agentId: string }) => {
    if (!entity || !agentId) return { error: "entity and agentId required" };

    const versions = await listVersions(`kg_temporal:${agentId}`, entity);
    return versions.sort((a, b) => a.createdAt - b.createdAt);
  },
);

registerFunction(
  {
    id: "kg::diff",
    description: "Compare KG entity state between two timestamps",
    metadata: { category: "knowledge-graph" },
  },
  async ({
    entity,
    agentId,
    timestamp1,
    timestamp2,
  }: {
    entity: string;
    agentId: string;
    timestamp1: number;
    timestamp2: number;
  }) => {
    if (!entity || !agentId) return { error: "entity and agentId required" };

    const versions = await listVersions(`kg_temporal:${agentId}`, entity);

    const atT1 = versions.filter((v) => v.createdAt <= timestamp1);
    const atT2 = versions.filter((v) => v.createdAt <= timestamp2);

    const t1Set = new Set(atT1.map((v) => `${v.entity}:${v.version}`));
    const t2Set = new Set(atT2.map((v) => `${v.entity}:${v.version}`));

    const added = atT2.filter((v) => !t1Set.has(`${v.entity}:${v.version}`));
    const removed = atT1.filter((v) => !t2Set.has(`${v.entity}:${v.version}`));

    const modified: DiffResult["modified"] = [];
    for (const v2 of atT2) {
      const v1 = atT1.find(
        (v) => v.entity === v2.entity && v.version === v2.version - 1,
      );
      if (
        v1 &&
        JSON.stringify(v1.properties) !== JSON.stringify(v2.properties)
      ) {
        modified.push({ before: v1, after: v2 });
      }
    }

    return { added, removed, modified } as DiffResult;
  },
);

registerFunction(
  {
    id: "kg::stats",
    description: "Get knowledge graph statistics",
    metadata: { category: "knowledge-graph" },
  },
  async ({ agentId }: { agentId: string }) => {
    if (!agentId) return { error: "agentId required" };

    const entries = await listAllEntries(`kg_temporal:${agentId}`);

    const entities = new Set(entries.map((e) => e.entity));
    let totalRelations = 0;
    const adjacency = new Map<string, Set<string>>();

    for (const entry of entries) {
      if (!adjacency.has(entry.entity)) adjacency.set(entry.entity, new Set());
      for (const rel of entry.relations || []) {
        adjacency.get(entry.entity)!.add(rel.target);
        totalRelations++;
      }
    }

    const visited = new Set<string>();
    let connectedComponents = 0;
    for (const entity of entities) {
      if (visited.has(entity)) continue;
      connectedComponents++;
      const stack = [entity];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);
        for (const neighbor of adjacency.get(node) || []) {
          if (!visited.has(neighbor)) stack.push(neighbor);
        }
      }
    }

    const totalEntities = entities.size;
    const avgDegree = totalEntities > 0 ? totalRelations / totalEntities : 0;

    return { totalEntities, totalRelations, avgDegree, connectedComponents };
  },
);

async function listAllEntries(scope: string): Promise<TemporalKGEntity[]> {
  const raw = (await trigger({
    function_id: "state::list",
    payload: { scope },
  }).catch(
    () => [],
  )) as any[];
  return (raw || [])
    .filter(
      (e: any) =>
        e.value?.entity && e.value?.version && !e.key?.endsWith(":latest"),
    )
    .map((e: any) => e.value as TemporalKGEntity);
}

async function listVersions(
  scope: string,
  entity: string,
): Promise<TemporalKGEntity[]> {
  const entries = await listAllEntries(scope);
  return entries.filter((e) => e.entity === entity);
}

registerTrigger({
  type: "http",
  function_id: "kg::add_temporal",
  config: { api_path: "api/kg/add", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "kg::query_temporal",
  config: { api_path: "api/kg/query", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "kg::traverse",
  config: { api_path: "api/kg/traverse", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "kg::timeline",
  config: { api_path: "api/kg/timeline", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "kg::diff",
  config: { api_path: "api/kg/diff", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "kg::stats",
  config: { api_path: "api/kg/stats", http_method: "POST" },
});

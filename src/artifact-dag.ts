import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { requireAuth, sanitizeId } from "@agentos/shared/utils";
import { createRecordMetric } from "@agentos/shared/metrics";
import { safeCall } from "@agentos/shared/errors";
import { createHash, randomUUID } from "node:crypto";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "artifact-dag",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const log = new Logger();
const recordMetric = createRecordMetric(triggerVoid);

const MAX_CONTENT_SIZE = 512_000;

function contentHash(content: unknown): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

registerFunction(
  {
    id: "artifact::push",
    description: "Push a content artifact as a DAG node",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const {
      agentId,
      content,
      label,
      parentIds,
      swarmId,
      metadata: extraMeta,
    } = req.body || req;

    if (!agentId || content === undefined || !label) {
      throw Object.assign(
        new Error("agentId, content, and label are required"),
        { statusCode: 400 },
      );
    }

    const contentStr =
      typeof content === "string" ? content : JSON.stringify(content);
    if (contentStr.length > MAX_CONTENT_SIZE) {
      throw Object.assign(
        new Error(`Content exceeds ${MAX_CONTENT_SIZE} byte limit`),
        { statusCode: 400 },
      );
    }

    const safeParentIds = (parentIds || []).map((id: string) => sanitizeId(id));
    for (const pid of safeParentIds) {
      const parent = await trigger({ function_id: "state::get", payload: {
        scope: "artifacts",
        key: pid,
      } });
      if (!parent) {
        throw Object.assign(new Error(`Parent artifact ${pid} not found`), {
          statusCode: 404,
        });
      }
    }

    const nodeId = randomUUID();
    const hash = contentHash(content);

    const node = {
      id: nodeId,
      agentId: sanitizeId(agentId),
      swarmId: swarmId ? sanitizeId(swarmId) : undefined,
      parentIds: safeParentIds,
      content,
      contentHash: hash,
      label,
      createdAt: Date.now(),
      metadata: extraMeta || {},
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "artifacts",
      key: nodeId,
      value: node,
    } });

    if (swarmId) {
      triggerVoid("publish", {
        topic: `artifact:${sanitizeId(swarmId)}`,
        data: { type: "artifact_pushed", nodeId, agentId: node.agentId, label },
      });
    }

    log.info("Artifact pushed", { nodeId, agentId: node.agentId, label });
    recordMetric("artifact_pushed", 1, { agentId: node.agentId }, "counter");

    return { nodeId, contentHash: hash, parentIds: safeParentIds };
  },
);

registerFunction(
  {
    id: "artifact::fetch",
    description: "Fetch an artifact node by ID",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { nodeId } = req.body || req.query || req;
    if (!nodeId) {
      throw Object.assign(new Error("nodeId is required"), {
        statusCode: 400,
      });
    }

    const node = await trigger({ function_id: "state::get", payload: {
      scope: "artifacts",
      key: sanitizeId(nodeId),
    } });
    if (!node) {
      throw Object.assign(new Error("Artifact not found"), {
        statusCode: 404,
      });
    }

    return node;
  },
);

registerFunction(
  {
    id: "artifact::children",
    description: "Get child nodes of a DAG artifact",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { nodeId } = req.body || req.query || req;
    if (!nodeId) {
      throw Object.assign(new Error("nodeId is required"), {
        statusCode: 400,
      });
    }

    const safeId = sanitizeId(nodeId);
    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "artifacts" } }),
      [],
      { operation: "list_artifacts" },
    );

    return (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter(
        (n: any) => Array.isArray(n.parentIds) && n.parentIds.includes(safeId),
      );
  },
);

registerFunction(
  {
    id: "artifact::leaves",
    description: "Find frontier artifact nodes with no children",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { swarmId, agentId } = req.body || req.query || req;

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "artifacts" } }),
      [],
      { operation: "list_artifacts" },
    );

    let nodes = (Array.isArray(all) ? all : []).map(
      (e: any) => e.value || e,
    );

    if (swarmId) {
      nodes = nodes.filter((n: any) => n.swarmId === swarmId);
    }
    if (agentId) {
      nodes = nodes.filter((n: any) => n.agentId === agentId);
    }

    const allParentIds = new Set<string>();
    for (const n of nodes) {
      for (const pid of n.parentIds || []) {
        allParentIds.add(pid);
      }
    }

    const leaves = nodes.filter((n: any) => !allParentIds.has(n.id));

    return leaves.map((n: any) => ({
      id: n.id,
      agentId: n.agentId,
      label: n.label,
      contentHash: n.contentHash,
      parentIds: n.parentIds,
      createdAt: n.createdAt,
    }));
  },
);

registerFunction(
  {
    id: "artifact::diff",
    description: "Compare two artifact nodes",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { nodeIdA, nodeIdB } = req.body || req;
    if (!nodeIdA || !nodeIdB) {
      throw Object.assign(
        new Error("nodeIdA and nodeIdB are required"),
        { statusCode: 400 },
      );
    }

    const [nodeA, nodeB] = await Promise.all([
      trigger({ function_id: "state::get", payload: {
        scope: "artifacts",
        key: sanitizeId(nodeIdA),
      } }),
      trigger({ function_id: "state::get", payload: {
        scope: "artifacts",
        key: sanitizeId(nodeIdB),
      } }),
    ]);

    if (!nodeA) {
      throw Object.assign(new Error(`Artifact ${nodeIdA} not found`), {
        statusCode: 404,
      });
    }
    if (!nodeB) {
      throw Object.assign(new Error(`Artifact ${nodeIdB} not found`), {
        statusCode: 404,
      });
    }

    const a = nodeA as any;
    const b = nodeB as any;

    const strA =
      typeof a.content === "string" ? a.content : JSON.stringify(a.content);
    const strB =
      typeof b.content === "string" ? b.content : JSON.stringify(b.content);

    return {
      nodeIdA,
      nodeIdB,
      contentMatch: a.contentHash === b.contentHash,
      sizeA: strA.length,
      sizeB: strB.length,
      agentA: a.agentId,
      agentB: b.agentId,
      createdAtA: a.createdAt,
      createdAtB: b.createdAt,
    };
  },
);

registerFunction(
  {
    id: "artifact::history",
    description: "Get all artifacts by agent or swarm",
    metadata: { category: "artifact" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, swarmId, limit } = req.body || req.query || req;

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "artifacts" } }),
      [],
      { operation: "list_artifacts" },
    );

    let nodes = (Array.isArray(all) ? all : []).map(
      (e: any) => e.value || e,
    );

    if (agentId) {
      nodes = nodes.filter((n: any) => n.agentId === agentId);
    }
    if (swarmId) {
      nodes = nodes.filter((n: any) => n.swarmId === swarmId);
    }

    nodes.sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));

    const cap = typeof limit === "number" && limit > 0 ? limit : 50;
    return nodes.slice(0, cap).map((n: any) => ({
      id: n.id,
      agentId: n.agentId,
      swarmId: n.swarmId,
      label: n.label,
      contentHash: n.contentHash,
      parentIds: n.parentIds,
      createdAt: n.createdAt,
    }));
  },
);

registerTrigger({
  type: "http",
  function_id: "artifact::push",
  config: { api_path: "api/artifact/push", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "artifact::fetch",
  config: { api_path: "api/artifact/:nodeId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "artifact::children",
  config: { api_path: "api/artifact/:nodeId/children", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "artifact::leaves",
  config: { api_path: "api/artifact/leaves", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "artifact::diff",
  config: { api_path: "api/artifact/diff", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "artifact::history",
  config: { api_path: "api/artifact/history", http_method: "GET" },
});

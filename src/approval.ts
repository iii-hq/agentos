import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { requireAuth, sanitizeId } from "./shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "approval",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  sdk.trigger({ function_id: id, payload, action: TriggerAction.Void() });

interface ApprovalRequest {
  id: string;
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  reason: string;
  createdAt: number;
  timeoutMs: number;
  status: "pending" | "approved" | "denied" | "timed_out";
  decidedBy?: string;
  decidedAt?: number;
}

const MAX_PENDING_PER_AGENT = 5;
const DEFAULT_TIMEOUT_MS = 300_000;

registerFunction(
  {
    id: "approval::check",
    description: "Check if tool requires approval and gate execution",
    metadata: { category: "approval" },
  },
  async ({ agentId, toolName, params }) => {
    const policy: any = await trigger({
      function_id: "state::get",
      payload: { scope: "approval_policy", key: "default" },
    }).catch(() => null);

    if (!policy) return { required: false };

    const requiresApproval = (policy.tools || []).some((pattern: string) => {
      if (pattern === "*") return true;
      if (pattern.endsWith("::*"))
        return toolName.startsWith(pattern.slice(0, -1));
      return toolName === pattern;
    });

    if (!requiresApproval) return { required: false };

    const pending = (await trigger({
      function_id: "state::list",
      payload: { scope: `approvals:${agentId}` },
    }).catch(() => [])) as any[];

    const pendingCount = pending.filter(
      (p: any) => p.value?.status === "pending",
    ).length;

    if (pendingCount >= MAX_PENDING_PER_AGENT) {
      throw new Error(
        `Agent ${agentId} has ${pendingCount} pending approvals (max ${MAX_PENDING_PER_AGENT})`,
      );
    }

    const requestId = crypto.randomUUID();
    const timeoutMs = policy.timeoutMs || DEFAULT_TIMEOUT_MS;

    const request: ApprovalRequest = {
      id: requestId,
      agentId,
      toolName,
      params,
      reason: `Agent ${agentId} wants to execute ${toolName}`,
      createdAt: Date.now(),
      timeoutMs,
      status: "pending",
    };

    await trigger({
      function_id: "state::set",
      payload: {
        scope: `approvals:${agentId}`,
        key: requestId,
        value: request,
      },
    });

    triggerVoid("publish", {
      topic: "approval.requested",
      data: { requestId, agentId, toolName },
    });

    return { required: true, approved: false, status: "pending", requestId };
  },
);

registerFunction(
  {
    id: "approval::decide",
    description: "Approve or deny a pending request",
    metadata: { category: "approval" },
  },
  async (req) => {
    requireAuth(req);
    const { requestId, agentId, decision, decidedBy } = req.body || req;
    const safeRequestId = sanitizeId(requestId);
    const safeAgentId = sanitizeId(agentId);
    const status = decision === "approve" ? "approved" : "denied";

    await trigger({
      function_id: "state::update",
      payload: {
        scope: `approvals:${safeAgentId}`,
        key: safeRequestId,
        operations: [
          { type: "set", path: "status", value: status },
          { type: "set", path: "decidedBy", value: decidedBy || "system" },
          { type: "set", path: "decidedAt", value: Date.now() },
        ],
      },
    });

    triggerVoid("publish", {
      topic: "approval.decided",
      data: { requestId, agentId, decision: status, decidedBy },
    });

    return { requestId, status };
  },
);

registerFunction(
  {
    id: "approval::list",
    description: "List pending approvals",
    metadata: { category: "approval" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, status: filterStatus } = req.body || req;
    if (agentId) {
      const items = (await trigger({
        function_id: "state::list",
        payload: { scope: `approvals:${agentId}` },
      }).catch(() => [])) as any[];

      return items
        .map((i: any) => i.value)
        .filter((v: any) => !filterStatus || v?.status === filterStatus);
    }

    const scopes = (await trigger({
      function_id: "state::list_groups",
      payload: {},
    }).catch(() => [])) as string[];
    const approvalScopes = scopes.filter((s) => s.startsWith("approvals:"));

    const all: ApprovalRequest[] = [];
    for (const scope of approvalScopes) {
      const items = (await trigger({
        function_id: "state::list",
        payload: { scope },
      }).catch(() => [])) as any[];
      for (const item of items) {
        if (
          item.value &&
          (!filterStatus || item.value.status === filterStatus)
        ) {
          all.push(item.value);
        }
      }
    }

    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
);

registerFunction(
  {
    id: "approval::wait",
    description: "Poll approval status (non-blocking)",
    metadata: { category: "approval" },
  },
  async (req: any) => {
    const { requestId, agentId } = req.body || req;
    const current = (await trigger({
      function_id: "state::get",
      payload: { scope: `approvals:${agentId}`, key: requestId },
    }).catch(() => null)) as ApprovalRequest | null;

    if (!current) {
      return { status: "not_found" };
    }

    if (current.status === "approved" || current.status === "denied") {
      const auditType =
        current.status === "approved" ? "approval_granted" : "approval_denied";
      triggerVoid("security::audit", {
        type: auditType,
        agentId,
        detail: {
          requestId,
          toolName: current.toolName,
          decidedBy: current.decidedBy,
        },
      });
    }

    return {
      status: current.status,
      requestId,
      ...(current.status !== "pending" ? { decision: current } : {}),
    };
  },
);

registerFunction(
  {
    id: "approval::set_policy",
    description: "Set approval policy",
    metadata: { category: "approval" },
  },
  async (req: any) => {
    requireAuth(req);
    const { tools, timeoutMs } = req.body || req;
    await trigger({
      function_id: "state::set",
      payload: {
        scope: "approval_policy",
        key: "default",
        value: { tools, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS },
      },
    });
    return { updated: true };
  },
);

registerTrigger({
  type: "http",
  function_id: "approval::list",
  config: { api_path: "api/approvals", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "approval::decide",
  config: { api_path: "api/approvals/decide", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "approval::wait",
  config: { api_path: "api/approvals/wait", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "approval::set_policy",
  config: { api_path: "api/approvals/policy", http_method: "POST" },
});

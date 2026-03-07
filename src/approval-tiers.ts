import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { requireAuth, sanitizeId } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "approval-tiers" },
);

type ApprovalTier = "auto" | "async" | "sync";

const AUTO_TOOLS = new Set([
  "tool::file_read",
  "tool::file_list",
  "tool::web_search",
  "tool::web_fetch",
  "memory::recall",
  "memory::search",
  "tool::code_analyze",
  "tool::code_explain",
  "tool::uuid_generate",
  "tool::hash_compute",
  "tool::json_parse",
  "tool::json_stringify",
  "tool::json_query",
  "tool::csv_parse",
  "tool::csv_stringify",
  "tool::yaml_parse",
  "tool::yaml_stringify",
  "tool::regex_match",
  "tool::regex_replace",
  "skill::list",
  "skill::get",
  "skill::search",
  "a2a::well_known",
  "a2a::list_cards",
]);

const ASYNC_TOOLS = new Set([
  "tool::file_write",
  "tool::apply_patch",
  "tool::code_format",
  "tool::code_lint",
  "tool::todo_create",
  "tool::todo_update",
  "tool::todo_list",
  "tool::cron_create",
  "tool::cron_list",
  "tool::cron_delete",
  "memory::store",
  "memory::forget",
  "skill::install",
  "skill::uninstall",
]);

const SYNC_TOOLS = new Set([
  "tool::shell_exec",
  "tool::agent_spawn",
  "tool::agent_send",
  "tool::agent_delegate",
  "tool::media_download",
  "tool::network_check",
  "tool::code_test",
  "tool::env_get",
  "agent::create",
  "agent::delete",
  "swarm::create",
  "swarm::dissolve",
]);

function classifyTool(toolId: string): ApprovalTier {
  if (AUTO_TOOLS.has(toolId)) return "auto";
  if (ASYNC_TOOLS.has(toolId)) return "async";
  if (SYNC_TOOLS.has(toolId)) return "sync";

  const prefix = toolId.split("::")[0];
  if (prefix === "memory" || prefix === "skill") return "auto";
  return "async";
}

registerFunction(
  {
    id: "approval::classify",
    description: "Classify a tool invocation into an approval tier",
    metadata: { category: "approval" },
  },
  async ({
    toolId,
    args,
    agentId,
  }: {
    toolId: string;
    args?: Record<string, unknown>;
    agentId?: string;
  }) => {
    let tier = classifyTool(toolId);

    if (agentId) {
      const config: any = await trigger("state::get", {
        scope: "agents",
        key: agentId,
      }).catch(() => null);

      const overrides = config?.approvalOverrides as
        | Record<string, ApprovalTier>
        | undefined;

      if (overrides?.[toolId]) {
        tier = overrides[toolId];
      }
    }

    if (toolId === "tool::shell_exec" && args?.command) {
      const cmd = String(args.command).trim().split(/\s+/)[0];
      const safeCommands = new Set([
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "grep",
        "find",
        "echo",
        "date",
        "whoami",
        "pwd",
        "which",
      ]);
      if (safeCommands.has(cmd) && tier === "sync") {
        tier = "async";
      }
    }

    return { toolId, tier };
  },
);

registerFunction(
  {
    id: "approval::decide_tier",
    description: "Route a tool call to the appropriate approval tier",
    metadata: { category: "approval" },
  },
  async ({
    toolId,
    agentId,
    args,
  }: {
    toolId: string;
    agentId: string;
    args?: Record<string, unknown>;
  }) => {
    const safeAgentId = sanitizeId(agentId);

    const classification: any = await trigger("approval::classify", {
      toolId,
      args,
      agentId: safeAgentId,
    });
    const tier: ApprovalTier = classification.tier;

    triggerVoid("security::audit", {
      type: "approval_tier_classified",
      agentId: safeAgentId,
      detail: { toolId, tier },
    });

    if (tier === "auto") {
      return { approved: true, tier, toolId };
    }

    const approvalId = crypto.randomUUID();
    await trigger("state::set", {
      scope: `tier_approvals:${safeAgentId}`,
      key: approvalId,
      value: {
        id: approvalId,
        agentId: safeAgentId,
        toolId,
        args,
        tier,
        status: "pending",
        createdAt: Date.now(),
      },
    });

    triggerVoid("publish", {
      topic: "approval.requested",
      data: { approvalId, agentId: safeAgentId, toolId, tier },
    });

    triggerVoid("stream::send", {
      stream_name: "approvals",
      group_id: "pending",
      data: { approvalId, agentId: safeAgentId, toolId, tier },
    });

    if (tier === "async") {
      return { approved: false, tier, status: "pending", approvalId };
    }

    const deadline = Date.now() + 60_000;
    let pollInterval = 500;
    while (Date.now() < deadline) {
      const current: any = await trigger("state::get", {
        scope: `tier_approvals:${safeAgentId}`,
        key: approvalId,
      }).catch(() => null);

      if (current?.status === "approved") {
        return { approved: true, tier, approvalId };
      }
      if (current?.status === "denied") {
        return { approved: false, tier, approvalId, reason: "denied" };
      }

      await new Promise((r) => setTimeout(r, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, 5000);
    }

    await trigger("state::update", {
      scope: `tier_approvals:${safeAgentId}`,
      key: approvalId,
      operations: [{ type: "set", path: "status", value: "timed_out" }],
    });

    return { approved: false, tier, approvalId, reason: "timeout" };
  },
);

registerFunction(
  {
    id: "approval::list_pending_tiers",
    description: "List pending tier-based approval requests",
    metadata: { category: "approval" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId } = req.body || req;

    if (agentId) {
      const items = (await trigger("state::list", {
        scope: `tier_approvals:${sanitizeId(agentId)}`,
      }).catch(() => [])) as any[];

      return items
        .map((i: any) => i.value)
        .filter((v: any) => v?.status === "pending")
        .sort((a: any, b: any) => b.createdAt - a.createdAt);
    }

    const scopes = (await trigger("state::list_groups", {}).catch(
      () => [],
    )) as string[];
    const tierScopes = scopes.filter((s) => s.startsWith("tier_approvals:"));

    const all: any[] = [];
    for (const scope of tierScopes) {
      const items = (await trigger("state::list", { scope }).catch(
        () => [],
      )) as any[];
      for (const item of items) {
        if (item.value?.status === "pending") {
          all.push(item.value);
        }
      }
    }

    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
);

registerFunction(
  {
    id: "approval::decide_tier_request",
    description: "Approve or deny a tier-based approval request",
    metadata: { category: "approval" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { approvalId, agentId, decision, decidedBy } = req.body || req;
    const safeApprovalId = sanitizeId(approvalId);
    const safeAgentId = sanitizeId(agentId);
    const status = decision === "approve" ? "approved" : "denied";

    await trigger("state::update", {
      scope: `tier_approvals:${safeAgentId}`,
      key: safeApprovalId,
      operations: [
        { type: "set", path: "status", value: status },
        { type: "set", path: "decidedBy", value: decidedBy || "system" },
        { type: "set", path: "decidedAt", value: Date.now() },
      ],
    });

    triggerVoid("security::audit", {
      type: `approval_tier_${status}`,
      agentId: safeAgentId,
      detail: { approvalId: safeApprovalId, decidedBy },
    });

    return { approvalId: safeApprovalId, status };
  },
);

registerTrigger({
  type: "http",
  function_id: "approval::list_pending_tiers",
  config: { api_path: "api/approvals/pending", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "approval::decide_tier_request",
  config: { api_path: "api/approvals/:id/decide", http_method: "POST" },
});

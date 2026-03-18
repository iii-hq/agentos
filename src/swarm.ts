import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { requireAuth, sanitizeId } from "./shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "swarm",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

interface SwarmConfig {
  id: string;
  goal: string;
  agentIds: string[];
  maxDurationMs: number;
  consensusThreshold: number;
  createdAt: number;
  status: "active" | "dissolved";
}

interface SwarmMessage {
  id: string;
  swarmId: string;
  agentId: string;
  message: string;
  type: "observation" | "proposal" | "vote";
  vote?: "for" | "against";
  timestamp: number;
}

const DEFAULT_MAX_DURATION_MS = 600_000;
const DEFAULT_CONSENSUS_THRESHOLD = 0.66;
const MAX_AGENTS_PER_SWARM = 20;
const MAX_MESSAGES_PER_SWARM = 500;

registerFunction(
  {
    id: "swarm::create",
    description: "Create a new decentralized agent swarm",
    metadata: { category: "swarm" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { goal, agentIds, maxDurationMs, consensusThreshold } =
      req.body || req;

    if (!goal || !agentIds?.length) {
      throw new Error("goal and agentIds are required");
    }
    if (agentIds.length > MAX_AGENTS_PER_SWARM) {
      throw new Error(`Maximum ${MAX_AGENTS_PER_SWARM} agents per swarm`);
    }

    const swarmId = crypto.randomUUID();
    const swarm: SwarmConfig = {
      id: swarmId,
      goal,
      agentIds,
      maxDurationMs: maxDurationMs || DEFAULT_MAX_DURATION_MS,
      consensusThreshold: consensusThreshold || DEFAULT_CONSENSUS_THRESHOLD,
      createdAt: Date.now(),
      status: "active",
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "swarms",
      key: swarmId,
      value: swarm,
    } });

    triggerVoid("publish", {
      topic: `swarm:${swarmId}`,
      data: {
        type: "swarm_created",
        swarmId,
        goal,
        agents: agentIds,
      },
    });

    triggerVoid("security::audit", {
      type: "swarm_created",
      detail: { swarmId, goal, agentCount: agentIds.length },
    });

    return { swarmId, agents: agentIds, createdAt: swarm.createdAt };
  },
);

registerFunction(
  {
    id: "swarm::broadcast",
    description: "Broadcast a message to all agents in a swarm",
    metadata: { category: "swarm" },
  },
  async ({
    swarmId,
    agentId,
    message,
    type,
    vote,
  }: {
    swarmId: string;
    agentId: string;
    message: string;
    type: "observation" | "proposal" | "vote";
    vote?: "for" | "against";
  }) => {
    const safeSwarmId = sanitizeId(swarmId);
    const safeAgentId = sanitizeId(agentId);

    const swarm = (await trigger({ function_id: "state::get", payload: {
      scope: "swarms",
      key: safeSwarmId,
    } }).catch(() => null)) as SwarmConfig | null;

    if (!swarm || swarm.status !== "active") {
      throw new Error(`Swarm ${safeSwarmId} not found or not active`);
    }

    if (!swarm.agentIds.includes(safeAgentId)) {
      throw new Error(
        `Agent ${safeAgentId} is not a member of swarm ${safeSwarmId}`,
      );
    }

    const existing = (await trigger({ function_id: "state::list", payload: {
      scope: `swarm_messages:${safeSwarmId}`,
    } }).catch(() => [])) as any[];
    if (existing.length >= MAX_MESSAGES_PER_SWARM) {
      throw new Error(`Swarm ${safeSwarmId} has reached the message limit`);
    }

    const msgId = crypto.randomUUID();
    const swarmMessage: SwarmMessage = {
      id: msgId,
      swarmId: safeSwarmId,
      agentId: safeAgentId,
      message,
      type,
      vote: type === "vote" ? vote : undefined,
      timestamp: Date.now(),
    };

    await trigger({ function_id: "state::set", payload: {
      scope: `swarm_messages:${safeSwarmId}`,
      key: msgId,
      value: swarmMessage,
    } });

    triggerVoid("publish", {
      topic: `swarm:${safeSwarmId}`,
      data: swarmMessage,
    });

    return { messageId: msgId, swarmId: safeSwarmId };
  },
);

registerFunction(
  {
    id: "swarm::collect",
    description: "Gather all findings from a swarm",
    metadata: { category: "swarm" },
  },
  async ({ swarmId }: { swarmId: string }) => {
    const safeSwarmId = sanitizeId(swarmId);

    const messages = (await trigger({ function_id: "state::list", payload: {
      scope: `swarm_messages:${safeSwarmId}`,
    } }).catch(() => [])) as any[];

    const items: SwarmMessage[] = messages
      .map((m: any) => m.value)
      .filter(Boolean)
      .sort((a: SwarmMessage, b: SwarmMessage) => a.timestamp - b.timestamp);

    const byAgent: Record<string, SwarmMessage[]> = {};
    for (const msg of items) {
      if (!byAgent[msg.agentId]) byAgent[msg.agentId] = [];
      byAgent[msg.agentId].push(msg);
    }

    return {
      swarmId: safeSwarmId,
      totalMessages: items.length,
      agents: byAgent,
      observations: items.filter((m) => m.type === "observation"),
      proposals: items.filter((m) => m.type === "proposal"),
      votes: items.filter((m) => m.type === "vote"),
    };
  },
);

registerFunction(
  {
    id: "swarm::consensus",
    description: "Check if a swarm has reached consensus on a proposal",
    metadata: { category: "swarm" },
  },
  async ({ swarmId, proposal }: { swarmId: string; proposal: string }) => {
    const safeSwarmId = sanitizeId(swarmId);

    const swarm = (await trigger({ function_id: "state::get", payload: {
      scope: "swarms",
      key: safeSwarmId,
    } }).catch(() => null)) as SwarmConfig | null;

    if (!swarm) throw new Error(`Swarm ${safeSwarmId} not found`);

    const messages = (await trigger({ function_id: "state::list", payload: {
      scope: `swarm_messages:${safeSwarmId}`,
    } }).catch(() => [])) as any[];

    const votes: SwarmMessage[] = messages
      .map((m: any) => m.value)
      .filter(
        (m: SwarmMessage) =>
          m?.type === "vote" && m.message.includes(proposal.slice(0, 50)),
      );

    const latestVoteByAgent = new Map<string, SwarmMessage>();
    for (const v of votes) {
      const existing = latestVoteByAgent.get(v.agentId);
      if (!existing || v.timestamp > existing.timestamp) {
        latestVoteByAgent.set(v.agentId, v);
      }
    }

    let votesFor = 0;
    let votesAgainst = 0;
    for (const v of latestVoteByAgent.values()) {
      if (v.vote === "for") votesFor++;
      else if (v.vote === "against") votesAgainst++;
    }

    const totalVoters = swarm.agentIds.length;
    const ratio = totalVoters > 0 ? votesFor / totalVoters : 0;
    const hasConsensus = ratio >= swarm.consensusThreshold;

    return {
      hasConsensus,
      votesFor,
      votesAgainst,
      threshold: swarm.consensusThreshold,
      agents: swarm.agentIds,
      totalVoters,
    };
  },
);

registerFunction(
  {
    id: "swarm::dissolve",
    description: "Dissolve a swarm and archive its findings",
    metadata: { category: "swarm" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { swarmId } = req.body || req;
    const safeSwarmId = sanitizeId(swarmId);

    const swarm = (await trigger({ function_id: "state::get", payload: {
      scope: "swarms",
      key: safeSwarmId,
    } }).catch(() => null)) as SwarmConfig | null;

    if (!swarm) throw new Error(`Swarm ${safeSwarmId} not found`);

    const findings = await trigger({ function_id: "swarm::collect", payload: { swarmId: safeSwarmId } });

    for (const agentId of swarm.agentIds) {
      const agentFindings = (findings as any).agents?.[agentId] || [];
      if (agentFindings.length > 0) {
        triggerVoid("memory::store", {
          agentId,
          sessionId: `swarm:${safeSwarmId}`,
          role: "system",
          content: `Swarm ${safeSwarmId} findings: ${JSON.stringify(agentFindings.slice(0, 10))}`,
        });
      }
    }

    await trigger({ function_id: "state::update", payload: {
      scope: "swarms",
      key: safeSwarmId,
      operations: [
        { type: "set", path: "status", value: "dissolved" },
        { type: "set", path: "dissolvedAt", value: Date.now() },
      ],
    } });

    triggerVoid("publish", {
      topic: `swarm:${safeSwarmId}`,
      data: { type: "swarm_dissolved", swarmId: safeSwarmId },
    });

    triggerVoid("security::audit", {
      type: "swarm_dissolved",
      detail: {
        swarmId: safeSwarmId,
        messageCount: (findings as any).totalMessages,
      },
    });

    return { dissolved: true, swarmId: safeSwarmId };
  },
);

registerTrigger({
  type: "http",
  function_id: "swarm::create",
  config: { api_path: "api/swarm/create", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "swarm::broadcast",
  config: { api_path: "api/swarm/:id/broadcast", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "swarm::collect",
  config: { api_path: "api/swarm/:id/status", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "swarm::consensus",
  config: { api_path: "api/swarm/:id/consensus", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "swarm::dissolve",
  config: { api_path: "api/swarm/:id/dissolve", http_method: "POST" },
});

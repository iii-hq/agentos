import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { requireAuth } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "a2a-cards",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface A2aAgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: {
    tools: string[];
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: Array<{ id: string; name: string; description: string }>;
  authentication: { schemes: string[] };
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

const API_URL = process.env.AGENTOS_API_URL || "http://localhost:3111";

registerFunction(
  {
    id: "a2a::generate_card",
    description: "Generate an A2A agent card for a specific agent",
    metadata: { category: "a2a" },
  },
  async ({ agentId }: { agentId: string }): Promise<A2aAgentCard> => {
    const config: any = await trigger({
      function_id: "state::get",
      payload: { scope: "agents", key: agentId },
    });

    if (!config) throw new Error(`Agent not found: ${agentId}`);

    const toolList = (await trigger({
      function_id: "agent::list_tools",
      payload: { agentId },
    }).catch(() => [])) as any[];
    const toolIds = toolList.map((t: any) => t.function_id || t.id);

    const skills = (await trigger({
      function_id: "state::list",
      payload: { scope: "skills" },
    }).catch(() => [])) as any[];
    const skillEntries = skills
      .map((s: any) => s.value)
      .filter(Boolean)
      .slice(0, 20)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));

    const card: A2aAgentCard = {
      name: config.name || agentId,
      description: config.description || `Agent ${agentId}`,
      url: `${API_URL}/api/a2a/agents/${agentId}`,
      capabilities: {
        tools: toolIds.slice(0, 50),
        streaming: true,
        pushNotifications: false,
      },
      skills: skillEntries,
      authentication: { schemes: ["bearer"] },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: "a2a_cards", key: agentId, value: card },
    });

    return card;
  },
);

registerFunction(
  {
    id: "a2a::list_cards",
    description: "List all A2A agent cards",
    metadata: { category: "a2a" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const agents = (await trigger({
      function_id: "state::list",
      payload: { scope: "agents" },
    }).catch(() => [])) as any[];

    const cards: A2aAgentCard[] = [];
    for (const agent of agents) {
      if (!agent.value?.id) continue;
      try {
        const card = (await trigger({
          function_id: "a2a::generate_card",
          payload: { agentId: agent.value.id },
        })) as A2aAgentCard;
        cards.push(card);
      } catch {}
    }

    return cards;
  },
);

registerFunction(
  {
    id: "a2a::well_known",
    description: "Serve the .well-known/agent.json discovery document",
    metadata: { category: "a2a" },
  },
  async () => {
    const cached: any = await trigger({
      function_id: "state::get",
      payload: { scope: "a2a_cards", key: "orchestrator" },
    }).catch(() => null);

    if (cached) return cached;

    const card: A2aAgentCard = {
      name: "agentos",
      description: "AI agent operating system with multi-agent orchestration",
      url: `${API_URL}/api/a2a/agents/orchestrator`,
      capabilities: {
        tools: [],
        streaming: true,
        pushNotifications: false,
      },
      skills: [],
      authentication: { schemes: ["bearer"] },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };

    return card;
  },
);

registerTrigger({
  type: "http",
  function_id: "a2a::list_cards",
  config: { api_path: "api/a2a/cards", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::generate_card",
  config: { api_path: "api/a2a/cards/:agentId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::well_known",
  config: { api_path: ".well-known/agent.json", http_method: "GET" },
});

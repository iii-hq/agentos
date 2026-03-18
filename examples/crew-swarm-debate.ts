import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../src/shared/config.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "crew-swarm-debate",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { trigger: rawTrigger, registerFunction, registerTrigger } = sdk;
const trigger = (id: string, payload: unknown, timeoutMs?: number) =>
  rawTrigger(
    timeoutMs !== undefined
      ? { function_id: id, payload, timeoutMs }
      : { function_id: id, payload },
  );
const LLM_TIMEOUT = 120_000;

registerFunction(
  {
    id: "crew::swarm_debate",
    description:
      "Decentralized agent debate using swarm consensus — agents deliberate and vote",
    metadata: { category: "crew" },
  },
  async ({ question }: { question: string }) => {
    const agents = ["researcher", "architect", "analyst", "security-auditor"];

    console.log(`\n--- SWARM DEBATE ---`);
    console.log(`Question: ${question}`);
    console.log(`Agents: ${agents.join(", ")}\n`);

    // Create a swarm for the debate
    const swarm: any = await trigger("swarm::create", {
      goal: question,
      agentIds: agents,
      consensusThreshold: 0.75,
    }, 30_000);
    const { swarmId } = swarm;
    console.log(`Swarm created: ${swarmId}\n`);

    // Phase 1: Each agent observes independently (parallel)
    console.log("[Phase 1] Independent observations...");
    await Promise.all(
      agents.map(async (agentId) => {
        const response = await trigger("agent::chat", {
          agentId,
          message: `Consider this question: "${question}". Provide your professional perspective in 2-3 paragraphs. Focus on your area of expertise.`,
          sessionId: `swarm:${swarmId}:${agentId}`,
        }, LLM_TIMEOUT);

        await trigger("swarm::broadcast", {
          swarmId,
          agentId,
          message: response.content,
          type: "observation",
        }, 30_000);
      }),
    );
    console.log("   All observations submitted\n");

    // Phase 2: Collect observations, then each agent proposes
    console.log("[Phase 2] Proposals based on collective observations...");
    const collected: any = await trigger("swarm::collect", { swarmId }, 30_000);
    const allObservations = collected.observations
      .map((o: any) => `[${o.agentId}]: ${o.message}`)
      .join("\n\n");

    await Promise.all(
      agents.map(async (agentId) => {
        const response = await trigger("agent::chat", {
          agentId,
          message: `Based on all team observations below, propose a final answer to: "${question}".

            Team observations:
            ${allObservations}

            Your proposal should synthesize the best ideas. Be concise (1 paragraph).`,
          sessionId: `swarm:${swarmId}:${agentId}`,
        }, LLM_TIMEOUT);

        await trigger("swarm::broadcast", {
          swarmId,
          agentId,
          message: response.content,
          type: "proposal",
        }, 30_000);
      }),
    );
    console.log("   All proposals submitted\n");

    // Phase 3: Vote on the best proposal
    console.log("[Phase 3] Voting...");
    const proposals: any = await trigger("swarm::collect", { swarmId }, 30_000);
    const proposalTexts = proposals.proposals
      .map((p: any, i: number) => `Proposal ${i + 1} [${p.agentId}]: ${p.message}`)
      .join("\n\n");

    await Promise.all(
      agents.map(async (agentId) => {
        const response = await trigger("agent::chat", {
          agentId,
          message: `Vote on the best proposal for: "${question}".

            ${proposalTexts}

            Reply with ONLY "for" if proposal 1 is best, or "against" if another is better.
            Then briefly explain your vote.`,
          sessionId: `swarm:${swarmId}:${agentId}`,
        }, LLM_TIMEOUT);

        const vote = response.content.toLowerCase().includes("for")
          ? "for"
          : "against";

        await trigger("swarm::broadcast", {
          swarmId,
          agentId,
          message: response.content,
          type: "vote",
          vote,
        }, 30_000);
      }),
    );

    // Check consensus
    const consensus: any = await trigger("swarm::consensus", { swarmId }, 30_000);
    console.log(
      `   Consensus: ${consensus.reached ? "REACHED" : "NOT REACHED"} (${(consensus.ratio * 100).toFixed(0)}%)\n`,
    );

    // Phase 4: Orchestrator produces final answer
    console.log("[Phase 4] Orchestrator synthesizing final answer...");
    const finalCollection: any = await trigger("swarm::collect", { swarmId }, 30_000);

    const synthesis = await trigger("agent::chat", {
      agentId: "orchestrator",
      message: `Synthesize this swarm debate into a definitive answer.

        Question: ${question}
        Observations: ${JSON.stringify(finalCollection.observations.map((o: any) => ({ agent: o.agentId, view: o.message.substring(0, 300) })))}
        Proposals: ${JSON.stringify(finalCollection.proposals.map((p: any) => ({ agent: p.agentId, proposal: p.message.substring(0, 300) })))}
        Votes: ${JSON.stringify(finalCollection.votes.map((v: any) => ({ agent: v.agentId, vote: v.vote })))}
        Consensus: ${consensus.reached ? "Reached" : "Not reached"} (${(consensus.ratio * 100).toFixed(0)}%)

        Produce a clear, well-reasoned final answer.`,
      sessionId: `swarm:${swarmId}:synthesis`,
    }, LLM_TIMEOUT);

    // Dissolve the swarm
    await trigger("swarm::dissolve", { swarmId }, 30_000).catch(() => {});

    console.log(`--- SWARM DEBATE COMPLETE ---\n`);

    return {
      question,
      swarmId,
      consensus: { reached: consensus.reached, ratio: consensus.ratio },
      finalAnswer: synthesis.content,
      agentsUsed: agents.length + 1,
      phases: 4,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "crew::swarm_debate",
  config: { api_path: "/crew/debate", http_method: "POST" },
});

console.log("Crew: Swarm Debate ready");
console.log("POST /crew/debate { question: '...' }");

import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../src/shared/config.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "crew-startup-analyzer",
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
    id: "crew::startup_analyzer",
    description:
      "CrewAI-style crew that analyzes a startup idea from multiple angles in parallel",
    metadata: { category: "crew" },
  },
  async ({
    idea,
    industry,
  }: {
    idea: string;
    industry?: string;
  }) => {
    const startTime = Date.now();

    console.log(`\n--- CREW: Startup Analyzer ---`);
    console.log(`Idea: ${idea}\n`);

    // Phase 1: Parallel research from 3 specialist agents
    console.log("[Phase 1] Running parallel analysis...");

    const [marketResearch, techFeasibility, financialAnalysis] =
      await Promise.all([
        // Agent 1: Researcher analyzes market
        trigger("agent::chat", {
          agentId: "researcher",
          message: `Analyze the market opportunity for this startup idea: "${idea}"${industry ? ` in the ${industry} industry` : ""}.
          Cover: market size (TAM/SAM/SOM), growth rate, key competitors, target customer segments, and market gaps.
          Be specific with numbers where possible.`,
          sessionId: `crew:startup:market:${Date.now()}`,
        }, LLM_TIMEOUT),

        trigger("agent::chat", {
          agentId: "architect",
          message: `Evaluate the technical feasibility of: "${idea}".
          Cover: required tech stack, development complexity (1-10), key technical risks,
          estimated team size, MVP timeline, and scalability considerations.
          Rate overall technical feasibility: Low / Medium / High.`,
          sessionId: `crew:startup:tech:${Date.now()}`,
        }, LLM_TIMEOUT),

        trigger("agent::chat", {
          agentId: "analyst",
          message: `Create a high-level financial analysis for: "${idea}".
          Cover: revenue model options, pricing strategy, unit economics,
          estimated burn rate for first year, funding requirements,
          and path to profitability. Include rough projections.`,
          sessionId: `crew:startup:finance:${Date.now()}`,
        }, LLM_TIMEOUT),
      ]);

    console.log("   Market research done");
    console.log("   Tech feasibility done");
    console.log("   Financial analysis done\n");

    // Phase 2: Orchestrator synthesizes all findings
    console.log("[Phase 2] Orchestrator synthesizing findings...");

    const synthesis: any = await trigger("agent::chat", {
      agentId: "orchestrator",
      message: `Synthesize these three analyses of the startup idea "${idea}" into a cohesive investment memo.

        MARKET RESEARCH:
        ${marketResearch.content}

        TECHNICAL FEASIBILITY:
        ${techFeasibility.content}

        FINANCIAL ANALYSIS:
        ${financialAnalysis.content}

        Produce a structured memo with:
        1. Executive Summary (2-3 sentences)
        2. Overall Score (1-10) with justification
        3. Top 3 Strengths
        4. Top 3 Risks
        5. Go/No-Go Recommendation with conditions
        6. Suggested Next Steps`,
      sessionId: `crew:startup:synthesis:${Date.now()}`,
    }, LLM_TIMEOUT);

    console.log("   Synthesis complete\n");

    // Phase 3: Security auditor checks for regulatory/compliance risks
    console.log("[Phase 3] Security review...");

    const securityReview: any = await trigger("agent::chat", {
      agentId: "security-auditor",
      message: `Review this startup idea for regulatory, compliance, and security risks: "${idea}".
        Consider: data privacy (GDPR/CCPA), industry regulations, IP concerns,
        security requirements, and liability exposure.
        Rate risk level: Low / Medium / High / Critical.`,
      sessionId: `crew:startup:security:${Date.now()}`,
    }, LLM_TIMEOUT);

    console.log("   Security review complete\n");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`--- CREW COMPLETE (${elapsed}s) ---`);
    console.log(`   3 parallel analyses + 1 synthesis + 1 security review\n`);

    return {
      idea,
      industry: industry || "general",
      analyses: {
        market: marketResearch.content,
        technical: techFeasibility.content,
        financial: financialAnalysis.content,
        security: securityReview.content,
      },
      synthesis: synthesis.content,
      durationSeconds: parseFloat(elapsed),
      agentsUsed: [
        "researcher",
        "architect",
        "analyst",
        "orchestrator",
        "security-auditor",
      ],
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "crew::startup_analyzer",
  config: { api_path: "/crew/startup", http_method: "POST" },
});

console.log("Crew: Startup Analyzer ready");
console.log("POST /crew/startup { idea: '...', industry: '...' }");

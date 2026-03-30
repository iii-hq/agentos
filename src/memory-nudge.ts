import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { stripCodeFences } from "./shared/utils.js";

const log = createLogger("memory-nudge");

const sdk = registerWorker(ENGINE_URL, {
  workerName: "memory-nudge",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const NUDGE_INTERVAL = 5;

registerFunction(
  {
    id: "nudge::check_turn",
    description: "Increment turn counter, decide whether to trigger review",
    metadata: { category: "nudge" },
  },
  async ({
    agentId,
    sessionId,
    iterations = 0,
  }: {
    agentId: string;
    sessionId: string;
    iterations?: number;
  }) => {
    const scope = `nudge:${agentId}`;
    const key = sessionId || "default";

    const updated: any = await trigger({
      function_id: "state::update",
      payload: {
        scope,
        key,
        operations: [{ type: "increment", path: "turnCount", value: 1 }],
      },
    });

    const turnCount = updated?.turnCount || 1;
    const shouldReview = turnCount % NUDGE_INTERVAL === 0;
    const shouldReviewSkills = iterations >= 5;

    if (shouldReview) {
      triggerVoid("nudge::review_memory", { agentId, sessionId });
    }
    if (shouldReviewSkills) {
      triggerVoid("nudge::review_skills", { agentId, sessionId, iterations });
    }

    return { shouldReview, shouldReviewSkills, turnCount };
  },
);

registerFunction(
  {
    id: "nudge::review_memory",
    description: "LLM reviews conversation, extracts durable facts for memory",
    metadata: { category: "nudge" },
  },
  async ({
    agentId,
    sessionId,
  }: {
    agentId: string;
    sessionId: string;
  }) => {
    const memories: any = await trigger({
      function_id: "memory::recall",
      payload: { agentId, query: "recent conversation context", limit: 30 },
    }).catch(() => []);

    if (!memories?.length) return { saved: 0 };

    const recentContext = (memories || [])
      .slice(-20)
      .map((m: any) => `[${m.role}]: ${(m.content || "").slice(0, 500)}`)
      .join("\n\n");

    const existingSummary: any = await trigger({
      function_id: "state::get",
      payload: { scope: `nudge:summary:${agentId}`, key: sessionId },
    }).catch(() => null);

    const existingBlock = existingSummary?.facts
      ? `\nEXISTING EXTRACTED FACTS (focus on NEW facts not already captured):\n${existingSummary.facts.map((f: any) => `- ${f.content}`).join("\n")}\n`
      : "";

    const prompt = `Review this conversation and extract durable facts worth remembering.
${existingBlock}
CONVERSATION:
${recentContext}

Return a JSON object:
{
  "facts": [{"content": "...", "importance": 0.0-1.0, "category": "preference|decision|learning|context"}],
  "profileUpdates": {"preferences": {}, "workStyle": "...", "communicationStyle": "..."} or null
}

Only include facts useful in future conversations. importance >= 0.5 to be stored.`;

    let llmResult: any;
    try {
      llmResult = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            maxTokens: 1024,
          },
          systemPrompt:
            "You are a memory curator. Extract durable facts from conversations. Output only JSON.",
          messages: [{ role: "user", content: prompt }],
        },
      });
    } catch {
      return { saved: 0 };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stripCodeFences(llmResult?.content || "{}"));
    } catch {
      return { saved: 0 };
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    let saved = 0;
    for (const fact of facts) {
      if (!fact.content || (fact.importance || 0) < 0.5) continue;
      triggerVoid("memory::store", {
        agentId,
        sessionId,
        role: "system",
        content: `[Nudge Fact] ${fact.content}`,
      });
      saved++;
    }

    await trigger({
      function_id: "state::set",
      payload: {
        scope: `nudge:summary:${agentId}`,
        key: sessionId,
        value: { facts, updatedAt: Date.now() },
      },
    });

    if (parsed.profileUpdates) {
      triggerVoid("memory::user_profile::update", {
        agentId,
        updates: parsed.profileUpdates,
      });
    }

    recordMetric("nudge_reviews_total", 1, {
      type: "memory",
      saved: String(saved),
    });
    log.info("Nudge memory review completed", { agentId, saved });

    return { saved, totalFacts: facts.length };
  },
);

registerFunction(
  {
    id: "nudge::review_skills",
    description:
      "Check if conversation yielded a reusable skill via evolve::generate",
    metadata: { category: "nudge" },
  },
  async ({
    agentId,
    sessionId,
    iterations = 0,
  }: {
    agentId: string;
    sessionId: string;
    iterations?: number;
  }) => {
    if (iterations < 5) return { created: false };

    const memories: any = await trigger({
      function_id: "memory::recall",
      payload: { agentId, query: "tools used complex workflow", limit: 30 },
    }).catch(() => []);

    if (!memories?.length) return { created: false };

    const recentContext = (memories || [])
      .slice(-30)
      .map((m: any) => `[${m.role}]: ${(m.content || "").slice(0, 500)}`)
      .join("\n\n");

    let llmResult: any;
    try {
      llmResult = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            maxTokens: 1024,
          },
          systemPrompt:
            "You are a skill curator. Identify reusable patterns. Output only JSON.",
          messages: [
            {
              role: "user",
              content: `This session used ${iterations} tool iterations. Review the conversation:

${recentContext}

Was a non-trivial approach used that required trial and error?
If a reusable function should be created, output:
{"shouldCreate": true, "name": "...", "goal": "...", "spec": "..."}
Otherwise output: {"shouldCreate": false}`,
            },
          ],
        },
      });
    } catch {
      return { created: false };
    }

    try {
      const result = JSON.parse(
        stripCodeFences(llmResult?.content || "{}"),
      );
      if (result.shouldCreate && result.name && result.goal) {
        triggerVoid("evolve::generate", {
          goal: result.goal,
          spec: result.spec || "",
          name: result.name,
          agentId,
          metadata: {
            source: "auto_nudge",
            sessionId,
            iterations,
          },
        });
        recordMetric("nudge_reviews_total", 1, { type: "skill", created: "true" });
        log.info("Nudge triggered skill creation", {
          agentId,
          name: result.name,
        });
        return { created: true, name: result.name };
      }
    } catch {}

    return { created: false };
  },
);

registerTrigger({
  type: "http",
  function_id: "nudge::check_turn",
  config: { api_path: "api/nudge/check", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "nudge::review_memory",
  config: { api_path: "api/nudge/review-memory", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "nudge::review_skills",
  config: { api_path: "api/nudge/review-skills", http_method: "POST" },
});

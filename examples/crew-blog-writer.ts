import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../src/shared/config.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "crew-blog-writer",
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

interface CrewResult {
  research: string;
  draft: string;
  review: string;
  finalArticle: string;
}

registerFunction(
  {
    id: "crew::blog_writer",
    description: "CrewAI-style multi-agent blog writing pipeline",
    metadata: { category: "crew" },
  },
  async ({ topic, audience }: { topic: string; audience?: string }) => {
    const targetAudience = audience || "technical developers";
    const startTime = Date.now();

    console.log(`\n--- CREW: Blog Writer ---`);
    console.log(`Topic: ${topic}`);
    console.log(`Audience: ${targetAudience}\n`);

    // Step 1: Researcher gathers information
    console.log("[1/4] Researcher agent gathering information...");
    const research = await trigger("agent::chat", {
      agentId: "researcher",
      message: `Research the topic "${topic}" for a blog post targeting ${targetAudience}.
        Provide:
        - Key facts and statistics
        - Current trends and developments
        - Expert opinions or notable quotes
        - Potential angles for the article
        Format as structured research notes.`,
      sessionId: `crew:blog:${Date.now()}`,
    }, LLM_TIMEOUT);
    console.log(`   Research complete (${research.content.length} chars)\n`);

    // Step 2: Writer drafts the article using research
    console.log("[2/4] Writer agent drafting article...");
    const draft = await trigger("agent::chat", {
      agentId: "writer",
      message: `Write a blog post about "${topic}" for ${targetAudience}.

        Use this research:
        ${research.content}

        Requirements:
        - Engaging hook in the first paragraph
        - 800-1200 words
        - Clear section headers
        - Actionable takeaways
        - Professional but conversational tone`,
      sessionId: `crew:blog:${Date.now()}`,
    }, LLM_TIMEOUT);
    console.log(`   Draft complete (${draft.content.length} chars)\n`);

    // Step 3: Code Reviewer checks quality (acting as editor)
    console.log("[3/4] Editor agent reviewing draft...");
    const review = await trigger("agent::chat", {
      agentId: "code-reviewer",
      message: `Review this blog post as an editor. Check for:
        - Factual accuracy against the research
        - Clarity and flow
        - Grammar and style
        - Missing sections or weak arguments
        - SEO considerations

        Research notes:
        ${research.content.substring(0, 2000)}

        Draft to review:
        ${draft.content}

        Provide specific, actionable feedback. If the draft is good, say "APPROVED" at the end.`,
      sessionId: `crew:blog:${Date.now()}`,
    }, LLM_TIMEOUT);
    console.log(`   Review complete\n`);

    // Step 4: Writer revises based on feedback (if needed)
    const needsRevision = !review.content.includes("APPROVED");

    let finalArticle: string;
    if (needsRevision) {
      console.log("[4/4] Writer agent revising based on feedback...");
      const revision = await trigger("agent::chat", {
        agentId: "writer",
        message: `Revise this blog post based on editor feedback.

          Original draft:
          ${draft.content}

          Editor feedback:
          ${review.content}

          Apply all feedback and produce the final version.`,
        sessionId: `crew:blog:${Date.now()}`,
      }, LLM_TIMEOUT);
      finalArticle = revision.content;
      console.log(`   Revision complete\n`);
    } else {
      finalArticle = draft.content;
      console.log("[4/4] Draft approved, no revision needed\n");
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`--- CREW COMPLETE (${elapsed}s) ---\n`);

    // Store in shared memory for other agents
    await trigger("memory::store", {
      agentId: "crew:blog-writer",
      content: `Blog post about "${topic}": ${finalArticle.substring(0, 500)}...`,
      role: "assistant",
    }, LLM_TIMEOUT).catch(() => {});

    return {
      topic,
      audience: targetAudience,
      research: research.content,
      draft: draft.content,
      review: review.content,
      finalArticle,
      revised: needsRevision,
      durationSeconds: parseFloat(elapsed),
    };
  },
);

// Expose via HTTP trigger for easy testing
registerTrigger({
  type: "http",
  function_id: "crew::blog_writer",
  config: { api_path: "/crew/blog", http_method: "POST" },
});

console.log("Crew: Blog Writer ready");
console.log("POST /crew/blog { topic: '...', audience: '...' }");

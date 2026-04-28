import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import type { Message } from "@agentos/shared/tokens";
import { estimateTokens, estimateMessagesTokens } from "@agentos/shared/tokens";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "context-manager",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface BudgetAllocation {
  systemPrompt: number;
  skills: number;
  memories: number;
  conversation: number;
}

interface ContextBudget {
  total: number;
  used: number;
  remaining: number;
  allocation: BudgetAllocation;
  sections: Record<
    string,
    { allocated: number; used: number; remaining: number }
  >;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_ALLOCATION: BudgetAllocation = {
  systemPrompt: 0.2,
  skills: 0.15,
  memories: 0.25,
  conversation: 0.4,
};

function budgetSection(total: number, ratio: number, used: number) {
  const allocated = Math.floor(total * ratio);
  return { allocated, used, remaining: Math.max(0, allocated - used) };
}

registerFunction(
  { id: "context::estimate_tokens", description: "Rough token estimation" },
  async ({ text }: { text: string }) => {
    return { tokens: estimateTokens(text), characters: text.length };
  },
);

registerFunction(
  {
    id: "context::budget",
    description: "Calculate remaining context budget for an agent",
  },
  async ({
    agentId,
    systemPrompt,
    skills,
    memories,
    conversation,
    contextWindow,
  }: {
    agentId: string;
    systemPrompt?: string;
    skills?: string[];
    memories?: string[];
    conversation?: Message[];
    contextWindow?: number;
  }) => {
    const total = contextWindow || DEFAULT_CONTEXT_WINDOW;
    const alloc = { ...DEFAULT_ALLOCATION };

    const config: any = await trigger({
      function_id: "state::get",
      payload: { scope: "agents", key: agentId },
    }).catch(() => null);

    if (config?.resources?.maxTokensPerHour) {
      const effectiveWindow = Math.min(
        total,
        config.resources.maxTokensPerHour,
      );
      if (effectiveWindow < total) {
        const ratio = effectiveWindow / total;
        alloc.systemPrompt *= ratio;
        alloc.skills *= ratio;
        alloc.memories *= ratio;
        alloc.conversation *= ratio;
      }
    }

    const systemTokens = estimateTokens(
      systemPrompt || config?.systemPrompt || "",
    );
    const skillsTokens = (skills || []).reduce(
      (sum, s) => sum + estimateTokens(s),
      0,
    );
    const memoriesTokens = (memories || []).reduce(
      (sum, m) => sum + estimateTokens(m),
      0,
    );
    const conversationTokens = estimateMessagesTokens(conversation || []);

    const used =
      systemTokens + skillsTokens + memoriesTokens + conversationTokens;

    const budget: ContextBudget = {
      total,
      used,
      remaining: Math.max(0, total - used),
      allocation: alloc,
      sections: {
        systemPrompt: budgetSection(total, alloc.systemPrompt, systemTokens),
        skills: budgetSection(total, alloc.skills, skillsTokens),
        memories: budgetSection(total, alloc.memories, memoriesTokens),
        conversation: budgetSection(
          total,
          alloc.conversation,
          conversationTokens,
        ),
      },
    };

    return budget;
  },
);

registerFunction(
  {
    id: "context::trim",
    description: "Trim conversation to fit within budget",
  },
  async ({
    conversation,
    maxTokens,
    keepLastN,
  }: {
    conversation: Message[];
    maxTokens: number;
    keepLastN?: number;
  }) => {
    if (!conversation.length) return { messages: [], trimmed: 0 };

    const lastN = keepLastN || 10;
    const totalTokens = estimateMessagesTokens(conversation);

    if (totalTokens <= maxTokens) {
      return { messages: conversation, trimmed: 0, tokens: totalTokens };
    }

    const first = conversation[0]?.role === "system" ? [conversation[0]] : [];
    const tail = conversation.slice(-lastN);
    const firstTokens = estimateMessagesTokens(first);
    const tailTokens = estimateMessagesTokens(tail);

    if (firstTokens + tailTokens > maxTokens) {
      const trimmedTail: Message[] = [];
      let budget = maxTokens - firstTokens;
      for (let i = tail.length - 1; i >= 0 && budget > 0; i--) {
        const msgTokens = estimateTokens(tail[i].content || "");
        if (msgTokens <= budget) {
          trimmedTail.unshift(tail[i]);
          budget -= msgTokens;
        } else {
          const truncated = [...tail[i].content].slice(0, budget * 4).join("");
          trimmedTail.unshift({ ...tail[i], content: truncated });
          break;
        }
      }

      return {
        messages: [...first, ...trimmedTail],
        trimmed: conversation.length - first.length - trimmedTail.length,
        tokens: estimateMessagesTokens([...first, ...trimmedTail]),
      };
    }

    const result = [...first, ...tail];
    return {
      messages: result,
      trimmed: conversation.length - result.length,
      tokens: firstTokens + tailTokens,
    };
  },
);

registerFunction(
  {
    id: "context::overflow_recover",
    description: "Multi-stage overflow recovery",
  },
  async ({
    conversation,
    maxTokens,
  }: {
    conversation: Message[];
    maxTokens: number;
  }) => {
    let messages = [...conversation];
    let currentTokens = estimateMessagesTokens(messages);
    const stages: string[] = [];

    if (currentTokens <= maxTokens) {
      return { messages, stages: ["no_action_needed"], tokens: currentTokens };
    }

    const recentThreshold = Math.max(0, messages.length - 10);
    for (let i = 0; i < recentThreshold; i++) {
      if (messages[i].toolResults) {
        messages[i] = { ...messages[i], toolResults: undefined };
      }
    }
    currentTokens = estimateMessagesTokens(messages);
    stages.push("stage1_remove_old_tool_results");

    if (currentTokens <= maxTokens) {
      return { messages, stages, tokens: currentTokens };
    }

    const summaryThreshold = Math.max(1, messages.length - 15);
    const toSummarize = messages.slice(0, summaryThreshold);
    const kept = messages.slice(summaryThreshold);

    if (toSummarize.length > 0) {
      const summaryText = toSummarize
        .filter((m) => m.content)
        .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
        .join("\n");

      const summary: Message = {
        role: "system",
        content: `[Conversation summary - ${toSummarize.length} messages condensed]\n${summaryText.slice(0, 2000)}`,
      };

      messages = [summary, ...kept];
      currentTokens = estimateMessagesTokens(messages);
      stages.push("stage2_summarize_old_messages");
    }

    if (currentTokens <= maxTokens) {
      return { messages, stages, tokens: currentTokens };
    }

    messages = messages.filter(
      (m) =>
        !(
          m.role === "system" &&
          m.importance !== undefined &&
          m.importance < 3
        ),
    );
    currentTokens = estimateMessagesTokens(messages);
    stages.push("stage3_drop_low_importance");

    if (currentTokens <= maxTokens) {
      return { messages, stages, tokens: currentTokens };
    }

    const trimResult: any = await trigger({
      function_id: "context::trim",
      payload: { conversation: messages, maxTokens, keepLastN: 5 },
    });

    stages.push("stage4_emergency_truncation");

    return {
      messages: trimResult.messages,
      stages,
      tokens: estimateMessagesTokens(trimResult.messages),
    };
  },
);

registerFunction(
  {
    id: "context::build_prompt",
    description: "Assemble full prompt within budget",
  },
  async ({
    agentId,
    systemPrompt,
    skillIds,
    memories,
    conversation,
    contextWindow,
  }: {
    agentId: string;
    systemPrompt?: string;
    skillIds?: string[];
    memories?: string[];
    conversation?: Message[];
    contextWindow?: number;
  }) => {
    const total = contextWindow || DEFAULT_CONTEXT_WINDOW;
    const alloc = { ...DEFAULT_ALLOCATION };

    const systemBudget = Math.floor(total * alloc.systemPrompt);
    const skillsBudget = Math.floor(total * alloc.skills);
    const memoriesBudget = Math.floor(total * alloc.memories);
    const conversationBudget = Math.floor(total * alloc.conversation);

    let system = systemPrompt || "";
    if (!system) {
      const config: any = await trigger({
        function_id: "state::get",
        payload: { scope: "agents", key: agentId },
      }).catch(() => null);
      system = config?.systemPrompt || "You are a helpful AI assistant.";
    }

    const systemTokens = estimateTokens(system);
    if (systemTokens > systemBudget) {
      system = [...system].slice(0, systemBudget * 4).join("");
    }

    let skillsContent = "";
    let skillsTokens = 0;
    if (skillIds?.length) {
      for (const sid of skillIds) {
        const skill: any = await trigger({
          function_id: "skill::get",
          payload: { id: sid },
        }).catch(() => null);
        if (!skill?.content) continue;

        const additional = estimateTokens(skill.content);
        if (skillsTokens + additional > skillsBudget) break;

        skillsContent += `\n---\n[Skill: ${skill.name}]\n${skill.content}`;
        skillsTokens += additional;
      }
    }

    let memoriesContent = "";
    let memoriesTokensUsed = 0;
    if (memories?.length) {
      for (const mem of memories) {
        const additional = estimateTokens(mem);
        if (memoriesTokensUsed + additional > memoriesBudget) break;

        memoriesContent += `\n${mem}`;
        memoriesTokensUsed += additional;
      }
    }

    let trimmedConversation = conversation || [];
    if (estimateMessagesTokens(trimmedConversation) > conversationBudget) {
      const result: any = await trigger({
        function_id: "context::trim",
        payload: { conversation: trimmedConversation, maxTokens: conversationBudget },
      });
      trimmedConversation = result.messages;
    }

    const fullPrompt: Message[] = [];

    let systemMessage = system;
    if (skillsContent)
      systemMessage += `\n\n## Active Skills\n${skillsContent}`;
    if (memoriesContent)
      systemMessage += `\n\n## Relevant Memories\n${memoriesContent}`;

    fullPrompt.push({ role: "system", content: systemMessage });
    fullPrompt.push(...trimmedConversation);

    const finalTokens = estimateMessagesTokens(fullPrompt);

    return {
      messages: fullPrompt,
      tokens: finalTokens,
      budget: total,
      remaining: total - finalTokens,
      sections: {
        system: estimateTokens(system),
        skills: skillsTokens,
        memories: memoriesTokensUsed,
        conversation: estimateMessagesTokens(trimmedConversation),
      },
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "context::budget",
  config: { api_path: "api/context/budget", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::trim",
  config: { api_path: "api/context/trim", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::overflow_recover",
  config: { api_path: "api/context/recover", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::build_prompt",
  config: { api_path: "api/context/build", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "context::estimate_tokens",
  config: { api_path: "api/context/tokens", http_method: "POST" },
});

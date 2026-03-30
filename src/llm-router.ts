import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { PRICING } from "./shared/pricing.js";
import Anthropic from "@anthropic-ai/sdk";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "llm-router",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, trigger } = sdk;

interface ModelSelection {
  provider: string;
  model: string;
  maxTokens: number;
}

interface CompleteRequest {
  model: ModelSelection;
  systemPrompt?: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ id: string; description?: string }>;
  toolResults?: Array<{ toolCallId: string; output: unknown }>;
}

const PROVIDER_CONFIGS: Record<string, { baseUrl: string; envKey: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
  },
  groq: { baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
  },
  mistral: { baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY" },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
  },
  ollama: { baseUrl: "http://localhost:11434/v1", envKey: "OLLAMA_API_KEY" },
  vllm: { baseUrl: "http://localhost:8000/v1", envKey: "VLLM_API_KEY" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", envKey: "LMSTUDIO_API_KEY" },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    envKey: "PERPLEXITY_API_KEY",
  },
  cohere: { baseUrl: "https://api.cohere.ai/v1", envKey: "COHERE_API_KEY" },
  ai21: { baseUrl: "https://api.ai21.com/studio/v1", envKey: "AI21_API_KEY" },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
  },
  sambanova: {
    baseUrl: "https://api.sambanova.ai/v1",
    envKey: "SAMBANOVA_API_KEY",
  },
  huggingface: {
    baseUrl: "https://api-inference.huggingface.co",
    envKey: "HF_API_KEY",
  },
  xai: { baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY" },
  replicate: {
    baseUrl: "https://api.replicate.com/v1",
    envKey: "REPLICATE_API_TOKEN",
  },
  github_copilot: {
    baseUrl: "https://api.githubcopilot.com",
    envKey: "GITHUB_TOKEN",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
  },
  minimax: {
    baseUrl: "https://api.minimax.chat/v1",
    envKey: "MINIMAX_API_KEY",
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKey: "ZHIPU_API_KEY",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    envKey: "MOONSHOT_API_KEY",
  },
  baidu: {
    baseUrl: "https://aip.baidubce.com/rpc/2.0",
    envKey: "QIANFAN_API_KEY",
  },
};

const PROVIDERS: Record<string, (req: CompleteRequest) => Promise<any>> = {
  anthropic: callAnthropic,
  bedrock: callAnthropic,
  ...Object.fromEntries(
    Object.keys(PROVIDER_CONFIGS).map((id) => [
      id,
      (req: CompleteRequest) => callOpenAICompat(req, id),
    ]),
  ),
};

registerFunction(
  { id: "llm::route", description: "Select optimal model by query complexity" },
  async ({ message, toolCount, config, agentTier }): Promise<ModelSelection> => {
    if (config?.model) {
      return {
        provider: config.provider || "anthropic",
        model: config.model,
        maxTokens: config.maxTokens || 4096,
      };
    }

    const score = scoreComplexity(message, toolCount || 0);

    if (agentTier === "economy") {
      return {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        maxTokens: 2048,
      };
    }

    if (agentTier === "premium") {
      if (score >= 0.5) {
        return { provider: "anthropic", model: "claude-opus-4-6", maxTokens: 8192 };
      }
      return {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
      };
    }

    if (score < 0.3) {
      return {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        maxTokens: 2048,
      };
    }
    if (score < 0.7) {
      return {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
      };
    }
    return { provider: "anthropic", model: "claude-opus-4-6", maxTokens: 8192 };
  },
);

registerFunction(
  {
    id: "llm::complete",
    description: "Call LLM with automatic fallback and cost tracking",
  },
  async (req: CompleteRequest) => {
    const { provider } = req.model;
    const callProvider = PROVIDERS[provider];
    if (!callProvider) throw new Error(`Unknown provider: ${provider}`);

    const startMs = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await callProvider(req);
        const durationMs = Date.now() - startMs;

        const pricing = PRICING[req.model.model];
        if (pricing && result.usage) {
          const cost =
            (result.usage.input * pricing.input) / 1_000_000 +
            (result.usage.output * pricing.output) / 1_000_000;

          trigger({
            function_id: "state::update",
            payload: {
              scope: "costs",
              key: new Date().toISOString().slice(0, 10),
              operations: [
                {
                  type: "increment",
                  path: `${req.model.model}.cost`,
                  value: cost,
                },
                { type: "increment", path: `${req.model.model}.calls`, value: 1 },
                { type: "increment", path: "totalCost", value: cost },
              ],
            },
            action: TriggerAction.Void(),
          });
        }

        return { ...result, durationMs };
      } catch (err: any) {
        lastError = err;
        if (err.status === 429) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  },
);

async function callAnthropic(req: CompleteRequest) {
  const client = new Anthropic();

  const tools = req.tools?.map((t) => ({
    name: t.id.replace(/::/g, "_"),
    description: t.description || t.id,
    input_schema: { type: "object" as const, properties: {} },
  }));

  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  if (req.toolResults?.length) {
    for (const tr of req.toolResults) {
      messages.push({
        role: "user",
        content: JSON.stringify({
          tool_use_id: tr.toolCallId,
          output: tr.output,
        }),
      });
    }
  }

  const response = await client.messages.create({
    model: req.model.model,
    max_tokens: req.model.maxTokens,
    system: req.systemPrompt || "",
    messages,
    ...(tools?.length ? { tools } : {}),
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const toolBlocks = response.content.filter((b) => b.type === "tool_use");

  return {
    content: textBlock ? (textBlock as any).text : "",
    model: response.model,
    toolCalls: toolBlocks.map((b: any) => ({
      callId: b.id,
      id: b.name.replace(/_/g, "::"),
      arguments: b.input,
    })),
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      total: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

async function callOpenAICompat(req: CompleteRequest, providerId: string) {
  const config = PROVIDER_CONFIGS[providerId];
  if (!config) throw new Error(`No config for provider: ${providerId}`);

  const apiKey = process.env[config.envKey] || "";

  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) {
    messages.push({ role: "system", content: req.systemPrompt });
  }
  for (const m of req.messages) {
    messages.push({ role: m.role, content: m.content });
  }
  if (req.toolResults?.length) {
    for (const tr of req.toolResults) {
      messages.push({
        role: "user",
        content: JSON.stringify({
          tool_call_id: tr.toolCallId,
          output: tr.output,
        }),
      });
    }
  }

  const body: Record<string, unknown> = {
    model: req.model.model,
    max_tokens: req.model.maxTokens,
    messages,
  };

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.id.replace(/::/g, "_"),
        description: t.description || t.id,
        parameters: { type: "object", properties: {} },
      },
    }));
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const url = `${config.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err: any = new Error(
      `${providerId} API error ${resp.status}: ${text.slice(0, 500)}`,
    );
    err.status = resp.status;
    throw err;
  }

  const data: any = await resp.json();
  const choice = data.choices?.[0];
  const message = choice?.message;

  const toolCalls = (message?.tool_calls || []).map((tc: any) => ({
    callId: tc.id,
    id: (tc.function?.name || "").replace(/_/g, "::"),
    arguments: JSON.parse(tc.function?.arguments || "{}"),
  }));

  return {
    content: message?.content || "",
    model: data.model || req.model.model,
    toolCalls,
    usage: {
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0,
    },
  };
}

function scoreComplexity(message: string, toolCount: number): number {
  let score = 0;
  const len = message.length;

  if (len > 2000) score += 0.3;
  else if (len > 500) score += 0.15;
  else if (len < 50) score -= 0.1;

  const codeBlocks = (message.match(/```/g) || []).length / 2;
  if (codeBlocks >= 2) score += 0.25;
  else if (codeBlocks >= 1) score += 0.2;

  if (/\b(analyze|architect|design|implement|refactor|debug|compare|evaluate|optimize|migrate)\b/i.test(message))
    score += 0.15;

  if (/\b(step\s*\d|first[,.]?\s|then[,.]?\s|next[,.]?\s|finally[,.]?\s|\d+\.\s)/i.test(message))
    score += 0.1;

  if (/\b(hi|hello|thanks|yes|no|ok)\b/i.test(message) && len < 30)
    score -= 0.2;

  if (toolCount > 10) score += 0.2;
  else if (toolCount > 3) score += 0.1;

  return Math.max(0, Math.min(1, score + 0.4));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

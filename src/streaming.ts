import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger } = init(
  ENGINE_URL,
  { workerName: "streaming" },
);

registerFunction(
  {
    id: "stream::chat",
    description: "SSE streaming chat endpoint",
    metadata: { category: "streaming" },
  },
  async (req) => {
    if (req.headers) requireAuth(req);
    const { agentId, message, sessionId } = req.body || req;

    const config: any = await trigger("state::get", {
      scope: "agents",
      key: agentId || "default",
    }).catch(() => null);

    const memories: any = await trigger("memory::recall", {
      agentId: agentId || "default",
      query: message,
      limit: 10,
    }).catch(() => []);

    const model = await trigger("llm::route", {
      message,
      toolCount: 0,
      config: config?.model,
    });

    const response: any = await trigger("llm::complete", {
      model,
      systemPrompt: config?.systemPrompt || "",
      messages: [...memories, { role: "user", content: message }],
    });

    const chunks = chunkMarkdownAware(response.content || "", 50, 200);

    for (const chunk of chunks) {
      await trigger("stream::send", {
        stream_name: "chat",
        group_id: sessionId || `default:${agentId || "default"}`,
        data: {
          type: "delta",
          delta: chunk,
          model: response.model,
        },
      }).catch(() => {});
    }

    await trigger("stream::send", {
      stream_name: "chat",
      group_id: sessionId || `default:${agentId || "default"}`,
      data: {
        type: "done",
        content: response.content,
        usage: response.usage,
        model: response.model,
      },
    }).catch(() => {});

    return {
      status_code: 200,
      body: {
        content: response.content,
        model: response.model,
        usage: response.usage,
      },
    };
  },
);

registerFunction(
  {
    id: "stream::sse",
    description: "SSE event stream for chat completions",
    metadata: { category: "streaming" },
  },
  async (req) => {
    if (req.headers) requireAuth(req);
    const { agentId, message, sessionId } = req.body || req;

    const response: any = await trigger("agent::chat", {
      agentId: agentId || "default",
      message,
      sessionId,
    });

    const chunks = chunkMarkdownAware(response.content || "", 20, 100);
    const events = chunks.map((chunk, i) => ({
      id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: response.model || "claude-sonnet-4-6",
      choices: [
        {
          index: 0,
          delta:
            i === 0
              ? { role: "assistant", content: chunk }
              : { content: chunk },
          finish_reason: i === chunks.length - 1 ? "stop" : null,
        },
      ],
    }));

    return {
      status_code: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body:
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
    };
  },
);

function chunkMarkdownAware(
  text: string,
  minSize: number,
  maxSize: number,
): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeFence = false;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxSize;
    const window = remaining.slice(0, maxSize);

    for (let i = 0; i < window.length; i++) {
      if (window.slice(i, i + 3) === "```") {
        inCodeFence = !inCodeFence;
      }
    }

    if (inCodeFence) {
      const nextFence = remaining.indexOf("```", 3);
      if (nextFence > 0 && nextFence < maxSize * 2) {
        const afterFence = remaining.indexOf("\n", nextFence + 3);
        splitAt = afterFence > 0 ? afterFence + 1 : nextFence + 3;
        inCodeFence = false;
      }
    } else {
      const paraBreak = window.lastIndexOf("\n\n");
      if (paraBreak > minSize) {
        splitAt = paraBreak + 2;
      } else {
        const newline = window.lastIndexOf("\n");
        if (newline > minSize) {
          splitAt = newline + 1;
        } else {
          const sentenceEnd = window.lastIndexOf(". ");
          if (sentenceEnd > minSize) {
            splitAt = sentenceEnd + 2;
          }
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

registerTrigger({
  type: "http",
  function_id: "stream::chat",
  config: { api_path: "api/chat/stream", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "stream::sse",
  config: { api_path: "v1/chat/completions/stream", http_method: "POST" },
});

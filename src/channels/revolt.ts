import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-revolt",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);
const API_URL = "https://api.revolt.chat";

registerFunction(
  { id: "channel::revolt::webhook", description: "Handle Revolt chat webhook" },
  async (req) => {
    const body = req.body || req;

    if (body.type !== "Message")
      return { status_code: 200, body: { ok: true } };

    const channelId = body.channel;
    const text = body.content || "";
    const authorId = body.author;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "revolt", channelId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `revolt:${channelId}`,
      },
    });

    await sendMessage(channelId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "revolt", channelId, authorId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::revolt::webhook",
  config: { api_path: "webhook/revolt", http_method: "POST" },
});

async function sendMessage(channelId: string, text: string) {
  const token = (await getSecret("REVOLT_TOKEN")).trim();
  if (!token) {
    throw new Error("REVOLT_TOKEN not configured");
  }
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${API_URL}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: {
            "x-bot-token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: chunk }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Revolt send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

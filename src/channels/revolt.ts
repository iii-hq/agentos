import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-revolt" },
);
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

    const agentId = await resolveAgent(trigger, "revolt", channelId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `revolt:${channelId}`,
    });

    await sendMessage(channelId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "revolt", channelId, authorId },
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

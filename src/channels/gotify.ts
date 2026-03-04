import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-gotify" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::gotify::webhook", description: "Handle Gotify push webhook" },
  async (req) => {
    const body = req.body || req;
    const { appid, message, title, extras } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = String(appid);
    const agentId = await resolveAgent(trigger, "gotify", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: title ? `${title}: ${message}` : message,
      sessionId: `gotify:${channelKey}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "gotify", appid },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::gotify::webhook",
  config: { api_path: "webhook/gotify", http_method: "POST" },
});

async function sendMessage(text: string) {
  const baseUrl = await getSecret("GOTIFY_URL");
  if (!baseUrl) {
    throw new Error("GOTIFY_URL not configured");
  }
  const token = await getSecret("GOTIFY_TOKEN");
  if (!token) {
    throw new Error("GOTIFY_TOKEN not configured");
  }
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${normalizedUrl}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gotify-Key": token,
        },
        body: JSON.stringify({
          title: "AgentOS",
          message: chunk,
          priority: 5,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Gotify send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

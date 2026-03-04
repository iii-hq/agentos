import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-ntfy" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::ntfy::webhook", description: "Handle ntfy.sh push webhook" },
  async (req) => {
    const body = req.body || req;
    const { topic, message, title, id: msgId } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "ntfy", topic);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: title ? `${title}: ${message}` : message,
      sessionId: `ntfy:${topic}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "ntfy", topic, msgId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::ntfy::webhook",
  config: { api_path: "webhook/ntfy", http_method: "POST" },
});

async function sendMessage(text: string) {
  const token = await getSecret("NTFY_TOKEN");
  const ntfyTopic = await getSecret("NTFY_TOPIC");
  if (!ntfyTopic) {
    throw new Error("NTFY_TOPIC not configured");
  }
  const baseUrl = (await getSecret("NTFY_URL")) || "https://ntfy.sh";
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${baseUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Title: "AgentOS",
      },
      body: chunk,
    });
  }
}

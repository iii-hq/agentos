import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-ntfy",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));

registerFunction(
  { id: "channel::ntfy::webhook", description: "Handle ntfy.sh push webhook" },
  async (req) => {
    const body = req.body || req;
    const { topic, message, title, id: msgId } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "ntfy", topic);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: title ? `${title}: ${message}` : message,
        sessionId: `ntfy:${topic}`,
      },
    });

    await sendMessage(response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "ntfy", topic, msgId },
      },
      action: TriggerAction.Void(),
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

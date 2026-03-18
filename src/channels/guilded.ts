import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-guilded",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

async function getSecret(key: string): Promise<string> {
  try {
    const result = await sdk.trigger({ function_id: "vault::get", payload: { key } });
    return result?.value || process.env[key] || "";
  } catch {
    return process.env[key] || "";
  }
}
const API_URL = "https://www.guilded.gg/api/v1";

registerFunction(
  { id: "channel::guilded::webhook", description: "Handle Guilded webhook" },
  async (req) => {
    const body = req.body || req;

    if (body.type !== "ChatMessageCreated")
      return { status_code: 200, body: { ok: true } };

    const msg = body.message || body.d?.message;
    if (!msg?.content) return { status_code: 200, body: { ok: true } };

    const channelId = msg.channelId;
    const text = msg.content;
    const authorId = msg.createdBy;

    const agentId = await resolveAgent(sdk, "guilded", channelId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `guilded:${channelId}`,
      },
    });

    await sendMessage(channelId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "guilded", channelId, authorId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::guilded::webhook",
  config: { api_path: "webhook/guilded", http_method: "POST" },
});

async function sendMessage(channelId: string, text: string) {
  const token = await getSecret("GUILDED_TOKEN");
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });
  }
}

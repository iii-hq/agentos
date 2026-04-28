import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-pumble",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);
const API_URL = "https://api.pumble.com/v1";

registerFunction(
  { id: "channel::pumble::webhook", description: "Handle Pumble webhook" },
  async (req) => {
    const body = req.body || req;

    if (body.type === "url_verification") {
      return { status_code: 200, body: { challenge: body.challenge } };
    }

    const event = body.event;
    if (!event?.text || event.bot_id)
      return { status_code: 200, body: { ok: true } };

    const channelId = event.channel;
    const text = event.text;
    const userId = event.user;

    const agentId = await resolveAgent(sdk, "pumble", channelId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `pumble:${channelId}`,
      },
    });

    await sendMessage(channelId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "pumble", channelId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::pumble::webhook",
  config: { api_path: "webhook/pumble", http_method: "POST" },
});

async function sendMessage(channelId: string, text: string) {
  const token = await getSecret("PUMBLE_TOKEN");
  if (!token) {
    throw new Error("PUMBLE_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    const res = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId, text: chunk }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Pumble send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  }
}

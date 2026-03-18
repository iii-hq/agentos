import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-twitch",
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

const API_URL = "https://api.twitch.tv/helix";

registerFunction(
  {
    id: "channel::twitch::webhook",
    description: "Handle Twitch EventSub webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (body.challenge) return { status_code: 200, body: body.challenge };

    const event = body.event;
    if (!event?.message?.text) return { status_code: 200, body: { ok: true } };

    const channelId = event.broadcaster_user_id;
    const text = event.message.text;
    const userId = event.user_id;

    const agentId = await resolveAgent(sdk, "twitch", channelId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `twitch:${channelId}`,
      },
    });

    await sendMessage(channelId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "twitch", channelId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::twitch::webhook",
  config: { api_path: "webhook/twitch", http_method: "POST" },
});

async function sendMessage(broadcasterId: string, text: string) {
  const token = await getSecret("TWITCH_TOKEN");
  if (!token) {
    throw new Error("TWITCH_TOKEN not configured");
  }
  const clientId = await getSecret("TWITCH_CLIENT_ID");
  if (!clientId) {
    throw new Error("TWITCH_CLIENT_ID not configured");
  }
  const chunks = splitMessage(text, 500);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: broadcasterId,
        message: chunk,
      }),
    });
  }
}

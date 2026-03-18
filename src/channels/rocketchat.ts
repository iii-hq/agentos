import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-rocketchat",
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

registerFunction(
  {
    id: "channel::rocketchat::webhook",
    description: "Handle Rocket.Chat outgoing webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { channel_id, user_id, user_name, text, message_id, tmid } = body;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "rocketchat", channel_id);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `rocketchat:${channel_id}`,
      },
    });

    await sendMessage(channel_id, response.content, tmid);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: {
          channel: "rocketchat",
          channelId: channel_id,
          userName: user_name,
        },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::rocketchat::webhook",
  config: { api_path: "webhook/rocketchat", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string, tmid?: string) {
  const token = await getSecret("ROCKETCHAT_TOKEN");
  if (!token) {
    throw new Error("ROCKETCHAT_TOKEN not configured");
  }
  const baseUrl = await getSecret("ROCKETCHAT_URL");
  if (!baseUrl) {
    throw new Error("ROCKETCHAT_URL not configured");
  }
  const userId = await getSecret("ROCKETCHAT_USER_ID");
  if (!userId) {
    throw new Error("ROCKETCHAT_USER_ID not configured");
  }
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    const res = await fetch(`${normalizedUrl}/api/v1/chat.sendMessage`, {
      method: "POST",
      headers: {
        "X-Auth-Token": token,
        "X-User-Id": userId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          rid: roomId,
          msg: chunk,
          ...(tmid ? { tmid } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Rocket.Chat send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  }
}

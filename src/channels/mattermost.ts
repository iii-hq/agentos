import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-mattermost",
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
    id: "channel::mattermost::webhook",
    description: "Handle Mattermost outgoing webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { channel_id, user_id, text, post_id } = body;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "mattermost", channel_id);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `mattermost:${channel_id}`,
      },
    });

    await sendMessage(channel_id, response.content, post_id);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "mattermost", channelId: channel_id, userId: user_id },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mattermost::webhook",
  config: { api_path: "webhook/mattermost", http_method: "POST" },
});

async function sendMessage(channelId: string, text: string, rootId?: string) {
  const token = await getSecret("MATTERMOST_TOKEN");
  if (!token) {
    throw new Error("MATTERMOST_TOKEN not configured");
  }
  const baseUrl = await getSecret("MATTERMOST_URL");
  if (!baseUrl) {
    throw new Error("MATTERMOST_URL not configured");
  }
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch(`${baseUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        message: chunk,
        ...(rootId ? { root_id: rootId } : {}),
      }),
    });
  }
}

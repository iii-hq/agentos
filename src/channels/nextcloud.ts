import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-nextcloud",
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
    id: "channel::nextcloud::webhook",
    description: "Handle Nextcloud Talk webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { token: roomToken, actorId, message, messageId } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "nextcloud", roomToken);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message,
        sessionId: `nextcloud:${roomToken}`,
      },
    });

    await sendMessage(roomToken, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "nextcloud", roomToken, actorId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::nextcloud::webhook",
  config: { api_path: "webhook/nextcloud", http_method: "POST" },
});

async function sendMessage(roomToken: string, text: string) {
  const token = (await getSecret("NEXTCLOUD_TOKEN")).trim();
  if (!token) {
    throw new Error("NEXTCLOUD_TOKEN not configured");
  }
  const baseUrl = (await getSecret("NEXTCLOUD_URL")).trim();
  if (!baseUrl) {
    throw new Error("NEXTCLOUD_URL not configured");
  }
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const res = await fetch(
      `${normalizedUrl}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(roomToken)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "OCS-APIRequest": "true",
        },
        body: JSON.stringify({ message: chunk }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Nextcloud send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  }
}

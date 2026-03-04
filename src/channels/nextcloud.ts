import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-nextcloud" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::nextcloud::webhook",
    description: "Handle Nextcloud Talk webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { token: roomToken, actorId, message, messageId } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "nextcloud", roomToken);

    const response: any = await trigger("agent::chat", {
      agentId,
      message,
      sessionId: `nextcloud:${roomToken}`,
    });

    await sendMessage(roomToken, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "nextcloud", roomToken, actorId },
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
  const token = await getSecret("NEXTCLOUD_TOKEN");
  if (!token) {
    throw new Error("NEXTCLOUD_TOKEN not configured");
  }
  const baseUrl = await getSecret("NEXTCLOUD_URL");
  if (!baseUrl) {
    throw new Error("NEXTCLOUD_URL not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${baseUrl}/ocs/v2.php/apps/spreed/api/v1/chat/${roomToken}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
      },
      body: JSON.stringify({ message: chunk }),
    });
  }
}

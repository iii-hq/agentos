import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-mumble" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::mumble::webhook",
    description: "Handle Mumble text channel via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { channel, user, message } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = channel || "root";
    const agentId = await resolveAgent(trigger, "mumble", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message,
      sessionId: `mumble:${channelKey}`,
    });

    await sendMessage(channelKey, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "mumble", mumbleChannel: channelKey, user },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mumble::webhook",
  config: { api_path: "webhook/mumble", http_method: "POST" },
});

async function sendMessage(channel: string, text: string) {
  const bridgeUrl = await getSecret("MUMBLE_BRIDGE_URL");
  if (!bridgeUrl) {
    throw new Error("MUMBLE_BRIDGE_URL not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${bridgeUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, message: chunk }),
    });
  }
}

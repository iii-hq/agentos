import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-rocketchat" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::rocketchat::webhook",
    description: "Handle Rocket.Chat outgoing webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { channel_id, user_id, user_name, text, message_id, tmid } = body;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "rocketchat", channel_id);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `rocketchat:${channel_id}`,
    });

    await sendMessage(channel_id, response.content, tmid);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: {
        channel: "rocketchat",
        channelId: channel_id,
        userName: user_name,
      },
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
  const baseUrl = await getSecret("ROCKETCHAT_URL");
  const userId = await getSecret("ROCKETCHAT_USER_ID");
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch(`${baseUrl}/api/v1/chat.sendMessage`, {
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
  }
}

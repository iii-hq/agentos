import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-irc" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::irc::webhook",
    description: "Handle IRC message via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { channel, nick, message } = body;

    const ircNick = await getSecret("IRC_NICK");
    if (!message || nick === ircNick)
      return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "irc", channel);

    const response: any = await trigger("agent::chat", {
      agentId,
      message,
      sessionId: `irc:${channel}`,
    });

    await sendMessage(channel, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "irc", ircChannel: channel, nick },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::irc::webhook",
  config: { api_path: "webhook/irc", http_method: "POST" },
});

async function sendMessage(channel: string, text: string) {
  const bridgeUrl =
    (await getSecret("IRC_BRIDGE_URL")) || "http://localhost:5050";
  const chunks = splitMessage(text, 500);
  for (const chunk of chunks) {
    await fetch(`${bridgeUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, message: chunk }),
    });
  }
}

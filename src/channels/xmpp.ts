import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-xmpp" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::xmpp::webhook",
    description: "Handle XMPP message via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { from, to, body: text, type } = body;
    const jid = await getSecret("XMPP_JID");
    if (!jid) {
      return { status_code: 500, body: { error: "XMPP_JID not configured" } };
    }

    if (!text || from === jid) return { status_code: 200, body: { ok: true } };

    const channelKey = type === "groupchat" ? to : from;
    const agentId = await resolveAgent(trigger, "xmpp", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `xmpp:${channelKey}`,
    });

    await sendMessage(channelKey, response.content, type);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "xmpp", from, chatType: type },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::xmpp::webhook",
  config: { api_path: "webhook/xmpp", http_method: "POST" },
});

async function sendMessage(to: string, text: string, type: string) {
  const bridgeUrl =
    (await getSecret("XMPP_BRIDGE_URL")) || "http://localhost:5280";
  const jid = await getSecret("XMPP_JID");
  if (!jid) {
    throw new Error("XMPP_JID secret not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${bridgeUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: jid,
        to,
        body: chunk,
        type: type || "chat",
      }),
    });
  }
}

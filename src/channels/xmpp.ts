import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-xmpp",
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
    const agentId = await resolveAgent(sdk, "xmpp", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `xmpp:${channelKey}`,
      },
    });

    await sendMessage(channelKey, response.content, type);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "xmpp", from, chatType: type },
      },
      action: TriggerAction.Void(),
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
    try {
      const res = await fetch(`${bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: jid,
          to,
          body: chunk,
          type: type || "chat",
        }),
      });
      if (!res.ok) {
        console.error(`XMPP send failed: ${res.status}`);
      }
    } catch (err: any) {
      console.error(`XMPP send error: ${err.message}`);
    }
  }
}

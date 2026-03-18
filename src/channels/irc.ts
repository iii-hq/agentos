import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-irc",
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
    id: "channel::irc::webhook",
    description: "Handle IRC message via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { channel, nick, message } = body;

    const ircNick = await getSecret("IRC_NICK");
    if (!message || nick === ircNick)
      return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "irc", channel);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message,
        sessionId: `irc:${channel}`,
      },
    });

    await sendMessage(channel, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "irc", ircChannel: channel, nick },
      },
      action: TriggerAction.Void(),
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

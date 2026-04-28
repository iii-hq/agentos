import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-keybase",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::keybase::webhook",
    description: "Handle Keybase bot webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { sender, channel, text, conversation_id } = body;

    const username = await getSecret("KEYBASE_USERNAME");
    if (!username) {
      return {
        status_code: 500,
        body: { error: "KEYBASE_USERNAME not configured" },
      };
    }
    if (!text || sender === username)
      return { status_code: 200, body: { ok: true } };

    const channelKey = conversation_id || channel;
    const agentId = await resolveAgent(sdk, "keybase", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `keybase:${channelKey}`,
      },
    });

    await sendMessage(channelKey, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "keybase", sender, conversationId: channelKey },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::keybase::webhook",
  config: { api_path: "webhook/keybase", http_method: "POST" },
});

async function sendMessage(conversationId: string, text: string) {
  const bridgeUrl =
    (await getSecret("KEYBASE_BRIDGE_URL")) || "http://localhost:8822";
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${bridgeUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        message: chunk,
      }),
    });
  }
}

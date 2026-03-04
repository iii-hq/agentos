import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-signal" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::signal::webhook",
    description: "Handle Signal REST API bridge webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { envelope } = body;

    if (!envelope?.dataMessage?.message)
      return { status_code: 200, body: { ok: true } };

    const source = envelope.source;
    const text = envelope.dataMessage.message;
    const groupId = envelope.dataMessage.groupInfo?.groupId;

    const channelKey = groupId || source;
    const agentId = await resolveAgent(trigger, "signal", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `signal:${channelKey}`,
    });

    await sendMessage(source, response.content, groupId);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "signal", source, groupId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::signal::webhook",
  config: { api_path: "webhook/signal", http_method: "POST" },
});

async function sendMessage(recipient: string, text: string, groupId?: string) {
  const apiUrl = await getSecret("SIGNAL_API_URL");
  const phone = await getSecret("SIGNAL_PHONE");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: chunk,
        number: phone,
        ...(groupId
          ? { recipients: [], group_id: groupId }
          : { recipients: [recipient] }),
      }),
    });
  }
}

import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-zulip" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::zulip::webhook", description: "Handle Zulip bot webhook" },
  async (req) => {
    const body = req.body || req;
    const { message } = body;

    if (!message?.content) return { status_code: 200, body: { ok: true } };

    const streamId = message.stream_id || message.sender_id;
    const text = message.content;
    const topic = message.subject || "";

    const agentId = await resolveAgent(trigger, "zulip", String(streamId));

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `zulip:${streamId}:${topic}`,
    });

    await sendMessage(message.type, streamId, topic, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "zulip", streamId, senderId: message.sender_id },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::zulip::webhook",
  config: { api_path: "webhook/zulip", http_method: "POST" },
});

async function sendMessage(
  type: string,
  to: number,
  topic: string,
  content: string,
) {
  const email = await getSecret("ZULIP_EMAIL");
  const apiKey = await getSecret("ZULIP_API_KEY");
  const site = await getSecret("ZULIP_SITE");
  const auth = Buffer.from(`${email}:${apiKey}`).toString("base64");
  const chunks = splitMessage(content, 10000);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      type: type === "private" ? "private" : "stream",
      to: String(to),
      topic,
      content: chunk,
    });
    await fetch(`${site}/api/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  }
}

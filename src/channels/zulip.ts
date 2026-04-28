import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-zulip",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

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

    const agentId = await resolveAgent(sdk, "zulip", String(streamId));

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `zulip:${streamId}:${topic}`,
      },
    });

    await sendMessage(message.type, streamId, topic, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "zulip", streamId, senderId: message.sender_id },
      },
      action: TriggerAction.Void(),
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
  if (!email) {
    throw new Error("ZULIP_EMAIL not configured");
  }
  const apiKey = await getSecret("ZULIP_API_KEY");
  if (!apiKey) {
    throw new Error("ZULIP_API_KEY not configured");
  }
  const site = await getSecret("ZULIP_SITE");
  if (!site) {
    throw new Error("ZULIP_SITE not configured");
  }
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

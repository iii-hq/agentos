import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-linkedin",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));
const API_URL = "https://api.linkedin.com/v2";

registerFunction(
  {
    id: "channel::linkedin::webhook",
    description: "Handle LinkedIn messaging webhook",
  },
  async (req) => {
    const body = req.body || req;
    const element = body.elements?.[0];

    if (
      !element?.event?.["com.linkedin.voyager.messaging.event.MessageEvent"]
    ) {
      return { status_code: 200, body: { ok: true } };
    }

    const msgEvent =
      element.event["com.linkedin.voyager.messaging.event.MessageEvent"];
    const text = msgEvent.messageBody?.text || msgEvent.attributedBody?.text;
    const threadId = element.entityUrn;
    const senderId = element.from;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "linkedin", threadId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `linkedin:${threadId}`,
      },
    });

    await sendMessage(threadId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "linkedin", threadId, senderId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::linkedin::webhook",
  config: { api_path: "webhook/linkedin", http_method: "POST" },
});

async function sendMessage(threadId: string, text: string) {
  const token = await getSecret("LINKEDIN_TOKEN");
  if (!token) {
    throw new Error("LINKEDIN_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        recipients: [],
        threadId,
        body: chunk,
      }),
    });
  }
}

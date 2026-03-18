import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-viber",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));
const API_URL = "https://chatapi.viber.com/pa/send_message";

registerFunction(
  {
    id: "channel::viber::webhook",
    description: "Handle Viber REST API webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (body.event !== "message")
      return { status_code: 200, body: { ok: true } };

    const userId = body.sender?.id;
    const text = body.message?.text;

    if (!text || !userId) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "viber", userId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `viber:${userId}`,
      },
    });

    await sendMessage(userId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "viber", userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::viber::webhook",
  config: { api_path: "webhook/viber", http_method: "POST" },
});

async function sendMessage(receiverId: string, text: string) {
  const token = await getSecret("VIBER_TOKEN");
  if (!token) {
    throw new Error("VIBER_TOKEN not configured");
  }
  const chunks = splitMessage(text, 7000);
  for (const chunk of chunks) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "X-Viber-Auth-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receiver: receiverId,
        type: "text",
        text: chunk,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Viber send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  }
}

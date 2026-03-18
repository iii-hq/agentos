import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-whatsapp",
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
    id: "channel::whatsapp::webhook",
    description: "Handle WhatsApp Business API webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (body.object !== "whatsapp_business_account")
      return { status_code: 200, body: { ok: true } };

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message?.text?.body) return { status_code: 200, body: { ok: true } };

    const from = message.from;
    const text = message.text.body;
    const agentId = await resolveAgent(sdk, "whatsapp", from);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `whatsapp:${from}`,
      },
    });

    await sendMessage(from, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "whatsapp", from },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::whatsapp::webhook",
  config: { api_path: "webhook/whatsapp", http_method: "POST" },
});

async function sendMessage(to: string, text: string) {
  const token = await getSecret("WHATSAPP_TOKEN");
  if (!token) {
    throw new Error("WHATSAPP_TOKEN not configured");
  }
  const phoneId = await getSecret("WHATSAPP_PHONE_ID");
  if (!phoneId) {
    throw new Error("WHATSAPP_PHONE_ID not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk },
      }),
    });
  }
}

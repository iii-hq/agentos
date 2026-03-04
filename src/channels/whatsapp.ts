import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-whatsapp" },
);
const getSecret = createSecretGetter(trigger);

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
    const agentId = await resolveAgent(trigger, "whatsapp", from);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `whatsapp:${from}`,
    });

    await sendMessage(from, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "whatsapp", from },
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

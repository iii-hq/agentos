import { timingSafeEqual } from "crypto";
import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-messenger" },
);
const getSecret = createSecretGetter(trigger);

const API_URL = "https://graph.facebook.com/v18.0/me/messages";

registerFunction(
  {
    id: "channel::messenger::webhook",
    description: "Handle Facebook Messenger webhook",
  },
  async (req) => {
    const body = req.body || req;

    const verifyToken = await getSecret("MESSENGER_VERIFY_TOKEN");
    if (!verifyToken) {
      return {
        status_code: 500,
        body: { error: "Verify token not configured" },
      };
    }
    if (
      body["hub.mode"] === "subscribe" &&
      safeCompare(body["hub.verify_token"], verifyToken)
    ) {
      return { status_code: 200, body: body["hub.challenge"] };
    }

    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging?.message?.text)
      return { status_code: 200, body: { ok: true } };

    const senderId = messaging.sender.id;
    const text = messaging.message.text;

    const agentId = await resolveAgent(trigger, "messenger", senderId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `messenger:${senderId}`,
    });

    await sendMessage(senderId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "messenger", senderId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::messenger::webhook",
  config: { api_path: "webhook/messenger", http_method: "POST" },
});

async function sendMessage(recipientId: string, text: string) {
  const pageToken = await getSecret("MESSENGER_PAGE_TOKEN");
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await fetch(`${API_URL}?access_token=${pageToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: chunk },
      }),
    });
  }
}

import { timingSafeEqual } from "crypto";
import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-messenger",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));

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
    if (body["hub.mode"] === "subscribe") {
      if (safeCompare(body["hub.verify_token"], verifyToken)) {
        return { status_code: 200, body: body["hub.challenge"] };
      }
      return { status_code: 403, body: "Forbidden" };
    }

    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging?.message?.text)
      return { status_code: 200, body: { ok: true } };

    const senderId = messaging.sender.id;
    const text = messaging.message.text;

    const agentId = await resolveAgent(sdk, "messenger", senderId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `messenger:${senderId}`,
      },
    });

    await sendMessage(senderId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "messenger", senderId },
      },
      action: TriggerAction.Void(),
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
  if (!pageToken) {
    throw new Error("MESSENGER_PAGE_TOKEN not configured");
  }
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pageToken}`,
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunk },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Messenger send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

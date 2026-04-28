import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import {
  splitMessage,
  resolveAgent,
  verifyTelegramUpdate,
} from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-telegram",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::telegram::webhook", description: "Handle Telegram webhook" },
  async (req) => {
    const secretToken = await getSecret("TELEGRAM_SECRET_TOKEN");
    if (!secretToken || !verifyTelegramUpdate(secretToken, req)) {
      return {
        status_code: 401,
        body: { error: "Missing or invalid webhook signature" },
      };
    }

    const update = req.body || req;
    const message = update.message || update.edited_message;

    if (!message?.text) return { status_code: 200, body: { ok: true } };

    const chatId = message.chat.id;
    const text = message.text;
    const userId = message.from?.id;

    const agentId = await resolveAgent(sdk, "telegram", String(chatId));

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `telegram:${chatId}`,
      },
    });

    await sendMessage(chatId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "telegram", chatId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::telegram::webhook",
  config: { api_path: "webhook/telegram", http_method: "POST" },
});

async function sendMessage(chatId: number, text: string) {
  const botToken = await getSecret("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Telegram send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

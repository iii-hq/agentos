import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-line",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));
const API_URL = "https://api.line.me/v2/bot/message";

registerFunction(
  {
    id: "channel::line::webhook",
    description: "Handle LINE Messaging API webhook",
  },
  async (req) => {
    const body = req.body || req;
    const events = body.events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userId = event.source?.userId || event.source?.groupId;
      const text = event.message.text;
      const replyToken = event.replyToken;

      const agentId = await resolveAgent(sdk, "line", userId);

      const response: any = await trigger({
        function_id: "agent::chat",
        payload: {
          agentId,
          message: text,
          sessionId: `line:${userId}`,
        },
      });

      await sendMessage(replyToken, response.content);

      trigger({
        function_id: "security::audit",
        payload: {
          type: "channel_message",
          agentId,
          detail: { channel: "line", userId },
        },
        action: TriggerAction.Void(),
      });
    }

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::line::webhook",
  config: { api_path: "webhook/line", http_method: "POST" },
});

async function sendMessage(replyToken: string, text: string) {
  const token = await getSecret("LINE_CHANNEL_TOKEN");
  if (!token) {
    throw new Error("LINE_CHANNEL_TOKEN not configured");
  }
  const chunks = splitMessage(text, 5000);
  const messages = chunks
    .slice(0, 5)
    .map((chunk) => ({ type: "text", text: chunk }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${API_URL}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LINE send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { createHmac } from "crypto";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-dingtalk",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));

const API_URL = "https://oapi.dingtalk.com/robot/send";

registerFunction(
  {
    id: "channel::dingtalk::webhook",
    description: "Handle DingTalk robot webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { text, conversationId, senderNick, senderId } = body;

    const content = text?.content?.trim();
    if (!content) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "dingtalk", conversationId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: content,
        sessionId: `dingtalk:${conversationId}`,
      },
    });

    if (!response?.content) {
      return { status_code: 200, body: { ok: true } };
    }
    await sendMessage(response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "dingtalk", conversationId, senderId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::dingtalk::webhook",
  config: { api_path: "webhook/dingtalk", http_method: "POST" },
});

async function sendMessage(text: string) {
  const token = await getSecret("DINGTALK_TOKEN");
  if (!token) {
    throw new Error("DINGTALK_TOKEN not configured");
  }
  const secret = await getSecret("DINGTALK_SECRET");
  if (!secret) {
    throw new Error("DINGTALK_SECRET not configured");
  }
  const timestamp = Date.now();
  const sign = createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${API_URL}?access_token=${encodeURIComponent(token)}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: chunk } }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `DingTalk send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

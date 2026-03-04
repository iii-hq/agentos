import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { createHmac } from "crypto";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-dingtalk" },
);
const getSecret = createSecretGetter(trigger);

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

    const agentId = await resolveAgent(trigger, "dingtalk", conversationId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: content,
      sessionId: `dingtalk:${conversationId}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "dingtalk", conversationId, senderId },
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
    await fetch(
      `${API_URL}?access_token=${token}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: chunk } }),
      },
    );
  }
}

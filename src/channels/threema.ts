import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-threema" },
);
const getSecret = createSecretGetter(trigger);

const API_URL = "https://msgapi.threema.ch";

registerFunction(
  {
    id: "channel::threema::webhook",
    description: "Handle Threema Gateway webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { from, text, messageId } = body;

    if (!text || !from) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "threema", from);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `threema:${from}`,
    });

    await sendMessage(from, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "threema", from, messageId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::threema::webhook",
  config: { api_path: "webhook/threema", http_method: "POST" },
});

async function sendMessage(to: string, text: string) {
  const threemaId = await getSecret("THREEMA_ID");
  if (!threemaId) {
    throw new Error("THREEMA_ID not configured");
  }
  const secret = await getSecret("THREEMA_SECRET");
  if (!secret) {
    throw new Error("THREEMA_SECRET not configured");
  }
  const chunks = splitMessage(text, 3500);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      from: threemaId,
      to,
      text: chunk,
      secret,
    });
    await fetch(`${API_URL}/send_simple`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }
}

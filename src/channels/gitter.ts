import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-gitter",
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

const API_URL = "https://api.gitter.im/v1";

registerFunction(
  { id: "channel::gitter::webhook", description: "Handle Gitter webhook" },
  async (req) => {
    const body = req.body || req;
    const { model } = body;

    if (!model?.text) return { status_code: 200, body: { ok: true } };

    const roomId = model.roomId || body.roomId;
    const text = model.text;
    const userId = model.fromUser?.id;

    const agentId = await resolveAgent(sdk, "gitter", roomId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `gitter:${roomId}`,
      },
    });

    await sendMessage(roomId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "gitter", roomId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::gitter::webhook",
  config: { api_path: "webhook/gitter", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string) {
  const token = await getSecret("GITTER_TOKEN");
  if (!token) {
    throw new Error("GITTER_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/rooms/${roomId}/chatMessages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: chunk }),
    });
  }
}

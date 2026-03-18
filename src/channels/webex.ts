import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-webex",
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
const API_URL = "https://webexapis.com/v1";

registerFunction(
  { id: "channel::webex::webhook", description: "Handle Cisco Webex webhook" },
  async (req) => {
    const body = req.body || req;

    if (body.resource !== "messages" || body.event !== "created") {
      return { status_code: 200, body: { ok: true } };
    }

    const messageId = body.data?.id;
    const roomId = body.data?.roomId;
    const personId = body.data?.personId;

    const webexToken = await getSecret("WEBEX_TOKEN");
    if (!webexToken) {
      return {
        status_code: 500,
        body: { error: "WEBEX_TOKEN not configured" },
      };
    }
    const msgRes = await fetch(`${API_URL}/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${webexToken}` },
    });
    if (!msgRes.ok) {
      return {
        status_code: 502,
        body: { error: "Failed to fetch Webex message" },
      };
    }
    const msg = (await msgRes.json()) as { text: string };
    const text = msg.text;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "webex", roomId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `webex:${roomId}`,
      },
    });

    await sendMessage(roomId, response.content, webexToken);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "webex", roomId, personId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::webex::webhook",
  config: { api_path: "webhook/webex", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string, token: string) {
  const chunks = splitMessage(text, 7439);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId, text: chunk }),
    });
  }
}

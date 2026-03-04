import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-webex" },
);
const getSecret = createSecretGetter(trigger);
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

    const agentId = await resolveAgent(trigger, "webex", roomId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `webex:${roomId}`,
    });

    await sendMessage(roomId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "webex", roomId, personId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::webex::webhook",
  config: { api_path: "webhook/webex", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string) {
  const token = await getSecret("WEBEX_TOKEN");
  if (!token) {
    throw new Error("WEBEX_TOKEN not configured");
  }
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

import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-google-chat" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::google-chat::webhook",
    description: "Handle Google Chat webhook",
  },
  async (req) => {
    const event = req.body || req;
    const headers = req.headers || {};

    const expectedToken = await getSecret("GOOGLE_CHAT_TOKEN");
    if (expectedToken) {
      const authHeader =
        headers["authorization"] || headers["Authorization"] || "";
      const bearer = authHeader.replace(/^Bearer\s+/i, "");
      if (!bearer || bearer !== expectedToken) {
        return { status_code: 401, body: { error: "Unauthorized" } };
      }
    }

    if (event.type !== "MESSAGE")
      return { status_code: 200, body: { ok: true } };

    const spaceId = event.space?.name;
    const text = event.message?.text || "";
    const userId = event.user?.name;

    const agentId = await resolveAgent(trigger, "google-chat", spaceId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `google-chat:${spaceId}`,
    });

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "google-chat", spaceId, userId },
    });

    return { status_code: 200, body: { text: response.content } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::google-chat::webhook",
  config: { api_path: "webhook/google-chat", http_method: "POST" },
});

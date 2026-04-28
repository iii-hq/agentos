import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-google-chat",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

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
      const rawHeader =
        headers["authorization"] || headers["Authorization"] || "";
      const authHeader = Array.isArray(rawHeader)
        ? rawHeader[0] || ""
        : String(rawHeader);
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

    const agentId = await resolveAgent(sdk, "google-chat", spaceId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `google-chat:${spaceId}`,
      },
    });

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "google-chat", spaceId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { text: response.content } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::google-chat::webhook",
  config: { api_path: "webhook/google-chat", http_method: "POST" },
});

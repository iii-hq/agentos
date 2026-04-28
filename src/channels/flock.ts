import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-flock",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

const API_URL = "https://api.flock.com/v2/chat.sendMessage";

registerFunction(
  { id: "channel::flock::webhook", description: "Handle Flock webhook" },
  async (req) => {
    const body = req.body || req;
    const { name, text, to, userId } = body;

    if (!text) return { status_code: 200, body: { ok: true } };

    const channelId = to;
    const agentId = await resolveAgent(sdk, "flock", channelId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `flock:${channelId}`,
      },
    });

    await sendMessage(channelId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "flock", channelId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::flock::webhook",
  config: { api_path: "webhook/flock", http_method: "POST" },
});

async function sendMessage(to: string, text: string) {
  const token = await getSecret("FLOCK_TOKEN");
  if (!token) {
    throw new Error("FLOCK_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token,
        to,
        text: chunk,
      }),
    });
  }
}

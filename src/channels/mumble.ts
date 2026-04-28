import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-mumble",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::mumble::webhook",
    description: "Handle Mumble text channel via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { channel, user, message } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = channel || "root";
    const agentId = await resolveAgent(sdk, "mumble", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message,
        sessionId: `mumble:${channelKey}`,
      },
    });

    await sendMessage(channelKey, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "mumble", mumbleChannel: channelKey, user },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mumble::webhook",
  config: { api_path: "webhook/mumble", http_method: "POST" },
});

async function sendMessage(channel: string, text: string) {
  const bridgeUrl = await getSecret("MUMBLE_BRIDGE_URL");
  if (!bridgeUrl) {
    throw new Error("MUMBLE_BRIDGE_URL not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, message: chunk }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Mumble send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

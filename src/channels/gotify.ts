import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-gotify",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::gotify::webhook", description: "Handle Gotify push webhook" },
  async (req) => {
    const body = req.body || req;
    const { appid, message, title, extras } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = String(appid);
    const agentId = await resolveAgent(sdk, "gotify", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: title ? `${title}: ${message}` : message,
        sessionId: `gotify:${channelKey}`,
      },
    });

    await sendMessage(response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "gotify", appid },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::gotify::webhook",
  config: { api_path: "webhook/gotify", http_method: "POST" },
});

async function sendMessage(text: string) {
  const baseUrl = await getSecret("GOTIFY_URL");
  if (!baseUrl) {
    throw new Error("GOTIFY_URL not configured");
  }
  const token = await getSecret("GOTIFY_TOKEN");
  if (!token) {
    throw new Error("GOTIFY_TOKEN not configured");
  }
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${normalizedUrl}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gotify-Key": token,
        },
        body: JSON.stringify({
          title: "AgentOS",
          message: chunk,
          priority: 5,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Gotify send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

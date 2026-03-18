import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent, assertNoSsrf } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-webhook",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

registerFunction(
  {
    id: "channel::webhook::inbound",
    description: "Generic webhook handler for any platform",
  },
  async (req) => {
    const { body, headers, query_params, path_params } = req;
    const channelId =
      path_params?.channelId || query_params?.channel || "default";

    const agentId = await resolveAgent(sdk, "webhook", channelId);

    const message =
      body?.message ||
      body?.text ||
      body?.content ||
      "[Unrecognized webhook payload]";

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message,
        sessionId: `webhook:${channelId}`,
      },
    });

    const callbackUrl = body?.callback_url || body?.response_url;
    if (callbackUrl) {
      await assertNoSsrf(callbackUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: response.content }),
          signal: controller.signal,
        });
      } catch {
      } finally {
        clearTimeout(timer);
      }
    }

    return { status_code: 200, body: { response: response.content } };
  },
);

registerFunction(
  {
    id: "channel::webhook::configure",
    description: "Configure a webhook channel",
  },
  async ({
    channelId,
    agentId,
    callbackUrl,
  }: {
    channelId: string;
    agentId: string;
    callbackUrl?: string;
  }) => {
    await trigger({
      function_id: "state::set",
      payload: {
        scope: "channel_agents",
        key: `webhook:${channelId}`,
        value: { agentId, callbackUrl, configuredAt: Date.now() },
      },
    });
    return { configured: true, channelId };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::webhook::inbound",
  config: { api_path: "webhook/:channelId", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "channel::webhook::configure",
  config: { api_path: "api/channels/webhook", http_method: "POST" },
});

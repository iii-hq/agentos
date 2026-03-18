import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-signal",
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

registerFunction(
  {
    id: "channel::signal::webhook",
    description: "Handle Signal REST API bridge webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { envelope } = body;

    if (!envelope?.dataMessage?.message)
      return { status_code: 200, body: { ok: true } };

    const source = envelope.source;
    const text = envelope.dataMessage.message;
    const groupId = envelope.dataMessage.groupInfo?.groupId;

    const channelKey = groupId || source;
    const agentId = await resolveAgent(sdk, "signal", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `signal:${channelKey}`,
      },
    });

    if (!response?.content) {
      console.warn("signal: agent returned empty response", { channelKey });
      return { status_code: 500, body: { error: "Empty agent response" } };
    }

    await sendMessage(source, response.content, groupId);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "signal", source, groupId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::signal::webhook",
  config: { api_path: "webhook/signal", http_method: "POST" },
});

async function sendMessage(recipient: string, text: string, groupId?: string) {
  const apiUrl = await getSecret("SIGNAL_API_URL");
  if (!apiUrl) {
    throw new Error("SIGNAL_API_URL not configured");
  }
  const phone = await getSecret("SIGNAL_PHONE");
  if (!phone) {
    throw new Error("SIGNAL_PHONE not configured");
  }
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: chunk,
          number: phone,
          ...(groupId
            ? { recipients: [], group_id: groupId }
            : { recipients: [recipient] }),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Signal send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

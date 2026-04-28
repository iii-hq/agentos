import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-twist",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);
const API_URL = "https://api.twist.com/api/v3";

registerFunction(
  {
    id: "channel::twist::webhook",
    description: "Handle Twist integration webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { channel_id, content, creator, thread_id, comment_id } = body;

    if (!content) return { status_code: 200, body: { ok: true } };

    const channelKey = thread_id
      ? `thread:${thread_id}`
      : `channel:${channel_id}`;
    const agentId = await resolveAgent(sdk, "twist", channelKey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: content,
        sessionId: `twist:${channelKey}`,
      },
    });

    await sendMessage(thread_id || channel_id, response.content, !!thread_id);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "twist", channelKey, creator },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::twist::webhook",
  config: { api_path: "webhook/twist", http_method: "POST" },
});

async function sendMessage(id: number, text: string, isThread: boolean) {
  const token = await getSecret("TWIST_TOKEN");
  if (!token) {
    throw new Error("TWIST_TOKEN not configured");
  }
  const endpoint = isThread ? "comments/add" : "thread_messages/add";
  const payload = isThread
    ? { thread_id: id, content: text }
    : { channel_id: id, content: text };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${API_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Twist send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

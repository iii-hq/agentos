import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-mastodon",
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
  { id: "channel::mastodon::webhook", description: "Handle Mastodon webhook" },
  async (req) => {
    const body = req.body || req;
    const { account, status } = body;

    if (!status?.content) return { status_code: 200, body: { ok: true } };

    const acct = account?.acct || account?.id;
    const text = status.content.replace(/<[^>]+>/g, "");
    const agentId = await resolveAgent(sdk, "mastodon", acct);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `mastodon:${acct}`,
      },
    });

    await sendMessage(response.content, status.id);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "mastodon", acct },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mastodon::webhook",
  config: { api_path: "webhook/mastodon", http_method: "POST" },
});

async function sendMessage(text: string, inReplyToId?: string) {
  const instance = await getSecret("MASTODON_INSTANCE");
  if (!instance) {
    throw new Error("MASTODON_INSTANCE not configured");
  }
  const token = await getSecret("MASTODON_TOKEN");
  if (!token) {
    throw new Error("MASTODON_TOKEN not configured");
  }
  const chunks = splitMessage(text, 500);
  let replyId = inReplyToId;
  for (const chunk of chunks) {
    const res = await fetch(`${instance}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: chunk,
        ...(replyId ? { in_reply_to_id: replyId } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Mastodon post failed: ${res.status}`);
    }
    const data = (await res.json()) as { id: string };
    if (!data.id) {
      throw new Error("Mastodon response missing status id");
    }
    replyId = data.id;
  }
}

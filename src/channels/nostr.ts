import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-nostr",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::nostr::webhook",
    description: "Handle Nostr relay event via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { pubkey, content, id, kind } = body;

    if (!content || kind !== 1) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "nostr", pubkey);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: content,
        sessionId: `nostr:${pubkey}`,
      },
    });

    await sendMessage(response.content, id);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "nostr", pubkey },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::nostr::webhook",
  config: { api_path: "webhook/nostr", http_method: "POST" },
});

async function sendMessage(content: string, replyToId?: string) {
  const privateKey = await getSecret("NOSTR_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("NOSTR_PRIVATE_KEY not configured");
  }
  const relay = (await getSecret("NOSTR_RELAY")) || "wss://relay.damus.io";
  const bridgeUrl =
    (await getSecret("NOSTR_BRIDGE_URL")) || "http://localhost:7777";
  const chunks = splitMessage(content, 4096);
  for (const chunk of chunks) {
    const res = await fetch(`${bridgeUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: chunk,
        kind: 1,
        relay,
        private_key: privateKey,
        ...(replyToId ? { tags: [["e", replyToId]] } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Nostr bridge publish failed: ${res.status}`);
    }
  }
}

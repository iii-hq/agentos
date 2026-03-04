import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-nostr" },
);
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

    const agentId = await resolveAgent(trigger, "nostr", pubkey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: content,
      sessionId: `nostr:${pubkey}`,
    });

    await sendMessage(response.content, id);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "nostr", pubkey },
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

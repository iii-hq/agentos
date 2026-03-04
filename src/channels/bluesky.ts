import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-bluesky" },
);
const getSecret = createSecretGetter(trigger);

const API_URL = "https://bsky.social/xrpc";

let session: { accessJwt: string; did: string } | null = null;

registerFunction(
  {
    id: "channel::bluesky::webhook",
    description: "Handle Bluesky AT Protocol webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { did, text, uri, cid } = body;

    if (!text || did === session?.did)
      return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "bluesky", did);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `bluesky:${did}`,
    });

    await sendMessage(response.content, { uri, cid });

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "bluesky", did },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::bluesky::webhook",
  config: { api_path: "webhook/bluesky", http_method: "POST" },
});

async function authenticate() {
  const handle = await getSecret("BLUESKY_HANDLE");
  if (!handle) {
    throw new Error("BLUESKY_HANDLE not configured");
  }
  const password = await getSecret("BLUESKY_PASSWORD");
  if (!password) {
    throw new Error("BLUESKY_PASSWORD not configured");
  }
  const res = await fetch(`${API_URL}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!res.ok) {
    throw new Error(`Bluesky authentication failed: ${res.status}`);
  }
  session = (await res.json()) as { accessJwt: string; did: string };
}

async function sendMessage(
  text: string,
  parent?: { uri: string; cid: string },
) {
  if (!session) await authenticate();
  const chunks = splitMessage(text, 300);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session!.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: session!.did,
        collection: "app.bsky.feed.post",
        record: {
          text: chunk,
          createdAt: new Date().toISOString(),
          ...(parent ? { reply: { root: parent, parent } } : {}),
        },
      }),
    });
  }
}

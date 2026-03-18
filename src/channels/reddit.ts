import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-reddit",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));

let accessToken = "";

registerFunction(
  { id: "channel::reddit::webhook", description: "Handle Reddit webhook" },
  async (req) => {
    const body = req.body || req;
    const { subreddit, author, body: text, name, link_id } = body;

    if (!text || author === "[deleted]")
      return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "reddit", subreddit);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `reddit:${link_id || name}`,
      },
    });

    await sendMessage(name, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "reddit", subreddit, author },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::reddit::webhook",
  config: { api_path: "webhook/reddit", http_method: "POST" },
});

async function refreshAccessToken() {
  const clientId = await getSecret("REDDIT_CLIENT_ID");
  if (!clientId) {
    throw new Error("REDDIT_CLIENT_ID not configured");
  }
  const clientSecret = await getSecret("REDDIT_SECRET");
  if (!clientSecret) {
    throw new Error("REDDIT_SECRET not configured");
  }
  const refreshToken = await getSecret("REDDIT_REFRESH_TOKEN");
  if (!refreshToken) {
    throw new Error("REDDIT_REFRESH_TOKEN not configured");
  }
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!res.ok) {
    throw new Error(`Reddit token refresh failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string };
  accessToken = data.access_token;
}

async function sendMessage(parentName: string, text: string) {
  if (!accessToken) await refreshAccessToken();
  await fetch("https://oauth.reddit.com/api/comment", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `thing_id=${parentName}&text=${encodeURIComponent(text)}`,
  });
}

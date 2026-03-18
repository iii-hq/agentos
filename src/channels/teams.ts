import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-teams",
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

const AUTH_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

registerFunction(
  {
    id: "channel::teams::webhook",
    description: "Handle Microsoft Teams Bot Framework webhook",
  },
  async (req) => {
    const activity = req.body || req;

    if (activity.type !== "message")
      return { status_code: 200, body: { ok: true } };

    const conversationId = activity.conversation?.id;
    const text = activity.text || "";
    const userId = activity.from?.id;
    const serviceUrl = activity.serviceUrl;

    const agentId = await resolveAgent(sdk, "teams", conversationId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `teams:${conversationId}`,
      },
    });

    await sendMessage(
      serviceUrl,
      conversationId,
      activity.id,
      response.content,
    );

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "teams", conversationId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::teams::webhook",
  config: { api_path: "webhook/teams", http_method: "POST" },
});

async function getToken(): Promise<string> {
  const appId = await getSecret("TEAMS_APP_ID");
  const appPassword = await getSecret("TEAMS_APP_PASSWORD");
  if (!appId || !appPassword) {
    throw new Error("Missing Teams credentials");
  }
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: "https://api.botframework.com/.default",
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }
  return data.access_token;
}

async function sendMessage(
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  text: string,
) {
  const token = await getToken();
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${serviceUrl}/v3/conversations/${conversationId}/activities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "message",
        text: chunk,
        replyToId,
      }),
    });
  }
}

import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../shared/config.js";
import { createSecretGetter } from "../shared/secrets.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-feishu",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(sdk.trigger.bind(sdk));

const API_URL = "https://open.feishu.cn/open-apis";

let tenantToken = "";
let tenantTokenExpiry = 0;
let tenantTokenPromise: Promise<string> | null = null;

registerFunction(
  {
    id: "channel::feishu::webhook",
    description: "Handle Feishu/Lark event callback",
  },
  async (req) => {
    const body = req.body || req;

    if (body.challenge)
      return { status_code: 200, body: { challenge: body.challenge } };

    const event = body.event;
    if (!event?.message?.content)
      return { status_code: 200, body: { ok: true } };

    const chatId = event.message.chat_id;
    const content = JSON.parse(event.message.content);
    const text = content.text || "";
    const userId = event.sender?.sender_id?.user_id;

    const agentId = await resolveAgent(sdk, "feishu", chatId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `feishu:${chatId}`,
      },
    });

    await sendMessage(chatId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "feishu", chatId, userId },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::feishu::webhook",
  config: { api_path: "webhook/feishu", http_method: "POST" },
});

async function getTenantToken(): Promise<string> {
  if (tenantToken && Date.now() < tenantTokenExpiry) return tenantToken;
  if (tenantTokenPromise) return tenantTokenPromise;
  tenantTokenPromise = refreshTenantToken();
  try {
    return await tenantTokenPromise;
  } finally {
    tenantTokenPromise = null;
  }
}

async function refreshTenantToken(): Promise<string> {
  const appId = await getSecret("FEISHU_APP_ID");
  if (!appId) {
    throw new Error("FEISHU_APP_ID not configured");
  }
  const appSecret = await getSecret("FEISHU_APP_SECRET");
  if (!appSecret) {
    throw new Error("FEISHU_APP_SECRET not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${API_URL}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Feishu token fetch failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    };
    if (data.code !== 0) {
      throw new Error(
        `Feishu token API error (code=${data.code}): ${data.msg || "unknown"}`,
      );
    }
    if (!data.tenant_access_token) {
      throw new Error("Feishu token response missing tenant_access_token");
    }
    tenantToken = data.tenant_access_token;
    tenantTokenExpiry = Date.now() + 5400_000;
    return tenantToken;
  } catch (err) {
    tenantToken = "";
    tenantTokenExpiry = 0;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(chatId: string, text: string) {
  const token = await getTenantToken();
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(
        `${API_URL}/im/v1/messages?receive_id_type=chat_id`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Feishu send failed (${res.status}): ${body.slice(0, 300)}`,
        );
      }
      const resData = (await res.json()) as { code?: number; msg?: string };
      if (resData.code !== 0) {
        throw new Error(
          `Feishu send API error (code=${resData.code}): ${resData.msg || "unknown"}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

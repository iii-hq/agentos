import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-discord",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

const DISCORD_API = "https://discord.com/api/v10";

registerFunction(
  {
    id: "channel::discord::webhook",
    description: "Handle Discord interaction/webhook",
  },
  async (req) => {
    const event = req.body || req;

    if (event.t === "MESSAGE_CREATE") {
      const msg = event.d;
      if (msg.author?.bot) return { status_code: 200, body: { ok: true } };

      const agentId = await resolveAgent(sdk, "discord", msg.channel_id);
      const response: any = await trigger({
        function_id: "agent::chat",
        payload: {
          agentId,
          message: msg.content,
          sessionId: `discord:${msg.channel_id}`,
        },
      });

      await sendMessage(msg.channel_id, response.content);
    }

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::discord::webhook",
  config: { api_path: "webhook/discord", http_method: "POST" },
});

async function sendMessage(channelId: string, content: string) {
  const botToken = await getSecret("DISCORD_BOT_TOKEN");
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN not configured");
  }
  const chunks = splitMessage(content, 2000);
  for (const chunk of chunks) {
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });
  }
}

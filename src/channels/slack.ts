import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import {
  splitMessage,
  resolveAgent,
  verifySlackSignature,
} from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-slack" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  { id: "channel::slack::events", description: "Handle Slack Events API" },
  async (req) => {
    const event = req.body || req;

    if (event.type === "url_verification") {
      return { status_code: 200, body: { challenge: event.challenge } };
    }

    const signingSecret = await getSecret("SLACK_SIGNING_SECRET");
    if (!signingSecret) {
      return {
        status_code: 500,
        body: { error: "SLACK_SIGNING_SECRET not configured" },
      };
    }
    try {
      verifySlackSignature(req, signingSecret);
    } catch (e: any) {
      return { status_code: 401, body: { error: e.message } };
    }

    if (event.event?.type === "message" && !event.event.bot_id) {
      const msg = event.event;
      const agentId = await resolveAgent(trigger, "slack", msg.channel);

      const response: any = await trigger("agent::chat", {
        agentId,
        message: msg.text,
        sessionId: `slack:${msg.channel}:${msg.thread_ts || msg.ts}`,
      });

      await sendMessage(msg.channel, response.content, msg.thread_ts || msg.ts);
    }

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::slack::events",
  config: { api_path: "webhook/slack/events", http_method: "POST" },
});

async function sendMessage(channel: string, text: string, threadTs?: string) {
  const botToken = await getSecret("SLACK_BOT_TOKEN");
  if (!botToken) {
    throw new Error("SLACK_BOT_TOKEN not configured");
  }
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });
  }
}

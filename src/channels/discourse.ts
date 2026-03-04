import { init } from "iii-sdk";
import { ENGINE_URL, createSecretGetter } from "../shared/config.js";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-discourse" },
);
const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::discourse::webhook",
    description: "Handle Discourse webhook",
  },
  async (req) => {
    const body = req.body || req;
    const post = body.post;

    if (!post?.raw) return { status_code: 200, body: { ok: true } };

    const topicId = post.topic_id;
    const text = post.raw;
    const username = post.username;

    const agentId = await resolveAgent(trigger, "discourse", String(topicId));

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `discourse:${topicId}`,
    });

    await sendMessage(topicId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "discourse", topicId, username },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::discourse::webhook",
  config: { api_path: "webhook/discourse", http_method: "POST" },
});

async function sendMessage(topicId: number, text: string) {
  const baseUrl = await getSecret("DISCOURSE_URL");
  if (!baseUrl) {
    throw new Error("DISCOURSE_URL not configured");
  }
  const apiKey = await getSecret("DISCOURSE_API_KEY");
  if (!apiKey) {
    throw new Error("DISCOURSE_API_KEY not configured");
  }
  const apiUsername = await getSecret("DISCOURSE_API_USERNAME");
  const res = await fetch(`${baseUrl}/posts.json`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Api-Username": apiUsername || "system",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topic_id: topicId,
      raw: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discourse send failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
}

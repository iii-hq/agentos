import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createSecretGetter } from "@agentos/shared/secrets";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-matrix",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const getSecret = createSecretGetter(trigger);

registerFunction(
  {
    id: "channel::matrix::webhook",
    description: "Handle Matrix homeserver webhook",
  },
  async (req) => {
    const event = req.body || req;

    if (event.type !== "m.room.message")
      return { status_code: 200, body: { ok: true } };

    const roomId = event.room_id;
    const text = event.content?.body || "";
    const sender = event.sender;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "matrix", roomId);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: text,
        sessionId: `matrix:${roomId}`,
      },
    });

    await sendMessage(roomId, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "matrix", roomId, sender },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::matrix::webhook",
  config: { api_path: "webhook/matrix", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string) {
  const homeserver = await getSecret("MATRIX_HOMESERVER");
  if (!homeserver) {
    throw new Error("MATRIX_HOMESERVER not configured");
  }
  const token = await getSecret("MATRIX_TOKEN");
  if (!token) {
    throw new Error("MATRIX_TOKEN not configured");
  }
  const txnId = crypto.randomUUID();
  const chunks = splitMessage(text, 4096);
  for (let i = 0; i < chunks.length; i++) {
    await fetch(
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}-${i}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body: chunks[i],
        }),
      },
    );
  }
}

import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createTransport } from "nodemailer";
import { splitMessage, resolveAgent } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "channel-email",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

const transporter = createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

registerFunction(
  {
    id: "channel::email::webhook",
    description: "Handle inbound email webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { from, to, subject, text } = body;

    if (!from || !text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(sdk, "email", to);

    const response: any = await trigger({
      function_id: "agent::chat",
      payload: {
        agentId,
        message: `Subject: ${subject || "(none)"}\n\n${text}`,
        sessionId: `email:${from}`,
      },
    });

    await sendMessage(from, `Re: ${subject || ""}`, response.content);

    trigger({
      function_id: "security::audit",
      payload: {
        type: "channel_message",
        agentId,
        detail: { channel: "email", from, to },
      },
      action: TriggerAction.Void(),
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::email::webhook",
  config: { api_path: "webhook/email", http_method: "POST" },
});

async function sendMessage(to: string, subject: string, text: string) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

import { init } from "iii-sdk";
import { ENGINE_URL } from "../shared/config.js";
import { createTransport } from "nodemailer";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "channel-email" },
);

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

    const agentId = await resolveAgent(trigger, "email", to);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: `Subject: ${subject || "(none)"}\n\n${text}`,
      sessionId: `email:${from}`,
    });

    await sendMessage(from, `Re: ${subject || ""}`, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "email", from, to },
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

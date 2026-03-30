import { createHmac, timingSafeEqual } from "crypto";
import { lookup } from "node:dns/promises";

export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

const BLOCKED_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  /^::1$/,
  /^fe80:/i,
  /^::ffff:/i,
  /^fc00:/i,
  /^fd/i,
  /^localhost$/i,
  /^.*\.local$/i,
  /^metadata\.google\.internal$/i,
];

export async function assertNoSsrf(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  const host = parsed.hostname;

  if (host === "localhost" || host === "0.0.0.0") {
    throw new Error(`SSRF blocked: ${host}`);
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(`SSRF blocked: ${host} is a private/reserved address`);
    }
  }

  try {
    const { address } = await lookup(host);
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(address)) {
        throw new Error(`SSRF blocked: ${host} resolves to ${address}`);
      }
    }
  } catch (e: any) {
    if (e.message?.startsWith("SSRF")) throw e;
  }
}

export async function resolveAgent(
  sdk: { trigger: (req: { function_id: string; payload: unknown }) => Promise<any> },
  channel: string,
  channelId: string,
): Promise<string> {
  const mapping = await sdk
    .trigger({
      function_id: "state::get",
      payload: { scope: "channel_agents", key: `${channel}:${channelId}` },
    })
    .catch(() => null);
  return mapping?.agentId || "default";
}

export function requireAuth(req: any): void {
  const expected = process.env.AGENTOS_API_KEY;
  if (!expected) {
    throw Object.assign(new Error("AGENTOS_API_KEY not configured"), {
      statusCode: 500,
    });
  }
  const header = req.headers?.["authorization"] || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, expected)) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function verifySlackSignature(req: any, signingSecret: string): void {
  const timestamp = req.headers?.["x-slack-request-timestamp"];
  const sig = req.headers?.["x-slack-signature"];
  if (!timestamp || !sig) throw new Error("Missing Slack signature headers");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Error("Stale Slack timestamp");
  }
  const body =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const baseString = `v0:${timestamp}:${body}`;
  const computed =
    "v0=" +
    createHmac("sha256", signingSecret).update(baseString).digest("hex");
  if (!safeEqual(computed, sig)) {
    throw new Error("Invalid Slack signature");
  }
}

export function verifyTelegramUpdate(secretToken: string, req: any): boolean {
  if (!secretToken) return false;
  const header = req.headers?.["x-telegram-bot-api-secret-token"] || "";
  if (!header) return false;
  return safeEqual(header, secretToken);
}

const MCP_COMMAND_ALLOWLIST = new Set([
  "npx",
  "node",
  "python3",
  "python",
  "uv",
  "uvx",
  "bun",
  "deno",
]);

export function validateMcpCommand(command: string): void {
  const base = command.split("/").pop() || command;
  if (!MCP_COMMAND_ALLOWLIST.has(base)) {
    throw new Error(
      `MCP command not allowed: ${command}. Allowed: ${[...MCP_COMMAND_ALLOWLIST].join(", ")}`,
    );
  }
}

export function stripSecretsFromEnv(): Record<string, string> {
  const SAFE_KEYS = new Set([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "NODE_PATH",
    "NODE_ENV",
    "PYTHONPATH",
  ]);
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (SAFE_KEYS.has(key) && val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}

export function sanitizeId(id: string): string {
  if (!id || !/^[a-zA-Z0-9_\-:.]{1,256}$/.test(id)) {
    throw Object.assign(new Error(`Invalid ID format: ${id}`), {
      statusCode: 400,
    });
  }
  return id;
}

export function stripCodeFences(text: string): string {
  return text
    .replace(/^```\w*\s*\n?/gm, "")
    .replace(/\n?```\s*$/gm, "")
    .trim();
}

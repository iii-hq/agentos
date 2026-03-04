import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  splitMessage,
  assertNoSsrf,
  resolveAgent,
  requireAuth,
  verifySlackSignature,
  verifyTelegramUpdate,
  validateMcpCommand,
  stripSecretsFromEnv,
  sanitizeId,
} from "../shared/utils.js";
import { createHmac } from "crypto";

describe("splitMessage", () => {
  it("returns single chunk when text fits within maxLen", () => {
    const result = splitMessage("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  it("returns single chunk when text equals maxLen", () => {
    const text = "a".repeat(50);
    const result = splitMessage(text, 50);
    expect(result).toEqual([text]);
  });

  it("splits on newline boundaries", () => {
    const text = "line1\nline2\nline3";
    const result = splitMessage(text, 10);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("")).toBe(text);
  });

  it("falls back to maxLen split when no newline in first half", () => {
    const text = "a".repeat(100);
    const result = splitMessage(text, 30);
    expect(result[0]).toHaveLength(30);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 10)).toEqual([""]);
  });

  it("preserves all content across chunks", () => {
    const text =
      "The quick brown fox jumps over the lazy dog\nAnother line here\nAnd another one";
    const chunks = splitMessage(text, 20);
    expect(chunks.join("")).toBe(text);
  });

  it("handles text with only newlines", () => {
    const text = "\n\n\n\n\n";
    const result = splitMessage(text, 3);
    expect(result.join("")).toBe(text);
  });

  it("handles single character maxLen", () => {
    const text = "abc";
    const result = splitMessage(text, 1);
    expect(result).toEqual(["a", "b", "c"]);
  });
});

describe("assertNoSsrf", () => {
  it("rejects localhost", async () => {
    await expect(assertNoSsrf("http://localhost:8080")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 127.0.0.1", async () => {
    await expect(assertNoSsrf("http://127.0.0.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 10.x.x.x", async () => {
    await expect(assertNoSsrf("http://10.0.0.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 172.16.x.x", async () => {
    await expect(assertNoSsrf("http://172.16.0.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 192.168.x.x", async () => {
    await expect(assertNoSsrf("http://192.168.1.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 169.254.x.x link-local", async () => {
    await expect(assertNoSsrf("http://169.254.169.254")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects metadata.google.internal", async () => {
    await expect(
      assertNoSsrf("http://metadata.google.internal"),
    ).rejects.toThrow("SSRF blocked");
  });

  it("rejects 0.0.0.0", async () => {
    await expect(assertNoSsrf("http://0.0.0.0")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects .local domains", async () => {
    await expect(assertNoSsrf("http://myhost.local")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects invalid URLs", async () => {
    await expect(assertNoSsrf("not-a-url")).rejects.toThrow("Invalid URL");
  });

  it("allows public URLs", async () => {
    await expect(assertNoSsrf("https://example.com")).resolves.toBeUndefined();
  });

  it("rejects 172.31.x.x (end of private range)", async () => {
    await expect(assertNoSsrf("http://172.31.255.255")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 100.64.x.x shared address space", async () => {
    await expect(assertNoSsrf("http://100.64.0.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });

  it("rejects 0.x.x.x addresses", async () => {
    await expect(assertNoSsrf("http://0.0.0.1")).rejects.toThrow(
      "SSRF blocked",
    );
  });
});

describe("resolveAgent", () => {
  it("returns agentId from mapping", async () => {
    const trigger = vi.fn().mockResolvedValue({ agentId: "agent-42" });
    const result = await resolveAgent(trigger, "slack", "C123");
    expect(result).toBe("agent-42");
    expect(trigger).toHaveBeenCalledWith("state::get", {
      scope: "channel_agents",
      key: "slack:C123",
    });
  });

  it("returns 'default' when no mapping exists", async () => {
    const trigger = vi.fn().mockResolvedValue(null);
    const result = await resolveAgent(trigger, "slack", "C999");
    expect(result).toBe("default");
  });

  it("returns 'default' when trigger fails", async () => {
    const trigger = vi.fn().mockRejectedValue(new Error("network"));
    const result = await resolveAgent(trigger, "discord", "guild-1");
    expect(result).toBe("default");
  });
});

describe("requireAuth", () => {
  const originalEnv = process.env.AGENTOS_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AGENTOS_API_KEY = originalEnv;
    } else {
      delete process.env.AGENTOS_API_KEY;
    }
  });

  it("throws 500 when AGENTOS_API_KEY not set", () => {
    delete process.env.AGENTOS_API_KEY;
    const req = { headers: { authorization: "Bearer test" } };
    expect(() => requireAuth(req)).toThrow("AGENTOS_API_KEY not configured");
  });

  it("throws 401 when no authorization header", () => {
    process.env.AGENTOS_API_KEY = "secret123";
    const req = { headers: {} };
    expect(() => requireAuth(req)).toThrow("Unauthorized");
  });

  it("throws 401 when token is wrong", () => {
    process.env.AGENTOS_API_KEY = "secret123";
    const req = { headers: { authorization: "Bearer wrong" } };
    expect(() => requireAuth(req)).toThrow("Unauthorized");
  });

  it("passes when token matches", () => {
    process.env.AGENTOS_API_KEY = "secret123";
    const req = { headers: { authorization: "Bearer secret123" } };
    expect(() => requireAuth(req)).not.toThrow();
  });

  it("handles Bearer prefix case-insensitively", () => {
    process.env.AGENTOS_API_KEY = "mykey";
    const req = { headers: { authorization: "bearer mykey" } };
    expect(() => requireAuth(req)).not.toThrow();
  });

  it("sets statusCode 500 on missing key error", () => {
    delete process.env.AGENTOS_API_KEY;
    try {
      requireAuth({ headers: {} });
    } catch (e: any) {
      expect(e.statusCode).toBe(500);
    }
  });

  it("sets statusCode 401 on auth failure", () => {
    process.env.AGENTOS_API_KEY = "key";
    try {
      requireAuth({ headers: { authorization: "Bearer bad" } });
    } catch (e: any) {
      expect(e.statusCode).toBe(401);
    }
  });
});

describe("verifySlackSignature", () => {
  const secret = "test_signing_secret";

  function makeSlackRequest(body: string, timestamp: string) {
    const baseString = `v0:${timestamp}:${body}`;
    const sig =
      "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");
    return {
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sig,
      },
      body,
    };
  }

  it("validates correct signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const req = makeSlackRequest('{"text":"hello"}', ts);
    expect(() => verifySlackSignature(req, secret)).not.toThrow();
  });

  it("rejects missing headers", () => {
    expect(() => verifySlackSignature({ headers: {} }, secret)).toThrow(
      "Missing Slack signature headers",
    );
  });

  it("rejects stale timestamp", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const req = makeSlackRequest("body", ts);
    expect(() => verifySlackSignature(req, secret)).toThrow(
      "Stale Slack timestamp",
    );
  });

  it("rejects wrong signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const req = {
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=incorrect",
      },
      body: "test",
    };
    expect(() => verifySlackSignature(req, secret)).toThrow(
      "Invalid Slack signature",
    );
  });
});

describe("verifyTelegramUpdate", () => {
  it("returns true when token matches header", () => {
    const req = { headers: { "x-telegram-bot-api-secret-token": "mysecret" } };
    expect(verifyTelegramUpdate("mysecret", req)).toBe(true);
  });

  it("returns false when token does not match", () => {
    const req = { headers: { "x-telegram-bot-api-secret-token": "wrong" } };
    expect(verifyTelegramUpdate("mysecret", req)).toBe(false);
  });

  it("returns false when no secret token provided", () => {
    const req = { headers: { "x-telegram-bot-api-secret-token": "test" } };
    expect(verifyTelegramUpdate("", req)).toBe(false);
  });

  it("returns false when no header present", () => {
    const req = { headers: {} };
    expect(verifyTelegramUpdate("mysecret", req)).toBe(false);
  });
});

describe("validateMcpCommand", () => {
  it("allows 'npx'", () => {
    expect(() => validateMcpCommand("npx")).not.toThrow();
  });

  it("allows 'node'", () => {
    expect(() => validateMcpCommand("node")).not.toThrow();
  });

  it("allows 'python3'", () => {
    expect(() => validateMcpCommand("python3")).not.toThrow();
  });

  it("allows 'bun'", () => {
    expect(() => validateMcpCommand("bun")).not.toThrow();
  });

  it("allows 'deno'", () => {
    expect(() => validateMcpCommand("deno")).not.toThrow();
  });

  it("allows full path to allowed command", () => {
    expect(() => validateMcpCommand("/usr/bin/node")).not.toThrow();
  });

  it("rejects disallowed commands", () => {
    expect(() => validateMcpCommand("bash")).toThrow("MCP command not allowed");
  });

  it("rejects 'rm'", () => {
    expect(() => validateMcpCommand("rm")).toThrow("MCP command not allowed");
  });

  it("rejects 'curl'", () => {
    expect(() => validateMcpCommand("curl")).toThrow("MCP command not allowed");
  });
});

describe("stripSecretsFromEnv", () => {
  it("includes PATH", () => {
    const result = stripSecretsFromEnv();
    if (process.env.PATH) {
      expect(result.PATH).toBe(process.env.PATH);
    }
  });

  it("includes HOME", () => {
    const result = stripSecretsFromEnv();
    if (process.env.HOME) {
      expect(result.HOME).toBe(process.env.HOME);
    }
  });

  it("excludes unknown keys", () => {
    const original = process.env.MY_SECRET_TOKEN;
    process.env.MY_SECRET_TOKEN = "hidden";
    const result = stripSecretsFromEnv();
    expect(result.MY_SECRET_TOKEN).toBeUndefined();
    if (original !== undefined) {
      process.env.MY_SECRET_TOKEN = original;
    } else {
      delete process.env.MY_SECRET_TOKEN;
    }
  });

  it("excludes API keys", () => {
    const original = process.env.AGENTOS_API_KEY;
    process.env.AGENTOS_API_KEY = "secret";
    const result = stripSecretsFromEnv();
    expect(result.AGENTOS_API_KEY).toBeUndefined();
    if (original !== undefined) {
      process.env.AGENTOS_API_KEY = original;
    } else {
      delete process.env.AGENTOS_API_KEY;
    }
  });

  it("returns only safe keys", () => {
    const result = stripSecretsFromEnv();
    const safeKeys = new Set([
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
    for (const key of Object.keys(result)) {
      expect(safeKeys.has(key)).toBe(true);
    }
  });
});

describe("sanitizeId", () => {
  it("returns valid alphanumeric id", () => {
    expect(sanitizeId("abc123")).toBe("abc123");
  });

  it("allows hyphens", () => {
    expect(sanitizeId("my-agent")).toBe("my-agent");
  });

  it("allows underscores", () => {
    expect(sanitizeId("my_agent")).toBe("my_agent");
  });

  it("allows colons", () => {
    expect(sanitizeId("agent:v1")).toBe("agent:v1");
  });

  it("allows dots", () => {
    expect(sanitizeId("agent.v1.0")).toBe("agent.v1.0");
  });

  it("rejects empty string", () => {
    expect(() => sanitizeId("")).toThrow("Invalid ID format");
  });

  it("rejects strings with spaces", () => {
    expect(() => sanitizeId("has space")).toThrow("Invalid ID format");
  });

  it("rejects strings with special characters", () => {
    expect(() => sanitizeId("agent@v1")).toThrow("Invalid ID format");
  });

  it("rejects strings longer than 256 chars", () => {
    expect(() => sanitizeId("a".repeat(257))).toThrow("Invalid ID format");
  });

  it("accepts exactly 256 char string", () => {
    expect(sanitizeId("a".repeat(256))).toBe("a".repeat(256));
  });

  it("sets statusCode 400 on error", () => {
    try {
      sanitizeId("");
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });
});

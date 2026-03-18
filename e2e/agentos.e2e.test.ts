import { describe, expect, it } from "vitest";

const shouldRunE2E = process.env.AGENTOS_E2E === "1";
const suite = shouldRunE2E ? describe : describe.skip;

const baseUrl = process.env.AGENTOS_BASE_URL || "http://127.0.0.1:3111";
const apiKey = process.env.AGENTOS_API_KEY || "";

function authHeaders(): Record<string, string> {
  if (!apiKey) {
    throw new Error(
      "AGENTOS_API_KEY is required for e2e tests. Export it before running `npm run test:e2e`.",
    );
  }
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

suite("AgentOS E2E", () => {
  it("health endpoint responds with 200", async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeTruthy();
  });

  it("chat_completions endpoint responds with valid shape", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Reply with the word READY only." }],
      }),
    });

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body?.object).toBe("chat.completion");
    expect(Array.isArray(body?.choices)).toBe(true);
    expect(typeof body?.choices?.[0]?.message?.content).toBe("string");
  });
});

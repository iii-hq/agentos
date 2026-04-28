import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
  if (fnId === "state::delete") { getScope(data.scope).delete(data.key); return { ok: true }; }
  if (fnId === "vault::get") return getScope("vault").get(data.key) ?? null;
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => { handlers[config.id] = handler; },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string, data?: any): Promise<any> => {
    if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
    if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
    if (fnId === "state::delete") { getScope(data.scope).delete(data.key); return { ok: true }; }
    if (fnId === "vault::get") return getScope("vault").get(data.key) ?? null;
    return null;
  });
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../security-map.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("security::map_challenge", () => {
  it("generates nonce", async () => {
    const result = await call("security::map_challenge", {
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    expect(result.nonce).toBeDefined();
    expect(result.nonce.length).toBe(64);
    expect(result.timestamp).toBeDefined();
    expect(result.sourceAgent).toBe("agent-a");
  });

  it("stores challenge in state", async () => {
    const result = await call("security::map_challenge", {
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    const setCalls = mockTrigger.mock.calls.filter(c => c[0] === "state::set" && c[1].scope === "map_challenges");
    expect(setCalls.length).toBe(1);
  });

  it("audits challenge issuance", async () => {
    await call("security::map_challenge", {
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "map_challenge_issued")).toBe(true);
  });

  it("throws when sourceAgent missing", async () => {
    await expect(
      call("security::map_challenge", { sourceAgent: "", targetAgent: "agent-b" }),
    ).rejects.toThrow("required");
  });

  it("throws when targetAgent missing", async () => {
    await expect(
      call("security::map_challenge", { sourceAgent: "agent-a", targetAgent: "" }),
    ).rejects.toThrow("required");
  });
});

describe("security::map_respond", () => {
  it("generates HMAC signature", async () => {
    getScope("vault").set("map:agent-b", { value: "shared-secret-123" });
    const result = await call("security::map_respond", {
      nonce: "abc123",
      sourceAgent: "agent-a",
      responderAgent: "agent-b",
      timestamp: Date.now(),
    });
    expect(result.signature).toBeDefined();
    expect(result.signature.length).toBe(64);
    expect(result.nonce).toBe("abc123");
  });

  it("throws when no shared secret configured", async () => {
    await expect(
      call("security::map_respond", {
        nonce: "abc",
        sourceAgent: "agent-a",
        responderAgent: "no-secret-agent",
        timestamp: Date.now(),
      }),
    ).rejects.toThrow("No shared secret");
  });

  it("throws when nonce missing", async () => {
    await expect(
      call("security::map_respond", {
        nonce: "",
        sourceAgent: "a",
        responderAgent: "b",
        timestamp: Date.now(),
      }),
    ).rejects.toThrow("required");
  });
});

describe("security::map_verify", () => {
  it("returns false for unknown nonce", async () => {
    const result = await call("security::map_verify", {
      body: { nonce: "unknown", signature: "abc", responderAgent: "agent-b" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("unknown_nonce");
  });

  it("returns false for expired challenge", async () => {
    getScope("map_challenges").set("expired-nonce", {
      nonce: "expired-nonce",
      timestamp: Date.now() - 120_000,
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    const result = await call("security::map_verify", {
      body: { nonce: "expired-nonce", signature: "abc", responderAgent: "agent-b" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("challenge_expired");
  });

  it("returns false for replay attack", async () => {
    const nonce = "replay-nonce";
    getScope("map_challenges").set(nonce, {
      nonce,
      timestamp: Date.now(),
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    getScope("map_used_nonces").set(nonce, { usedAt: Date.now() });
    const result = await call("security::map_verify", {
      body: { nonce, signature: "abc", responderAgent: "agent-b" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("replay_detected");
  });

  it("returns false when no shared secret", async () => {
    const nonce = "no-secret-nonce";
    getScope("map_challenges").set(nonce, {
      nonce,
      timestamp: Date.now(),
      sourceAgent: "agent-a",
      targetAgent: "agent-b",
    });
    const result = await call("security::map_verify", {
      body: { nonce, signature: "abc", responderAgent: "no-secret" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_shared_secret");
  });

  it("throws when params missing", async () => {
    await expect(
      call("security::map_verify", {
        body: { nonce: "", signature: "abc", responderAgent: "b" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("required");
  });

  it("audits failed verification", async () => {
    await call("security::map_verify", {
      body: { nonce: "unknown", signature: "abc", responderAgent: "agent-b" },
      headers: { authorization: "Bearer test-key" },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "map_verify_failed")).toBe(true);
  });
});

describe("handler registration", () => {
  it("registers security::map_challenge", () => {
    expect(handlers["security::map_challenge"]).toBeDefined();
  });

  it("registers security::map_respond", () => {
    expect(handlers["security::map_respond"]).toBeDefined();
  });

  it("registers security::map_verify", () => {
    expect(handlers["security::map_verify"]).toBeDefined();
  });
});

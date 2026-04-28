import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}
function seedKv(scope: string, key: string, value: unknown) {
  getScope(scope).set(key, value);
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../vault.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test-key" }, body, ...body };
}

describe("vault::init", () => {
  it("initializes vault with valid password", async () => {
    const result = await call(
      "vault::init",
      authReq({ password: "strong-password-123" }),
    );
    expect(result.unlocked).toBe(true);
    expect(result.autoLockMinutes).toBe(30);
  });

  it("rejects password shorter than 8 characters", async () => {
    await expect(
      call("vault::init", authReq({ password: "short" })),
    ).rejects.toThrow("at least 8 characters");
  });

  it("rejects empty password", async () => {
    await expect(
      call("vault::init", authReq({ password: "" })),
    ).rejects.toThrow("at least 8 characters");
  });

  it("respects custom autoLockMinutes", async () => {
    const result = await call(
      "vault::init",
      authReq({
        password: "long-enough",
        autoLockMinutes: 60,
      }),
    );
    expect(result.autoLockMinutes).toBe(60);
  });

  it("audits vault unlock event", async () => {
    await call("vault::init", authReq({ password: "password123" }));
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "vault_unlocked" }),
    );
  });

  it("reuses existing salt on re-init", async () => {
    await call("vault::init", authReq({ password: "password123" }));
    const meta1 = getScope("vault").get("__meta") as any;
    const salt1 = meta1.salt;

    await call("vault::init", authReq({ password: "password123" }));
    const meta2 = getScope("vault").get("__meta") as any;
    expect(meta2.salt).toBe(salt1);
  });
});

describe("vault::set and vault::get - encrypt/decrypt round-trip", () => {
  it("stores and retrieves a credential", async () => {
    await call("vault::init", authReq({ password: "test-password-1" }));
    await call(
      "vault::set",
      authReq({ key: "api-key", value: "secret-value-123" }),
    );
    const result = await call("vault::get", authReq({ key: "api-key" }));
    expect(result.value).toBe("secret-value-123");
    expect(result.key).toBe("api-key");
  });

  it("encrypts values (not stored in plaintext)", async () => {
    await call("vault::init", authReq({ password: "test-password-2" }));
    await call("vault::set", authReq({ key: "secret", value: "my-secret" }));
    const stored = getScope("vault").get("secret") as any;
    expect(stored.ciphertext).toBeDefined();
    expect(stored.ciphertext).not.toBe("my-secret");
    expect(stored.iv).toBeDefined();
    expect(stored.tag).toBeDefined();
  });

  it("handles special characters in values", async () => {
    await call("vault::init", authReq({ password: "test-password-3" }));
    const special = "key=val&foo=bar\n\ttab \"quotes\" 'single'";
    await call("vault::set", authReq({ key: "special", value: special }));
    const result = await call("vault::get", authReq({ key: "special" }));
    expect(result.value).toBe(special);
  });

  it("rejects empty string value (ciphertext is empty for empty input)", async () => {
    await call("vault::init", authReq({ password: "test-password-4" }));
    await call("vault::set", authReq({ key: "empty", value: "" }));
    await expect(call("vault::get", authReq({ key: "empty" }))).rejects.toThrow(
      "Credential not found",
    );
  });

  it("handles unicode values", async () => {
    await call("vault::init", authReq({ password: "test-password-5" }));
    const unicode =
      "emoji: \u{1f600} CJK: \u4f60\u597d arabic: \u0645\u0631\u062d\u0628\u0627";
    await call("vault::set", authReq({ key: "unicode", value: unicode }));
    const result = await call("vault::get", authReq({ key: "unicode" }));
    expect(result.value).toBe(unicode);
  });

  it("handles long values (1MB)", async () => {
    await call("vault::init", authReq({ password: "test-password-6" }));
    const longVal = "x".repeat(1024 * 1024);
    await call("vault::set", authReq({ key: "large", value: longVal }));
    const result = await call("vault::get", authReq({ key: "large" }));
    expect(result.value).toBe(longVal);
  });

  it("updates existing credential preserving createdAt", async () => {
    await call("vault::init", authReq({ password: "test-password-7" }));
    await call("vault::set", authReq({ key: "upd", value: "v1" }));
    const entry1 = getScope("vault").get("upd") as any;
    const created = entry1.createdAt;
    await call("vault::set", authReq({ key: "upd", value: "v2" }));
    const entry2 = getScope("vault").get("upd") as any;
    expect(entry2.createdAt).toBe(created);
    const result = await call("vault::get", authReq({ key: "upd" }));
    expect(result.value).toBe("v2");
  });
});

describe("vault::set - validation", () => {
  it("rejects keys starting with __", async () => {
    await call("vault::init", authReq({ password: "test-password-8" }));
    await expect(
      call("vault::set", authReq({ key: "__internal", value: "bad" })),
    ).rejects.toThrow("Invalid key");
  });

  it("rejects empty key", async () => {
    await call("vault::init", authReq({ password: "test-password-9" }));
    await expect(
      call("vault::set", authReq({ key: "", value: "test" })),
    ).rejects.toThrow("Invalid key");
  });

  it("requires vault::init before operations (assertUnlocked)", async () => {
    const result = await call(
      "vault::set",
      authReq({ key: "valid-key", value: "val" }),
    );
    expect(result.stored).toBe(true);
  });
});

describe("vault::get - edge cases", () => {
  it("throws for non-existent credential", async () => {
    await call("vault::init", authReq({ password: "test-password-10" }));
    await expect(
      call("vault::get", authReq({ key: "nonexistent" })),
    ).rejects.toThrow("Credential not found");
  });

  it("throws for missing key even when vault is unlocked", async () => {
    await call("vault::init", authReq({ password: "test-password-locked" }));
    await expect(
      call("vault::get", authReq({ key: "does-not-exist" })),
    ).rejects.toThrow("Credential not found");
  });

  it("audits vault get events", async () => {
    await call("vault::init", authReq({ password: "test-password-11" }));
    await call("vault::set", authReq({ key: "audited", value: "val" }));
    mockTriggerVoid.mockClear();
    await call("vault::get", authReq({ key: "audited" }));
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "vault_get" }),
    );
  });
});

describe("vault::list", () => {
  it("lists stored keys without values", async () => {
    await call("vault::init", authReq({ password: "test-password-12" }));
    await call("vault::set", authReq({ key: "key1", value: "val1" }));
    await call("vault::set", authReq({ key: "key2", value: "val2" }));
    const result = await call("vault::list", authReq({}));
    expect(result.count).toBe(2);
    expect(result.keys.map((k: any) => k.key).sort()).toEqual(["key1", "key2"]);
    const hasValue = result.keys.some((k: any) => k.value !== undefined);
    expect(hasValue).toBe(false);
  });

  it("excludes __meta from list", async () => {
    await call("vault::init", authReq({ password: "test-password-13" }));
    const result = await call("vault::list", authReq({}));
    const hasMeta = result.keys.some((k: any) => k.key === "__meta");
    expect(hasMeta).toBe(false);
  });
});

describe("vault::delete", () => {
  it("deletes a credential", async () => {
    await call("vault::init", authReq({ password: "test-password-14" }));
    await call("vault::set", authReq({ key: "del-me", value: "gone" }));
    const result = await call("vault::delete", authReq({ key: "del-me" }));
    expect(result.deleted).toBe(true);
    await expect(
      call("vault::get", authReq({ key: "del-me" })),
    ).rejects.toThrow("Credential not found");
  });

  it("prevents deleting __meta", async () => {
    await call("vault::init", authReq({ password: "test-password-15" }));
    await expect(
      call("vault::delete", authReq({ key: "__meta" })),
    ).rejects.toThrow("Cannot delete vault metadata");
  });

  it("audits delete event", async () => {
    await call("vault::init", authReq({ password: "test-password-16" }));
    await call("vault::set", authReq({ key: "audit-del", value: "x" }));
    mockTriggerVoid.mockClear();
    await call("vault::delete", authReq({ key: "audit-del" }));
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "vault_delete" }),
    );
  });
});

describe("vault::rotate - key rotation", () => {
  it("re-encrypts all credentials with new password", async () => {
    await call("vault::init", authReq({ password: "old-password1" }));
    await call("vault::set", authReq({ key: "cred1", value: "secret1" }));
    await call("vault::set", authReq({ key: "cred2", value: "secret2" }));

    await call(
      "vault::rotate",
      authReq({
        currentPassword: "old-password1",
        newPassword: "new-password1",
      }),
    );

    const r1 = await call("vault::get", authReq({ key: "cred1" }));
    expect(r1.value).toBe("secret1");
    const r2 = await call("vault::get", authReq({ key: "cred2" }));
    expect(r2.value).toBe("secret2");
  });

  it("rejects new password shorter than 8 chars", async () => {
    await call("vault::init", authReq({ password: "old-password2" }));
    await expect(
      call(
        "vault::rotate",
        authReq({
          currentPassword: "old-password2",
          newPassword: "short",
        }),
      ),
    ).rejects.toThrow("at least 8 characters");
  });

  it("returns count of rotated credentials", async () => {
    await call("vault::init", authReq({ password: "old-password3" }));
    await call("vault::set", authReq({ key: "r1", value: "v1" }));
    await call("vault::set", authReq({ key: "r2", value: "v2" }));
    await call("vault::set", authReq({ key: "r3", value: "v3" }));
    const result = await call(
      "vault::rotate",
      authReq({
        currentPassword: "old-password3",
        newPassword: "new-password3",
      }),
    );
    expect(result.rotated).toBe(3);
    expect(result.success).toBe(true);
  });

  it("audits rotation event", async () => {
    await call("vault::init", authReq({ password: "old-password4" }));
    mockTriggerVoid.mockClear();
    await call(
      "vault::rotate",
      authReq({
        currentPassword: "old-password4",
        newPassword: "new-password4",
      }),
    );
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({ type: "vault_rotated" }),
    );
  });

  it("updates salt after rotation", async () => {
    await call("vault::init", authReq({ password: "old-password5" }));
    const meta1 = getScope("vault").get("__meta") as any;
    const oldSalt = meta1.salt;
    await call(
      "vault::rotate",
      authReq({
        currentPassword: "old-password5",
        newPassword: "new-password5",
      }),
    );
    const meta2 = getScope("vault").get("__meta") as any;
    expect(meta2.salt).not.toBe(oldSalt);
  });
});

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
  if (fnId === "state::list") {
    const entries = [...getScope(data.scope).entries()].map(([key, value]) => ({ key, value }));
    return { entries };
  }
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
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

let ZeroizedBuffer: any;
let wrapZeroized: any;
let autoDispose: any;

beforeEach(() => {
  resetKv();
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(async (fnId: string, data?: any): Promise<any> => {
    if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
    if (fnId === "state::set") { getScope(data.scope).set(data.key, data.value); return { ok: true }; }
    if (fnId === "state::list") {
      const entries = [...getScope(data.scope).entries()].map(([key, value]) => ({ key, value }));
      return { entries };
    }
    return null;
  });
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  const mod = await import("../security-zeroize.js");
  ZeroizedBuffer = mod.ZeroizedBuffer;
  wrapZeroized = mod.wrapZeroized;
  autoDispose = mod.autoDispose;
});

describe("ZeroizedBuffer", () => {
  it("creates buffer from string", () => {
    const zb = new ZeroizedBuffer("secret");
    expect(zb.toString()).toBe("secret");
    zb.dispose();
  });

  it("creates buffer from Buffer", () => {
    const zb = new ZeroizedBuffer(Buffer.from("secret"));
    expect(zb.toString()).toBe("secret");
    zb.dispose();
  });

  it("read returns Buffer", () => {
    const zb = new ZeroizedBuffer("test");
    const buf = zb.read();
    expect(Buffer.isBuffer(buf)).toBe(true);
    zb.dispose();
  });

  it("throws after dispose on read", () => {
    const zb = new ZeroizedBuffer("secret");
    zb.dispose();
    expect(() => zb.read()).toThrow("already disposed");
  });

  it("throws after dispose on toString", () => {
    const zb = new ZeroizedBuffer("secret");
    zb.dispose();
    expect(() => zb.toString()).toThrow("already disposed");
  });

  it("isDisposed returns false before dispose", () => {
    const zb = new ZeroizedBuffer("test");
    expect(zb.isDisposed).toBe(false);
    zb.dispose();
  });

  it("isDisposed returns true after dispose", () => {
    const zb = new ZeroizedBuffer("test");
    zb.dispose();
    expect(zb.isDisposed).toBe(true);
  });

  it("double dispose is safe", () => {
    const zb = new ZeroizedBuffer("test");
    zb.dispose();
    zb.dispose();
    expect(zb.isDisposed).toBe(true);
  });
});

describe("wrapZeroized", () => {
  it("wraps string in ZeroizedBuffer", () => {
    const zb = wrapZeroized("my-secret");
    expect(zb.toString()).toBe("my-secret");
    zb.dispose();
  });

  it("wraps Buffer", () => {
    const zb = wrapZeroized(Buffer.from("data"));
    expect(zb.toString()).toBe("data");
    zb.dispose();
  });
});

describe("autoDispose", () => {
  it("auto-disposes after timeout", async () => {
    vi.useFakeTimers();
    const zb = wrapZeroized("ephemeral");
    autoDispose(zb, 100);
    expect(zb.isDisposed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(zb.isDisposed).toBe(true);
    vi.useRealTimers();
  });

  it("does not dispose before timeout", () => {
    vi.useFakeTimers();
    const zb = wrapZeroized("alive");
    autoDispose(zb, 5000);
    vi.advanceTimersByTime(1000);
    expect(zb.isDisposed).toBe(false);
    zb.dispose();
    vi.useRealTimers();
  });

  it("skips if already disposed", () => {
    vi.useFakeTimers();
    const zb = wrapZeroized("test");
    zb.dispose();
    autoDispose(zb, 100);
    vi.advanceTimersByTime(200);
    expect(zb.isDisposed).toBe(true);
    vi.useRealTimers();
  });
});

describe("security::zeroize_wrap handler", () => {
  it("wraps value and returns confirmation", async () => {
    const result = await handlers["security::zeroize_wrap"]({ value: "my-secret" });
    expect(result.wrapped).toBe(true);
    expect(result.autoDisposeMs).toBeDefined();
  });

  it("uses default auto dispose time", async () => {
    const result = await handlers["security::zeroize_wrap"]({ value: "test" });
    expect(result.autoDisposeMs).toBe(30000);
  });

  it("uses custom auto dispose time", async () => {
    const result = await handlers["security::zeroize_wrap"]({ value: "test", autoDisposeMs: 5000 });
    expect(result.autoDisposeMs).toBe(5000);
  });

  it("throws when value missing", async () => {
    await expect(
      handlers["security::zeroize_wrap"]({ value: "" }),
    ).rejects.toThrow("value is required");
  });
});

describe("security::zeroize_check handler", () => {
  it("returns clean when no secrets found", async () => {
    getScope("config").set("normal", { setting: "value" });
    const result = await handlers["security::zeroize_check"]({});
    expect(result.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("detects API key pattern", async () => {
    getScope("config").set("leaked", { api_key: "sk-abc12345678901234567890" });
    const result = await handlers["security::zeroize_check"]({});
    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("detects GitHub token pattern", async () => {
    getScope("sessions").set("sess1", { token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" });
    const result = await handlers["security::zeroize_check"]({});
    expect(result.clean).toBe(false);
  });

  it("detects Bearer token pattern", async () => {
    getScope("agents").set("agent1", { header: "Bearer eyJhbGciOiJIUzI1NiJ9.test" });
    const result = await handlers["security::zeroize_check"]({});
    expect(result.clean).toBe(false);
  });

  it("detects private key header", async () => {
    getScope("config").set("key", { cert: "-----BEGIN RSA PRIVATE KEY-----" });
    const result = await handlers["security::zeroize_check"]({});
    expect(result.clean).toBe(false);
  });

  it("scans custom scopes", async () => {
    getScope("custom_scope").set("data", { secret: "test-value" });
    const result = await handlers["security::zeroize_check"]({ scopes: ["custom_scope"] });
    expect(result.scanned).toBe(1);
  });

  it("audits findings", async () => {
    getScope("config").set("leaked", { api_key: "sk-abc12345678901234567890" });
    await handlers["security::zeroize_check"]({});
    const auditCalls = mockTriggerVoid.mock.calls.filter(c => c[0] === "security::audit");
    expect(auditCalls.some(c => c[1].type === "zeroize_scan_findings")).toBe(true);
  });

  it("returns scan count", async () => {
    const result = await handlers["security::zeroize_check"]({});
    expect(result.scanned).toBe(3);
  });
});

describe("handler registration", () => {
  it("registers security::zeroize_wrap", () => {
    expect(handlers["security::zeroize_wrap"]).toBeDefined();
  });

  it("registers security::zeroize_check", () => {
    expect(handlers["security::zeroize_check"]).toBeDefined();
  });
});

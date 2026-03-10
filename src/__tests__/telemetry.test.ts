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
  init: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
  }),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
});

beforeAll(async () => {
  await import("../telemetry.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("telemetry::summary", () => {
  it("returns memoryRss, memoryHeapUsed, memoryHeapTotal, uptimeSeconds, collectedAt", async () => {
    const result = await call("telemetry::summary", {});
    expect(result).toHaveProperty("memoryRss");
    expect(result).toHaveProperty("memoryHeapUsed");
    expect(result).toHaveProperty("memoryHeapTotal");
    expect(result).toHaveProperty("uptimeSeconds");
    expect(result).toHaveProperty("collectedAt");
    expect(typeof result.memoryRss).toBe("number");
    expect(typeof result.memoryHeapUsed).toBe("number");
    expect(typeof result.memoryHeapTotal).toBe("number");
    expect(typeof result.uptimeSeconds).toBe("number");
    expect(typeof result.collectedAt).toBe("string");
    expect(result.memoryRss).toBeGreaterThan(0);
    expect(result.uptimeSeconds).toBeGreaterThan(0);
  });
});

describe("telemetry::dashboard", () => {
  it("returns text and data properties", async () => {
    const result = await call("telemetry::dashboard", {});
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("data");
    expect(typeof result.text).toBe("string");
    expect(typeof result.data).toBe("object");
    expect(result.data).toHaveProperty("memoryRss");
    expect(result.data).toHaveProperty("memoryHeapUsed");
    expect(result.data).toHaveProperty("uptimeSeconds");
  });

  it("text contains Memory RSS, Heap Used, and Uptime", async () => {
    const result = await call("telemetry::dashboard", {});
    expect(result.text).toContain("Memory RSS");
    expect(result.text).toContain("Heap Used");
    expect(result.text).toContain("Uptime");
  });
});

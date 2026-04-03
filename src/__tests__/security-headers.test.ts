import { describe, it, expect, vi, beforeAll } from "vitest";

const handlers: Record<string, Function> = {};
const mockTrigger = vi.fn(
  async (_fnId?: string, _payload?: unknown): Promise<null> => null,
);
const mockTriggerVoid = vi.fn(
  (_fnId?: string, _payload?: unknown): void => undefined,
);
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

let SECURITY_HEADERS: Record<string, string>;
let applySecurityHeadersToObj: (headers: Record<string, string>) => Record<string, string>;

beforeAll(async () => {
  const mod = await import("../security-headers.js");
  SECURITY_HEADERS = mod.SECURITY_HEADERS;
  applySecurityHeadersToObj = mod.applySecurityHeadersToObj;
});

describe("SECURITY_HEADERS", () => {
  it("includes Content-Security-Policy", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBeDefined();
  });

  it("CSP includes default-src self", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("default-src 'self'");
  });

  it("CSP blocks object-src", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("object-src 'none'");
  });

  it("CSP blocks frame-ancestors", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("includes HSTS", () => {
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toContain("includeSubDomains");
  });

  it("includes X-Content-Type-Options nosniff", () => {
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("includes X-Frame-Options DENY", () => {
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("disables X-XSS-Protection", () => {
    expect(SECURITY_HEADERS["X-XSS-Protection"]).toBe("0");
  });

  it("includes Referrer-Policy", () => {
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("includes Permissions-Policy", () => {
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("camera=()");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("microphone=()");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("includes Cache-Control no-store", () => {
    expect(SECURITY_HEADERS["Cache-Control"]).toBe("no-store");
  });

  it("includes Pragma no-cache", () => {
    expect(SECURITY_HEADERS["Pragma"]).toBe("no-cache");
  });

  it("has at least 9 headers", () => {
    expect(Object.keys(SECURITY_HEADERS).length).toBeGreaterThanOrEqual(9);
  });
});

describe("applySecurityHeadersToObj", () => {
  it("merges security headers onto empty object", () => {
    const result = applySecurityHeadersToObj({});
    expect(result["X-Frame-Options"]).toBe("DENY");
    expect(result["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("preserves existing headers", () => {
    const result = applySecurityHeadersToObj({ "X-Custom": "value" });
    expect(result["X-Custom"]).toBe("value");
    expect(result["X-Frame-Options"]).toBe("DENY");
  });

  it("security headers override existing ones", () => {
    const result = applySecurityHeadersToObj({ "X-Frame-Options": "SAMEORIGIN" });
    expect(result["X-Frame-Options"]).toBe("DENY");
  });
});

describe("security::headers_apply handler", () => {
  it("registers the handler", () => {
    expect(handlers["security::headers_apply"]).toBeDefined();
  });

  it("applies headers and returns count", async () => {
    const result = await handlers["security::headers_apply"]({ headers: {} });
    expect(result.headers).toBeDefined();
    expect(result.applied).toBeGreaterThan(0);
  });

  it("uses empty headers when none provided", async () => {
    const result = await handlers["security::headers_apply"]({});
    expect(result.headers).toBeDefined();
    expect(result.headers["X-Frame-Options"]).toBe("DENY");
  });
});

describe("security::headers_check handler", () => {
  it("registers the handler", () => {
    expect(handlers["security::headers_check"]).toBeDefined();
  });

  it("returns not compliant when no URL provided", async () => {
    const result = await handlers["security::headers_check"]({});
    expect(result.compliant).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

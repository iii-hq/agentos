import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "security-headers",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger } = sdk;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

const REQUIRED_HEADER_KEYS = Object.keys(SECURITY_HEADERS);

export function applySecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export function applySecurityHeadersToObj(
  headers: Record<string, string>,
): Record<string, string> {
  return { ...headers, ...SECURITY_HEADERS };
}

registerFunction(
  {
    id: "security::headers_apply",
    description: "Apply security headers to a response object",
    metadata: { category: "security" },
  },
  async ({ headers }: { headers?: Record<string, string> }) => {
    const merged = applySecurityHeadersToObj(headers || {});
    return { headers: merged, applied: REQUIRED_HEADER_KEYS.length };
  },
);

registerFunction(
  {
    id: "security::headers_check",
    description: "Verify all required security headers are present",
    metadata: { category: "security" },
  },
  async ({ url }: { url?: string }) => {
    if (!url) {
      return {
        compliant: false,
        missing: REQUIRED_HEADER_KEYS,
        message: "No URL provided, returning full required header list",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });

      const missing: string[] = [];
      const present: string[] = [];

      for (const key of REQUIRED_HEADER_KEYS) {
        if (resp.headers.has(key)) {
          present.push(key);
        } else {
          missing.push(key);
        }
      }

      return {
        compliant: missing.length === 0,
        present,
        missing,
        url,
      };
    } finally {
      clearTimeout(timer);
    }
  },
);

registerTrigger({
  type: "http",
  function_id: "security::headers_check",
  config: { api_path: "api/security/headers/check", http_method: "POST" },
});

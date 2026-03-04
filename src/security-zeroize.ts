import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { randomFillSync } from "crypto";

const { registerFunction, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "security-zeroize" },
);

const AUTO_DISPOSE_MS = 30_000;

export class ZeroizedBuffer {
  private buffer: Buffer;
  private disposed = false;

  constructor(data: string | Buffer) {
    this.buffer = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf-8");
  }

  read(): Buffer {
    if (this.disposed) throw new Error("ZeroizedBuffer already disposed");
    return this.buffer;
  }

  toString(): string {
    if (this.disposed) throw new Error("ZeroizedBuffer already disposed");
    return this.buffer.toString("utf-8");
  }

  dispose(): void {
    if (!this.disposed) {
      randomFillSync(this.buffer);
      this.buffer.fill(0);
      this.disposed = true;
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

const registry = new FinalizationRegistry((ref: { buffer: Buffer }) => {
  ref.buffer.fill(0);
});

export function wrapZeroized(data: string | Buffer): ZeroizedBuffer {
  const zb = new ZeroizedBuffer(data);
  registry.register(zb, { buffer: (zb as any).buffer });
  return zb;
}

export function autoDispose(zb: ZeroizedBuffer, ms = AUTO_DISPOSE_MS): ZeroizedBuffer {
  const timer = setTimeout(() => {
    if (!zb.isDisposed) zb.dispose();
  }, ms);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return zb;
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  /(?:secret|password|passwd|token)\s*[:=]\s*\S+/i,
  /(?:sk|pk)[-_][a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /xox[bpas]-[a-zA-Z0-9\-]+/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/,
];

registerFunction(
  {
    id: "security::zeroize_wrap",
    description: "Wrap a secret string in a ZeroizedBuffer",
    metadata: { category: "security" },
  },
  async ({ value, autoDisposeMs }: { value: string; autoDisposeMs?: number }) => {
    if (!value) throw new Error("value is required");
    const zb = wrapZeroized(value);
    autoDispose(zb, autoDisposeMs || AUTO_DISPOSE_MS);
    return { wrapped: true, autoDisposeMs: autoDisposeMs || AUTO_DISPOSE_MS };
  },
);

registerFunction(
  {
    id: "security::zeroize_check",
    description: "Scan KV state for potential unzeroized secrets",
    metadata: { category: "security" },
  },
  async ({ scopes }: { scopes?: string[] }) => {
    const targetScopes = scopes || ["config", "sessions", "agents"];
    const findings: Array<{ scope: string; key: string; patterns: string[] }> = [];

    for (const scope of targetScopes) {
      const entries: any = await trigger("state::list", { scope }).catch(() => []);
      const items = Array.isArray(entries) ? entries : entries?.entries || [];
      for (const entry of items) {
        const str = JSON.stringify(entry.value || "");
        const matched = SECRET_PATTERNS
          .filter((p) => p.test(str))
          .map((p) => p.source.slice(0, 30));
        if (matched.length > 0) {
          findings.push({ scope, key: entry.key, patterns: matched });
        }
      }
    }

    if (findings.length > 0) {
      triggerVoid("security::audit", {
        type: "zeroize_scan_findings",
        detail: { count: findings.length, scopes: targetScopes },
      });
    }

    return { clean: findings.length === 0, findings, scanned: targetScopes.length };
  },
);

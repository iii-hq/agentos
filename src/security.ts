import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { createHash } from "crypto";
import { requireAuth } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "security" },
);

interface Capability {
  tools: string[];
  memoryScopes: string[];
  networkHosts: string[];
  maxTokensPerHour: number;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  type: string;
  agentId?: string;
  detail: Record<string, unknown>;
  hash: string;
  prevHash: string;
}

registerFunction(
  {
    id: "security::check_capability",
    description: "RBAC capability enforcement",
    metadata: { category: "security" },
  },
  async ({ agentId, capability, resource }) => {
    const caps = (await trigger("state::get", {
      scope: "capabilities",
      key: agentId,
    }).catch(() => null)) as Capability | null;

    if (!caps) {
      triggerVoid("security::audit", {
        type: "capability_denied",
        agentId,
        detail: { capability, resource, reason: "no_capabilities_defined" },
      });
      throw new Error(`Agent ${agentId} has no capabilities defined`);
    }

    const toolAllowed =
      caps.tools.includes("*") ||
      caps.tools.some((t) => resource.startsWith(t));

    if (!toolAllowed) {
      triggerVoid("security::audit", {
        type: "capability_denied",
        agentId,
        detail: { capability, resource, reason: "tool_not_allowed" },
      });
      throw new Error(`Agent ${agentId} denied: ${resource}`);
    }

    if (caps.maxTokensPerHour > 0) {
      const hourKey = new Date().toISOString().slice(0, 13);
      const hourUsage: any = await trigger("state::get", {
        scope: "metering_hourly",
        key: `${agentId}:${hourKey}`,
      }).catch(() => ({ tokens: 0 }));

      if ((hourUsage.tokens || 0) > caps.maxTokensPerHour) {
        triggerVoid("security::audit", {
          type: "quota_exceeded",
          agentId,
          detail: {
            used: hourUsage.tokens,
            limit: caps.maxTokensPerHour,
            hourKey,
          },
        });
        throw new Error(`Agent ${agentId} exceeded token quota`);
      }
    }

    return { allowed: true };
  },
);

registerFunction(
  {
    id: "security::set_capabilities",
    description: "Set agent capabilities",
    metadata: { category: "security" },
  },
  async ({
    agentId,
    capabilities,
  }: {
    agentId: string;
    capabilities: Capability;
  }) => {
    await trigger("state::set", {
      scope: "capabilities",
      key: agentId,
      value: capabilities,
    });
    triggerVoid("security::audit", {
      type: "capabilities_updated",
      agentId,
      detail: { tools: capabilities.tools.length },
    });
    return { updated: true };
  },
);

registerFunction(
  {
    id: "security::audit",
    description: "Append to merkle audit chain",
    metadata: { category: "security" },
  },
  async ({ type, agentId, detail }) => {
    const prev: any = await trigger("state::get", {
      scope: "audit",
      key: "__latest",
    }).catch(() => ({ hash: "0".repeat(64) }));

    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      agentId,
      detail: detail || {},
      prevHash: prev.hash,
      hash: "",
    };

    entry.hash = createHash("sha256")
      .update(JSON.stringify({ ...entry, hash: undefined }) + prev.hash)
      .digest("hex");

    await trigger("state::set", {
      scope: "audit",
      key: entry.id,
      value: entry,
    });

    await trigger("state::set", {
      scope: "audit",
      key: "__latest",
      value: { hash: entry.hash, id: entry.id, timestamp: entry.timestamp },
    });

    return { id: entry.id, hash: entry.hash };
  },
);

registerFunction(
  {
    id: "security::verify_audit",
    description: "Verify audit chain integrity",
    metadata: { category: "security" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const entries: any = await trigger("state::list", { scope: "audit" });
    const chain: AuditEntry[] = (entries || [])
      .filter((e: any) => e.key !== "__latest" && e.value?.hash)
      .map((e: any) => e.value)
      .sort((a: AuditEntry, b: AuditEntry) => a.timestamp - b.timestamp);

    let prevHash = "0".repeat(64);
    const violations: string[] = [];

    for (const entry of chain) {
      if (entry.prevHash !== prevHash) {
        violations.push(
          `Chain break at ${entry.id}: expected ${prevHash}, got ${entry.prevHash}`,
        );
      }

      const computed = createHash("sha256")
        .update(JSON.stringify({ ...entry, hash: undefined }) + entry.prevHash)
        .digest("hex");

      if (computed !== entry.hash) {
        violations.push(`Tampered entry ${entry.id}: hash mismatch`);
      }

      prevHash = entry.hash;
    }

    return {
      valid: violations.length === 0,
      entries: chain.length,
      violations,
    };
  },
);

registerFunction(
  {
    id: "security::scan_injection",
    description: "Scan text for prompt injection patterns",
    metadata: { category: "security" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { text } = req.body || req;
    if (!text) return { safe: true, matches: [], riskScore: 0 };
    const patterns = [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts)/i,
      /you\s+are\s+now\s+/i,
      /system\s*:\s*/i,
      /\bDAN\b.*\bmode\b/i,
      /pretend\s+you\s+are/i,
      /act\s+as\s+if\s+you/i,
      /disregard\s+(your|all)/i,
      /override\s+(your|system)/i,
      /jailbreak/i,
    ];

    const matches = patterns.filter((p) => p.test(text)).map((p) => p.source);

    return {
      safe: matches.length === 0,
      matches,
      riskScore: Math.min(1, matches.length * 0.25),
    };
  },
);

registerTrigger({
  type: "subscribe",
  function_id: "security::audit",
  config: { topic: "audit" },
});

registerTrigger({
  type: "http",
  function_id: "security::verify_audit",
  config: { api_path: "api/security/audit/verify", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "security::scan_injection",
  config: { api_path: "api/security/scan", http_method: "POST" },
});

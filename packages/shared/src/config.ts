import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { shutdownManager } from "./shutdown.js";

export const ENGINE_URL = process.env.III_ENGINE_URL || "ws://localhost:49134";
export const WORKSPACE_ROOT = process.env.AGENTOS_WORKSPACE || process.cwd();

export const OTEL_CONFIG = {
  enabled: true,
  serviceName: "agentos",
  serviceVersion: "0.0.1",
  metricsEnabled: true,
  fetchInstrumentationEnabled: true,
} as const;

export function registerShutdown(sdk: { shutdown?: () => Promise<void> }) {
  if (typeof sdk.shutdown === "function") {
    shutdownManager.registerIIIShutdown(sdk.shutdown);
  }
}

export function assertPathContained(resolved: string) {
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolve(resolved);
  }
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(WORKSPACE_ROOT);
  } catch {
    workspaceReal = resolve(WORKSPACE_ROOT);
  }
  const rel = relative(workspaceReal, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal denied: ${resolved}`);
  }
}

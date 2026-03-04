import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const ENGINE_URL = process.env.III_ENGINE_URL || "ws://localhost:49134";
export const WORKSPACE_ROOT = process.env.AGENTOS_WORKSPACE || process.cwd();

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

export type TriggerFn = (
  id: string,
  input: any,
  timeout?: number,
) => Promise<any>;

export function createSecretGetter(trigger: TriggerFn) {
  return async function getSecret(key: string): Promise<string> {
    try {
      const result: any = await trigger("vault::get", { key });
      return result?.value || process.env[key] || "";
    } catch {
      return process.env[key] || "";
    }
  };
}

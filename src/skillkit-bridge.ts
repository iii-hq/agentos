import { registerWorker } from "iii-sdk";
import {
  ENGINE_URL,
  OTEL_CONFIG,
  registerShutdown,
  WORKSPACE_ROOT,
} from "./shared/config.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";
import { resolve, join } from "path";

const execFileAsync = promisify(execFile);

const sdk = registerWorker(ENGINE_URL, {
  workerName: "skillkit-bridge",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger } = sdk;

const SAFE_ENV: Record<string, string> = {};
for (const key of [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "NODE_ENV",
  "SHELL",
]) {
  if (process.env[key]) SAFE_ENV[key] = process.env[key]!;
}

async function runSkillkit(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["skillkit", ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: SAFE_ENV,
        cwd: WORKSPACE_ROOT,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "").slice(0, 100_000),
      stderr: (err.stderr || err.message || "").slice(0, 50_000),
      exitCode: err.code || 1,
    };
  }
}

registerFunction(
  {
    id: "skillkit::search",
    description: "Search the SkillKit marketplace for skills",
    metadata: { category: "tool" },
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    if (!query || query.length < 2)
      throw new Error("Query must be at least 2 characters");

    const args = ["search", query, "--json"];
    if (limit) args.push("--limit", String(Math.min(limit, 50)));

    const { stdout, stderr, exitCode } = await runSkillkit(args);

    if (exitCode !== 0) {
      return { results: [], error: stderr, exitCode };
    }

    try {
      return { results: JSON.parse(stdout), exitCode: 0 };
    } catch {
      return { results: [], raw: stdout.slice(0, 10_000), exitCode: 0 };
    }
  },
);

registerFunction(
  {
    id: "skillkit::install",
    description: "Install a skill from the SkillKit marketplace",
    metadata: { category: "tool" },
  },
  async ({ id, agent }: { id: string; agent?: string }) => {
    if (!/^[\w\-@/.]{1,256}$/.test(id)) {
      throw new Error("Invalid skill ID format");
    }

    const args = ["install", id, "--json"];
    if (agent) {
      if (!/^[\w\-]{1,64}$/.test(agent)) throw new Error("Invalid agent name");
      args.push("--agent", agent);
    }

    const { stdout, stderr, exitCode } = await runSkillkit(args, 60_000);

    if (exitCode !== 0) {
      return { installed: false, error: stderr, exitCode };
    }

    try {
      return { installed: true, result: JSON.parse(stdout), exitCode: 0 };
    } catch {
      return { installed: true, raw: stdout.slice(0, 10_000), exitCode: 0 };
    }
  },
);

registerFunction(
  {
    id: "skillkit::list",
    description: "List installed SkillKit skills",
    metadata: { category: "tool" },
  },
  async () => {
    const { stdout, stderr, exitCode } = await runSkillkit(["list", "--json"]);

    if (exitCode !== 0) {
      return { skills: [], error: stderr, exitCode };
    }

    try {
      return { skills: JSON.parse(stdout), exitCode: 0 };
    } catch {
      return { skills: [], raw: stdout.slice(0, 10_000), exitCode: 0 };
    }
  },
);

registerFunction(
  {
    id: "skillkit::recommend",
    description: "Get skill recommendations based on workspace context",
    metadata: { category: "tool" },
  },
  async ({ context }: { context?: string }) => {
    const args = ["recommend", "--json"];
    if (context) args.push("--context", context);

    const { stdout, stderr, exitCode } = await runSkillkit(args);

    if (exitCode !== 0) {
      return { recommendations: [], error: stderr, exitCode };
    }

    try {
      return { recommendations: JSON.parse(stdout), exitCode: 0 };
    } catch {
      return { recommendations: [], raw: stdout.slice(0, 10_000), exitCode: 0 };
    }
  },
);

registerFunction(
  {
    id: "skillkit::scan",
    description: "Scan workspace for .well-known/ and SKILL.md files",
    metadata: { category: "tool" },
  },
  async ({ path: scanPath }: { path?: string }) => {
    const root = resolve(WORKSPACE_ROOT, scanPath || ".");
    const found: { type: string; path: string; content?: string }[] = [];

    async function scanDir(dir: string, depth: number) {
      if (depth > 3) return;
      if (found.length >= 50) return;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".well-known")
          continue;
        if (entry.name === "node_modules") continue;

        const fullPath = join(dir, entry.name);

        if (entry.name === "SKILL.md" && entry.isFile()) {
          try {
            const content = await readFile(fullPath, "utf-8");
            found.push({
              type: "skill",
              path: fullPath,
              content: content.slice(0, 5_000),
            });
          } catch {}
        }

        if (entry.name === ".well-known" && entry.isDirectory()) {
          try {
            const wkEntries = await readdir(fullPath, { withFileTypes: true });
            for (const wk of wkEntries) {
              if (wk.isFile()) {
                const wkContent = await readFile(
                  join(fullPath, wk.name),
                  "utf-8",
                ).catch(() => "");
                found.push({
                  type: "well-known",
                  path: join(fullPath, wk.name),
                  content: wkContent.slice(0, 5_000),
                });
              }
            }
          } catch {}
        }

        if (entry.isDirectory() && depth < 3) {
          await scanDir(fullPath, depth + 1);
        }
      }
    }

    await scanDir(root, 0);
    return { found, count: found.length, root };
  },
);

registerTrigger({
  type: "http",
  function_id: "skillkit::search",
  config: { api_path: "api/skillkit/search", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "skillkit::install",
  config: { api_path: "api/skillkit/install", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "skillkit::list",
  config: { api_path: "api/skillkit/list", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "skillkit::recommend",
  config: { api_path: "api/skillkit/recommend", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "skillkit::scan",
  config: { api_path: "api/skillkit/scan", http_method: "GET" },
});

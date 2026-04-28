import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import {
  ENGINE_URL,
  OTEL_CONFIG,
  registerShutdown,
  WORKSPACE_ROOT,
  assertPathContained,
} from "@agentos/shared/config";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import { realpathSync } from "node:fs";
import path, { resolve, relative, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { assertNoSsrf } from "@agentos/shared/utils";
import { safeCall } from "@agentos/shared/errors";
import { recordMetric } from "@agentos/shared/metrics";

const log = new Logger();
const execFileAsync = promisify(execFile);

const sdk = registerWorker(ENGINE_URL, {
  workerName: "tools",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });


async function withToolMetrics<T>(
  toolId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordMetric("tool_execution_total", 1, { toolId, status: "success" });
    recordMetric(
      "function_call_duration_ms",
      Date.now() - start,
      { functionId: toolId, status: "success" },
      "histogram",
    );
    return result;
  } catch (err) {
    recordMetric("tool_execution_total", 1, { toolId, status: "failure" });
    recordMetric(
      "function_call_duration_ms",
      Date.now() - start,
      { functionId: toolId, status: "error" },
      "histogram",
    );
    throw err;
  }
}

const TAINT_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "NODE_ENV",
]);

registerFunction(
  {
    id: "tool::file_read",
    description: "Read file contents with path containment",
    metadata: { category: "tools" },
  },
  async ({ path, maxBytes }: { path: string; maxBytes?: number }) => {
    return withToolMetrics("tool::file_read", async () => {
      const resolved = resolve(WORKSPACE_ROOT, path);
      assertPathContained(resolved);

      const content = await readFile(resolved, "utf-8");
      const limited = maxBytes ? content.slice(0, maxBytes) : content;
      return { content: limited, path: resolved, size: content.length };
    });
  },
);

registerFunction(
  {
    id: "tool::file_write",
    description: "Write file with path containment",
    metadata: { category: "tools" },
  },
  async ({ path, content }: { path: string; content: string }) => {
    return withToolMetrics("tool::file_write", async () => {
      const resolved = resolve(WORKSPACE_ROOT, path);
      assertPathContained(resolved);

      await writeFile(resolved, content, "utf-8");
      return { written: true, path: resolved, size: content.length };
    });
  },
);

registerFunction(
  {
    id: "tool::file_list",
    description: "List directory contents",
    metadata: { category: "tools" },
  },
  async ({ path, recursive }: { path: string; recursive?: boolean }) => {
    const resolved = resolve(WORKSPACE_ROOT, path || ".");
    assertPathContained(resolved);

    const entries = await readdir(resolved, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (e) => {
        const fullPath = join(resolved, e.name);
        const s = await safeCall(() => stat(fullPath), null, {
          operation: "file_stat",
          functionId: "tool::file_list",
        });
        return {
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          size: s?.size || 0,
          modified: s?.mtime?.toISOString(),
        };
      }),
    );

    return { path: resolved, entries: results };
  },
);

registerFunction(
  {
    id: "tool::apply_patch",
    description: "Apply a unified diff patch",
    metadata: { category: "tools" },
  },
  async ({ path, patch }: { path: string; patch: string }) => {
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");
    const patchLines = patch.split("\n");

    let output = [...lines];
    let offset = 0;

    for (const line of patchLines) {
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) offset = parseInt(match[1]) - 1;
      } else if (line.startsWith("-")) {
        const idx = output.indexOf(line.slice(1), offset);
        if (idx >= 0) {
          output.splice(idx, 1);
        }
      } else if (line.startsWith("+")) {
        output.splice(offset, 0, line.slice(1));
        offset++;
      } else if (!line.startsWith("\\")) {
        offset++;
      }
    }

    await writeFile(resolved, output.join("\n"), "utf-8");
    return { patched: true, path: resolved };
  },
);

const SHELL_COMMAND_ALLOWLIST = new Set([
  "git",
  "node",
  "npm",
  "npx",
  "bun",
  "deno",
  "python3",
  "python",
  "pip",
  "ls",
  "cat",
  "grep",
  "find",
  "echo",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "diff",
  "curl",
  "wget",
  "tar",
  "zip",
  "unzip",
  "jq",
  "sed",
  "awk",
  "which",
  "env",
  "date",
  "cargo",
  "rustc",
  "go",
  "make",
  "cmake",
]);

registerFunction(
  {
    id: "tool::shell_exec",
    description: "Execute command with sandbox (no shell interpretation)",
    metadata: { category: "tools" },
  },
  async ({
    argv,
    cwd,
    timeout,
  }: {
    argv: string[];
    cwd?: string;
    timeout?: number;
  }) => {
    const start = Date.now();
    if (!argv || argv.length === 0) {
      throw new Error("argv must be a non-empty array");
    }

    const binary = path.basename(argv[0]);
    if (!SHELL_COMMAND_ALLOWLIST.has(binary)) {
      throw new Error(
        `Command not allowed: ${argv[0]}. Allowed: ${[...SHELL_COMMAND_ALLOWLIST].join(", ")}`,
      );
    }

    const workDir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(workDir);

    try {
      const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
        cwd: workDir,
        timeout: timeout || 120_000,
        maxBuffer: 1024 * 1024,
        env: safeEnv(),
      });

      triggerVoid("security::audit", {
        type: "shell_exec",
        detail: { argv, cwd: workDir, exitCode: 0 },
      });

      recordMetric("tool_execution_total", 1, {
        toolId: "tool::shell_exec",
        status: "success",
      });
      recordMetric(
        "function_call_duration_ms",
        Date.now() - start,
        { functionId: "tool::shell_exec", status: "success" },
        "histogram",
      );

      return {
        stdout: stdout.slice(0, 100_000),
        stderr: stderr.slice(0, 50_000),
        exitCode: 0,
      };
    } catch (err: any) {
      recordMetric("tool_execution_total", 1, {
        toolId: "tool::shell_exec",
        status: "failure",
      });
      recordMetric(
        "function_call_duration_ms",
        Date.now() - start,
        { functionId: "tool::shell_exec", status: "error" },
        "histogram",
      );
      log.warn("Shell exec failed", {
        functionId: "tool::shell_exec",
        duration: Date.now() - start,
      });

      return {
        stdout: (err.stdout || "").slice(0, 100_000),
        stderr: (err.stderr || err.message || "").slice(0, 50_000),
        exitCode: err.code || 1,
      };
    }
  },
);

registerFunction(
  {
    id: "tool::web_fetch",
    description: "SSRF-protected HTTP fetch with HTML-to-text",
    metadata: { category: "tools" },
  },
  async ({ url, maxSize }: { url: string; maxSize?: number }) => {
    await assertNoSsrf(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      return await withToolMetrics("tool::web_fetch", async () => {
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "AgentOS/0.0.1" },
        });

        const contentType = resp.headers.get("content-type") || "";
        const text = await resp.text();
        const limit = maxSize || 500_000;
        const limited = text.slice(0, limit);
        const content = contentType.includes("html")
          ? htmlToText(limited)
          : limited;

        return {
          url,
          status: resp.status,
          contentType,
          content: content.slice(0, 100_000),
          truncated: text.length > limit,
        };
      });
    } finally {
      clearTimeout(timer);
    }
  },
);

registerFunction(
  {
    id: "tool::web_search",
    description: "Multi-provider web search",
    metadata: { category: "tools" },
  },
  async ({
    query,
    provider,
    maxResults,
  }: {
    query: string;
    provider?: string;
    maxResults?: number;
  }) => {
    const limit = maxResults || 5;

    if (provider === "tavily" && process.env.TAVILY_API_KEY) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            max_results: limit,
          }),
          signal: controller.signal,
        });
        const data = (await resp.json()) as any;
        return { results: data.results || [], provider: "tavily" };
      } finally {
        clearTimeout(timer);
      }
    }

    if (provider === "brave" && process.env.BRAVE_API_KEY) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const resp = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
          {
            headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY },
            signal: controller.signal,
          },
        );
        const data = (await resp.json()) as any;
        return {
          results: (data.web?.results || []).map((r: any) => ({
            title: r.title,
            url: r.url,
            content: r.description,
          })),
          provider: "brave",
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const ddgController = new AbortController();
    const ddgTimer = setTimeout(() => ddgController.abort(), 30_000);
    try {
      const ddgResp = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
        { signal: ddgController.signal },
      );
      const ddg = (await ddgResp.json()) as any;
      const results = (ddg.RelatedTopics || [])
        .slice(0, limit)
        .map((t: any) => ({
          title: t.Text?.slice(0, 100),
          url: t.FirstURL,
          content: t.Text,
        }));
      return { results, provider: "duckduckgo" };
    } finally {
      clearTimeout(ddgTimer);
    }
  },
);

const MAX_AGENT_DEPTH = 5;
const DEFAULT_MAX_SUB_AGENTS = 20;

registerFunction(
  {
    id: "tool::agent_spawn",
    description: "Spawn a sub-agent with depth limit and resource quota",
    metadata: { category: "tools" },
  },
  async ({
    template,
    parentId,
    message,
  }: {
    template: string;
    parentId?: string;
    message: string;
  }) => {
    let parentDepth = 0;
    let parentQuota = DEFAULT_MAX_SUB_AGENTS;
    if (parentId) {
      const depthEntry = await safeCall(
        () => trigger({ function_id: "state::get", payload: { scope: "agent_depth", key: parentId } }),
        null,
        { operation: "get_agent_depth", functionId: "tool::agent_spawn" },
      );
      parentDepth = (depthEntry as any)?.depth || 0;

      const quotaEntry: any = await safeCall(
        () => trigger({ function_id: "state::get", payload: { scope: "agent_quota", key: parentId } }),
        null,
        { operation: "get_agent_quota", functionId: "tool::agent_spawn" },
      );
      if (quotaEntry) {
        parentQuota = quotaEntry.remaining || 0;
      }
    }
    if (parentDepth >= MAX_AGENT_DEPTH) {
      throw new Error(`Max agent depth (${MAX_AGENT_DEPTH}) exceeded`);
    }
    if (parentQuota <= 0) {
      throw new Error(`Sub-agent quota exhausted for parent ${parentId}`);
    }

    const agentId = crypto.randomUUID();

    const result = await trigger({ function_id: "agent::create", payload: {
      id: agentId,
      name: `sub-${template}-${Date.now()}`,
      parentId,
      tags: ["sub-agent"],
    } });

    await trigger({ function_id: "state::set", payload: {
      scope: "agent_depth",
      key: agentId,
      value: {
        depth: parentDepth + 1,
        parent: parentId || null,
        createdAt: Date.now(),
      },
    } });

    const childQuota = Math.max(0, parentQuota - 1);
    await trigger({ function_id: "state::set", payload: {
      scope: "agent_quota",
      key: agentId,
      value: { remaining: childQuota, max: childQuota, parent: parentId },
    } });

    if (parentId) {
      await trigger({ function_id: "state::update", payload: {
        scope: "agent_quota",
        key: parentId,
        operations: [{ type: "increment", path: "remaining", value: -1 }],
      } });
    }

    const response: any = await trigger({ function_id: "agent::chat", payload: { agentId, message } });

    return { agentId, response: response.content, depth: parentDepth + 1 };
  },
);

const MESSAGE_MAX_BYTES = 100 * 1024;
const MESSAGE_QUEUE_MAX = 1000;
const AGENT_PAIR_RATE_WINDOW_MS = 60_000;
const AGENT_PAIR_RATE_LIMIT = 10;
const agentPairSendTimes = new Map<string, number[]>();

registerFunction(
  {
    id: "tool::agent_send",
    description: "Send message to another agent with spam prevention",
    metadata: { category: "tools" },
  },
  async ({
    agentId,
    targetAgentId,
    message,
  }: {
    agentId: string;
    targetAgentId: string;
    message: string;
  }) => {
    if (agentId) {
      const senderConfig = await safeCall(
        () => trigger({ function_id: "state::get", payload: { scope: "agents", key: agentId } }),
        null,
        { operation: "get_sender_config", functionId: "tool::agent_send" },
      );
      const allowed = (senderConfig as any)?.capabilities?.tools || [];
      if (!allowed.includes("*") && !allowed.includes("agent::send")) {
        throw new Error("Agent does not have agent::send capability");
      }
    }

    if (
      typeof message !== "string" ||
      Buffer.byteLength(message, "utf-8") > MESSAGE_MAX_BYTES
    ) {
      throw new Error(`Message exceeds size cap of ${MESSAGE_MAX_BYTES} bytes`);
    }

    const queueDepth: any = await safeCall(
      () =>
        trigger({ function_id: "state::get", payload: {
          scope: "agent_queue_depth",
          key: targetAgentId,
        } }),
      null,
      { operation: "get_queue_depth", functionId: "tool::agent_send" },
    );
    if (queueDepth && (queueDepth.count || 0) >= MESSAGE_QUEUE_MAX) {
      throw new Error(
        `Target agent ${targetAgentId} message queue full (max ${MESSAGE_QUEUE_MAX})`,
      );
    }

    const pairKey = `${agentId}:${targetAgentId}`;
    const now = Date.now();
    const times = agentPairSendTimes.get(pairKey) || [];
    const recent = times.filter((t) => now - t < AGENT_PAIR_RATE_WINDOW_MS);
    if (recent.length >= AGENT_PAIR_RATE_LIMIT) {
      throw new Error(
        `Rate limit exceeded: max ${AGENT_PAIR_RATE_LIMIT} messages per minute between agents`,
      );
    }
    recent.push(now);
    agentPairSendTimes.set(pairKey, recent);

    triggerVoid("state::update", {
      scope: "agent_queue_depth",
      key: targetAgentId,
      operations: [{ type: "increment", path: "count", value: 1 }],
    });

    triggerVoid("enqueue", {
      topic: "agent.inbox",
      data: { agentId: targetAgentId, message },
    });
    return { sent: true, targetAgentId };
  },
);

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of TAINT_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

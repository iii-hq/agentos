import { init } from "iii-sdk";
import {
  ENGINE_URL,
  WORKSPACE_ROOT,
  assertPathContained,
} from "./shared/config.js";
import { readFile } from "fs/promises";
import { realpathSync } from "node:fs";
import path, { resolve, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash, randomUUID } from "crypto";
import os from "os";
import { assertNoSsrf } from "./shared/utils.js";
import { safeCall } from "./shared/errors.js";

const execFileAsync = promisify(execFile);

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "tools-extended" },
);

const TAINT_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "NODE_ENV",
  "SHELL",
  "LC_ALL",
]);

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of TAINT_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

registerFunction(
  {
    id: "tool::schedule_reminder",
    description: "Store a reminder with a target time",
    metadata: { category: "tool" },
  },
  async ({
    label,
    time,
    agentId,
  }: {
    label: string;
    time: string;
    agentId?: string;
  }) => {
    const id = randomUUID();
    const parsed = new Date(time);
    if (isNaN(parsed.getTime())) throw new Error("Invalid time format");

    await trigger("state::set", {
      scope: "reminders",
      key: id,
      value: {
        id,
        label,
        time: parsed.toISOString(),
        agentId: agentId || null,
        createdAt: Date.now(),
      },
    });
    return { id, label, time: parsed.toISOString() };
  },
);

registerFunction(
  {
    id: "tool::cron_create",
    description: "Register a cron trigger for periodic execution",
    metadata: { category: "tool" },
  },
  async ({
    name,
    schedule,
    functionId,
    payload,
  }: {
    name: string;
    schedule: string;
    functionId: string;
    payload?: Record<string, unknown>;
  }) => {
    if (!/^[\w\-:.]{1,128}$/.test(name)) {
      throw new Error("Invalid cron name");
    }
    if (!/^[\w\-:.]{1,256}$/.test(functionId)) {
      throw new Error("Invalid function ID");
    }

    registerTrigger({
      type: "cron",
      function_id: functionId,
      config: { cron: schedule, name },
    });

    await trigger("state::set", {
      scope: "cron_jobs",
      key: name,
      value: { name, schedule, functionId, payload, createdAt: Date.now() },
    });
    return { created: true, name, schedule };
  },
);

registerFunction(
  {
    id: "tool::cron_list",
    description: "List all registered cron jobs",
    metadata: { category: "tool" },
  },
  async () => {
    const jobs: any = await safeCall(
      () => trigger("state::list", { scope: "cron_jobs" }),
      [],
      { operation: "list_cron_jobs", functionId: "tool::cron_list" },
    );
    return jobs.map((j: any) => j.value).filter(Boolean);
  },
);

registerFunction(
  {
    id: "tool::cron_delete",
    description: "Remove a cron job",
    metadata: { category: "tool" },
  },
  async ({ name }: { name: string }) => {
    await trigger("state::delete", { scope: "cron_jobs", key: name });
    return { deleted: true, name };
  },
);

registerFunction(
  {
    id: "tool::todo_create",
    description: "Create a todo item",
    metadata: { category: "tool" },
  },
  async ({
    title,
    description,
    priority,
    assignee,
  }: {
    title: string;
    description?: string;
    priority?: "low" | "medium" | "high";
    assignee?: string;
  }) => {
    const id = randomUUID();
    const todo = {
      id,
      title,
      description: description || "",
      priority: priority || "medium",
      assignee: assignee || null,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await trigger("state::set", { scope: "todos", key: id, value: todo });
    return todo;
  },
);

registerFunction(
  {
    id: "tool::todo_list",
    description: "List todo items",
    metadata: { category: "tool" },
  },
  async ({ status, assignee }: { status?: string; assignee?: string }) => {
    const items: any = await safeCall(
      () => trigger("state::list", { scope: "todos" }),
      [],
      { operation: "list_todos", functionId: "tool::todo_list" },
    );
    let todos = items.map((i: any) => i.value).filter(Boolean);

    if (status) todos = todos.filter((t: any) => t.status === status);
    if (assignee) todos = todos.filter((t: any) => t.assignee === assignee);

    return todos;
  },
);

registerFunction(
  {
    id: "tool::todo_update",
    description: "Update a todo item status or fields",
    metadata: { category: "tool" },
  },
  async ({
    id,
    status,
    title,
    description,
    priority,
    assignee,
  }: {
    id: string;
    status?: string;
    title?: string;
    description?: string;
    priority?: string;
    assignee?: string;
  }) => {
    const existing: any = await trigger("state::get", {
      scope: "todos",
      key: id,
    });
    if (!existing) throw new Error(`Todo not found: ${id}`);

    const updated = {
      ...existing,
      ...(status !== undefined && { status }),
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(priority !== undefined && { priority }),
      ...(assignee !== undefined && { assignee }),
      updatedAt: Date.now(),
    };
    await trigger("state::set", { scope: "todos", key: id, value: updated });
    return updated;
  },
);

registerFunction(
  {
    id: "tool::todo_delete",
    description: "Delete a todo item",
    metadata: { category: "tool" },
  },
  async ({ id }: { id: string }) => {
    await trigger("state::delete", { scope: "todos", key: id });
    return { deleted: true, id };
  },
);

registerFunction(
  {
    id: "tool::image_analyze",
    description: "Describe an image using LLM vision",
    metadata: { category: "tool" },
  },
  async ({ url, prompt }: { url: string; prompt?: string }) => {
    await assertNoSsrf(url);

    const result: any = await safeCall(
      () =>
        trigger("agent::chat", {
          agentId: "default",
          message: prompt || "Describe this image in detail.",
          images: [url],
        }),
      { content: "Vision analysis unavailable" },
      { operation: "image_analyze", functionId: "tool::image_analyze" },
    );

    return { url, description: result.content };
  },
);

registerFunction(
  {
    id: "tool::image_generate_prompt",
    description: "Generate an image generation prompt from a description",
    metadata: { category: "tool" },
  },
  async ({ description, style }: { description: string; style?: string }) => {
    const styleHint = style ? ` in ${style} style` : "";
    const result: any = await safeCall(
      () =>
        trigger("agent::chat", {
          agentId: "default",
          message: `Generate a detailed image generation prompt for: "${description}"${styleHint}. Return only the prompt text.`,
        }),
      { content: description },
      {
        operation: "generate_prompt",
        functionId: "tool::image_generate_prompt",
      },
    );

    return { prompt: result.content, originalDescription: description };
  },
);

registerFunction(
  {
    id: "tool::audio_transcribe",
    description: "Transcribe audio (stub - requires external API)",
    metadata: { category: "tool" },
  },
  async ({ url }: { url: string }) => {
    await assertNoSsrf(url);
    return {
      transcript: null,
      status: "not_implemented",
      message:
        "Audio transcription requires an external API (Whisper, Deepgram). Configure TRANSCRIPTION_API_URL.",
    };
  },
);

registerFunction(
  {
    id: "tool::tts_speak",
    description: "Text-to-speech (stub - requires external API)",
    metadata: { category: "tool" },
  },
  async ({ text, voice }: { text: string; voice?: string }) => {
    return {
      audioUrl: null,
      status: "not_implemented",
      message:
        "TTS requires an external API (ElevenLabs, OpenAI TTS). Configure TTS_API_URL.",
    };
  },
);

registerFunction(
  {
    id: "tool::media_download",
    description: "SSRF-protected media file download",
    metadata: { category: "tool" },
  },
  async ({
    url,
    outputPath,
    maxSize,
  }: {
    url: string;
    outputPath: string;
    maxSize?: number;
  }) => {
    await assertNoSsrf(url);
    const resolved = resolve(WORKSPACE_ROOT, outputPath);
    assertPathContained(resolved);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "AgentOS/0.0.1" },
      });

      if (!resp.ok) {
        return { downloaded: false, error: "HTTP " + resp.status };
      }

      const contentLength = parseInt(resp.headers.get("content-length") || "0");
      const limit = maxSize || 50_000_000;
      if (contentLength > limit) {
        throw new Error(
          `File too large: ${contentLength} bytes (max ${limit})`,
        );
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > limit) {
        throw new Error(
          `File too large: ${buffer.length} bytes (max ${limit})`,
        );
      }

      const { writeFile } = await import("fs/promises");
      await writeFile(resolved, buffer);

      return {
        downloaded: true,
        path: resolved,
        size: buffer.length,
        contentType: resp.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timer);
    }
  },
);

registerFunction(
  {
    id: "tool::kg_add",
    description: "Add an entity or relation to the knowledge graph",
    metadata: { category: "tool" },
  },
  async ({
    entity,
    type,
    relation,
    target,
    properties,
  }: {
    entity: string;
    type: string;
    relation?: string;
    target?: string;
    properties?: Record<string, unknown>;
  }) => {
    const entityKey = entity.toLowerCase().replace(/\s+/g, "_");

    const existing: any = await safeCall(
      () => trigger("state::get", { scope: "knowledge_graph", key: entityKey }),
      null,
      { operation: "get_kg_entity", functionId: "tool::kg_add" },
    );

    const node = existing || {
      entity,
      type,
      relations: [],
      properties: {},
      createdAt: Date.now(),
    };

    if (properties) {
      node.properties = { ...node.properties, ...properties };
    }

    if (relation && target) {
      const targetKey = target.toLowerCase().replace(/\s+/g, "_");
      const existingRel = node.relations.find(
        (r: any) => r.relation === relation && r.target === targetKey,
      );
      if (!existingRel) {
        node.relations.push({
          relation,
          target: targetKey,
          addedAt: Date.now(),
        });
      }
    }

    node.updatedAt = Date.now();
    await trigger("state::set", {
      scope: "knowledge_graph",
      key: entityKey,
      value: node,
    });

    return { entity: entityKey, type, relationsCount: node.relations.length };
  },
);

registerFunction(
  {
    id: "tool::kg_query",
    description: "Traverse the knowledge graph from an entity",
    metadata: { category: "tool" },
  },
  async ({
    entity,
    depth,
    relation,
  }: {
    entity: string;
    depth?: number;
    relation?: string;
  }) => {
    const maxDepth = Math.min(depth || 2, 5);
    const entityKey = entity.toLowerCase().replace(/\s+/g, "_");
    const visited = new Set<string>();
    const results: any[] = [];

    async function traverse(key: string, currentDepth: number) {
      if (currentDepth > maxDepth || visited.has(key)) return;
      if (visited.size >= 100) return;
      visited.add(key);

      const node: any = await safeCall(
        () => trigger("state::get", { scope: "knowledge_graph", key }),
        null,
        { operation: "traverse_kg", functionId: "tool::kg_query" },
      );

      if (!node) return;
      results.push({ ...node, _depth: currentDepth });

      let rels = node.relations || [];
      if (relation) rels = rels.filter((r: any) => r.relation === relation);

      for (const rel of rels) {
        await traverse(rel.target, currentDepth + 1);
      }
    }

    await traverse(entityKey, 0);
    return { root: entityKey, nodes: results, totalVisited: visited.size };
  },
);

registerFunction(
  {
    id: "tool::kg_visualize",
    description: "Generate a Mermaid diagram from the knowledge graph",
    metadata: { category: "tool" },
  },
  async ({ entity, depth }: { entity: string; depth?: number }) => {
    const maxDepth = Math.min(depth || 2, 4);
    const entityKey = entity.toLowerCase().replace(/\s+/g, "_");
    const visited = new Set<string>();
    const edges: string[] = [];

    async function traverse(key: string, currentDepth: number) {
      if (currentDepth > maxDepth || visited.has(key)) return;
      if (visited.size >= 50) return;
      visited.add(key);

      const node: any = await safeCall(
        () => trigger("state::get", { scope: "knowledge_graph", key }),
        null,
        { operation: "traverse_kg_vis", functionId: "tool::kg_visualize" },
      );
      if (!node) return;

      for (const rel of node.relations || []) {
        const safeKey = key.replace(/[^a-zA-Z0-9_]/g, "_");
        const safeTarget = rel.target.replace(/[^a-zA-Z0-9_]/g, "_");
        const safeRel = (rel.relation || "").replace(/[^a-zA-Z0-9_ ]/g, "");
        edges.push(`  ${safeKey} -->|${safeRel}| ${safeTarget}`);
        await traverse(rel.target, currentDepth + 1);
      }
    }

    await traverse(entityKey, 0);

    const mermaid = `graph TD\n${edges.join("\n")}`;
    return { mermaid, nodeCount: visited.size, edgeCount: edges.length };
  },
);

registerFunction(
  {
    id: "tool::memory_store",
    description: "Store a memory entry with metadata",
    metadata: { category: "tool" },
  },
  async ({
    key,
    content,
    tags,
    importance,
  }: {
    key: string;
    content: string;
    tags?: string[];
    importance?: number;
  }) => {
    const memoryKey = key || randomUUID();
    await trigger("state::set", {
      scope: "memories",
      key: memoryKey,
      value: {
        content,
        tags: tags || [],
        importance: importance || 5,
        createdAt: Date.now(),
        accessCount: 0,
      },
    });
    return { stored: true, key: memoryKey };
  },
);

registerFunction(
  {
    id: "tool::memory_recall",
    description: "Recall a memory by key",
    metadata: { category: "tool" },
  },
  async ({ key }: { key: string }) => {
    const memory: any = await safeCall(
      () => trigger("state::get", { scope: "memories", key }),
      null,
      { operation: "recall_memory", functionId: "tool::memory_recall" },
    );

    if (!memory) return { found: false, key };

    memory.accessCount = (memory.accessCount || 0) + 1;
    memory.lastAccessed = Date.now();
    await trigger("state::set", { scope: "memories", key, value: memory });

    return { found: true, ...memory };
  },
);

registerFunction(
  {
    id: "tool::memory_search",
    description: "Search memories by query across content and tags",
    metadata: { category: "tool" },
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    const all: any = await safeCall(
      () => trigger("state::list", { scope: "memories" }),
      [],
      { operation: "search_memories", functionId: "tool::memory_search" },
    );

    const q = query.toLowerCase();
    const matches = all
      .map((i: any) => i.value)
      .filter(Boolean)
      .filter(
        (m: any) =>
          m.content?.toLowerCase().includes(q) ||
          m.tags?.some((t: string) => t.toLowerCase().includes(q)),
      )
      .slice(0, limit || 20);

    return { results: matches, total: matches.length };
  },
);

registerFunction(
  {
    id: "tool::agent_list",
    description: "List running agents",
    metadata: { category: "tool" },
  },
  async () => {
    const agents: any = await safeCall(
      () => trigger("state::list", { scope: "agents" }),
      [],
      { operation: "list_agents", functionId: "tool::agent_list" },
    );
    return agents
      .map((a: any) => ({
        id: a.key,
        name: a.value?.name,
        tags: a.value?.tags,
        createdAt: a.value?.createdAt,
      }))
      .filter((a: any) => a.name);
  },
);

registerFunction(
  {
    id: "tool::agent_delegate",
    description: "Delegate a task to another agent",
    metadata: { category: "tool" },
  },
  async ({
    agentId,
    task,
    context,
  }: {
    agentId: string;
    task: string;
    context?: string;
  }) => {
    const message = context ? `${task}\n\nContext: ${context}` : task;
    const result: any = await trigger("agent::chat", { agentId, message });
    return { agentId, response: result.content };
  },
);

registerFunction(
  {
    id: "tool::channel_send",
    description: "Send a message to a channel",
    metadata: { category: "tool" },
  },
  async ({
    channel,
    channelId,
    message,
  }: {
    channel: string;
    channelId: string;
    message: string;
  }) => {
    triggerVoid("enqueue", {
      topic: `${channel}.outbound`,
      data: { channelId, message },
    });
    return { sent: true, channel, channelId };
  },
);

registerFunction(
  {
    id: "tool::env_get",
    description: "Get a filtered environment variable (safe list only)",
    metadata: { category: "tool" },
  },
  async ({ name }: { name: string }) => {
    if (!TAINT_ENV_ALLOWLIST.has(name)) {
      throw new Error(
        `Access denied for env var: ${name}. Allowed: ${[...TAINT_ENV_ALLOWLIST].join(", ")}`,
      );
    }
    return { name, value: process.env[name] || null };
  },
);

registerFunction(
  {
    id: "tool::system_info",
    description: "Get system information (OS, CPU, memory)",
    metadata: { category: "tool" },
  },
  async () => {
    return {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      nodeVersion: process.version,
    };
  },
);

registerFunction(
  {
    id: "tool::process_list",
    description: "List running processes",
    metadata: { category: "tool" },
  },
  async () => {
    const cmd = os.platform() === "win32" ? "tasklist" : "ps";
    const args =
      os.platform() === "win32"
        ? ["/fo", "csv", "/nh"]
        : ["aux", "--no-headers"];

    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: safeEnv(),
      });
      const lines = stdout.trim().split("\n").slice(0, 50);
      return { processes: lines, count: lines.length, truncated: true };
    } catch (err: any) {
      return { processes: [], error: err.message };
    }
  },
);

registerFunction(
  {
    id: "tool::disk_usage",
    description: "Get disk usage statistics",
    metadata: { category: "tool" },
  },
  async ({ path: diskPath }: { path?: string }) => {
    const target = diskPath || WORKSPACE_ROOT;
    const cmd = os.platform() === "win32" ? "wmic" : "df";
    const args =
      os.platform() === "win32"
        ? ["logicaldisk", "get", "size,freespace"]
        : ["-h", target];

    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: safeEnv(),
      });
      return { output: stdout.trim(), path: target };
    } catch (err: any) {
      return { error: err.message, path: target };
    }
  },
);

registerFunction(
  {
    id: "tool::network_check",
    description: "Check network connectivity",
    metadata: { category: "tool" },
  },
  async ({ host, timeout }: { host?: string; timeout?: number }) => {
    const target = host || "8.8.8.8";

    if (
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(
        target,
      )
    ) {
      throw new Error("Cannot check private/reserved addresses");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 5_000);

    try {
      const start = Date.now();
      await safeCall(
        () =>
          fetch(`https://${target}`, {
            method: "HEAD",
            signal: controller.signal,
          }),
        null,
        { operation: "network_check", functionId: "tool::network_check" },
      );
      const latency = Date.now() - start;

      return { reachable: true, host: target, latencyMs: latency };
    } catch {
      return { reachable: false, host: target, latencyMs: null };
    } finally {
      clearTimeout(timer);
    }
  },
);

registerFunction(
  {
    id: "tool::code_analyze",
    description: "Analyze code complexity (line counts, function counts)",
    metadata: { category: "tool" },
  },
  async ({ filePath }: { filePath: string }) => {
    const resolved = resolve(WORKSPACE_ROOT, filePath);
    assertPathContained(resolved);

    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");
    const ext = path.extname(resolved);

    const functionPattern =
      ext === ".py"
        ? /^\s*(def|async\s+def)\s+\w+/
        : /^\s*(function|const\s+\w+\s*=\s*(async\s+)?\(|async\s+\w+\s*\(|export\s+(async\s+)?function)/;

    const classPattern =
      ext === ".py" ? /^\s*class\s+\w+/ : /^\s*(class|export\s+class)\s+\w+/;

    let functions = 0;
    let classes = 0;
    let comments = 0;
    let blankLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") blankLines++;
      else if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      )
        comments++;
      if (functionPattern.test(line)) functions++;
      if (classPattern.test(line)) classes++;
    }

    return {
      path: resolved,
      totalLines: lines.length,
      codeLines: lines.length - blankLines - comments,
      blankLines,
      comments,
      functions,
      classes,
      extension: ext,
    };
  },
);

registerFunction(
  {
    id: "tool::code_format",
    description: "Format code using prettier or language-specific formatter",
    metadata: { category: "tool" },
  },
  async ({ filePath, formatter }: { filePath: string; formatter?: string }) => {
    const resolved = resolve(WORKSPACE_ROOT, filePath);
    assertPathContained(resolved);

    const ext = path.extname(resolved);
    let cmd: string;
    let args: string[];

    if (formatter === "rustfmt" || ext === ".rs") {
      cmd = "rustfmt";
      args = [resolved];
    } else if (formatter === "black" || ext === ".py") {
      cmd = "python3";
      args = ["-m", "black", resolved];
    } else {
      cmd = "npx";
      args = ["prettier", "--write", resolved];
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: WORKSPACE_ROOT,
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        env: safeEnv(),
      });
      return { formatted: true, path: resolved, output: stdout || stderr };
    } catch (err: any) {
      return {
        formatted: false,
        path: resolved,
        error: (err.stderr || err.message || "").slice(0, 10_000),
      };
    }
  },
);

registerFunction(
  {
    id: "tool::code_lint",
    description: "Lint code using eslint or language-specific linter",
    metadata: { category: "tool" },
  },
  async ({ filePath, linter }: { filePath: string; linter?: string }) => {
    const resolved = resolve(WORKSPACE_ROOT, filePath);
    assertPathContained(resolved);

    const ext = path.extname(resolved);
    let cmd: string;
    let args: string[];

    if (linter === "clippy" || ext === ".rs") {
      cmd = "cargo";
      args = ["clippy", "--message-format=json"];
    } else if (linter === "pylint" || ext === ".py") {
      cmd = "python3";
      args = ["-m", "pylint", "--output-format=json", resolved];
    } else {
      cmd = "npx";
      args = ["eslint", "--format=json", resolved];
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: WORKSPACE_ROOT,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: safeEnv(),
      });
      return {
        path: resolved,
        output: (stdout || stderr).slice(0, 50_000),
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        path: resolved,
        output: (err.stdout || err.stderr || err.message || "").slice(
          0,
          50_000,
        ),
        exitCode: err.code || 1,
      };
    }
  },
);

registerFunction(
  {
    id: "tool::code_test",
    description: "Run tests using a specified command",
    metadata: { category: "tool" },
  },
  async ({
    command,
    cwd,
    timeout,
  }: {
    command: string[];
    cwd?: string;
    timeout?: number;
  }) => {
    if (!command || command.length === 0) {
      throw new Error("command must be a non-empty array");
    }

    const ALLOWED_TEST_COMMANDS = new Set([
      "npm",
      "npx",
      "bun",
      "deno",
      "node",
      "python3",
      "python",
      "cargo",
      "go",
      "make",
    ]);
    const binary = path.basename(command[0]);
    if (!ALLOWED_TEST_COMMANDS.has(binary)) {
      throw new Error(
        `Test command not allowed: ${command[0]}. Allowed: ${[...ALLOWED_TEST_COMMANDS].join(", ")}`,
      );
    }

    const workDir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(workDir);

    try {
      const { stdout, stderr } = await execFileAsync(
        command[0],
        command.slice(1),
        {
          cwd: workDir,
          timeout: timeout || 120_000,
          maxBuffer: 2 * 1024 * 1024,
          env: safeEnv(),
        },
      );
      return {
        stdout: stdout.slice(0, 100_000),
        stderr: stderr.slice(0, 50_000),
        exitCode: 0,
      };
    } catch (err: any) {
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
    id: "tool::code_explain",
    description: "Explain code using LLM",
    metadata: { category: "tool" },
  },
  async ({ filePath, question }: { filePath: string; question?: string }) => {
    const resolved = resolve(WORKSPACE_ROOT, filePath);
    assertPathContained(resolved);

    const content = await readFile(resolved, "utf-8");
    const truncated = content.slice(0, 50_000);

    const prompt = question
      ? `Explain this code, focusing on: ${question}\n\n\`\`\`\n${truncated}\n\`\`\``
      : `Explain what this code does:\n\n\`\`\`\n${truncated}\n\`\`\``;

    const result: any = await safeCall(
      () => trigger("agent::chat", { agentId: "default", message: prompt }),
      { content: "Code explanation unavailable" },
      { operation: "code_explain", functionId: "tool::code_explain" },
    );

    return { path: resolved, explanation: result.content };
  },
);

registerFunction(
  {
    id: "tool::json_transform",
    description: "Transform JSON data using jq-like expressions",
    metadata: { category: "tool" },
  },
  async ({ data, expression }: { data: string; expression: string }) => {
    const parsed = JSON.parse(data);

    if (expression === ".") return { result: parsed };
    if (expression.startsWith(".keys")) return { result: Object.keys(parsed) };
    if (expression.startsWith(".values"))
      return { result: Object.values(parsed) };
    if (expression.startsWith(".length")) {
      return {
        result: Array.isArray(parsed)
          ? parsed.length
          : Object.keys(parsed).length,
      };
    }

    const keys = expression.replace(/^\.|^\[/g, "").split(/[.\[]/);
    let current: any = parsed;
    for (const k of keys) {
      const cleanKey = k.replace(/[\]"']/g, "");
      if (current === null || current === undefined) break;
      current = current[cleanKey];
    }

    return { result: current };
  },
);

registerFunction(
  {
    id: "tool::csv_parse",
    description: "Parse CSV text to JSON",
    metadata: { category: "tool" },
  },
  async ({
    content,
    delimiter,
    hasHeader,
  }: {
    content: string;
    delimiter?: string;
    hasHeader?: boolean;
  }) => {
    const sep = delimiter || ",";
    const lines = content.trim().split("\n");
    if (lines.length === 0) return { rows: [], headers: [] };

    const useHeader = hasHeader !== false;
    const headers = useHeader
      ? lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ""))
      : [];
    const dataLines = useHeader ? lines.slice(1) : lines;

    const rows = dataLines.map((line) => {
      const values = line.split(sep).map((v) => v.trim().replace(/^"|"$/g, ""));
      if (useHeader) {
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          row[h] = values[i] || "";
        });
        return row;
      }
      return values;
    });

    return { rows, headers, rowCount: rows.length };
  },
);

registerFunction(
  {
    id: "tool::yaml_parse",
    description: "Parse YAML text to JSON (simple subset)",
    metadata: { category: "tool" },
  },
  async ({ content }: { content: string }) => {
    const result: Record<string, any> = {};
    const lines = content.split("\n");
    const stack: { indent: number; obj: any; key?: string }[] = [
      { indent: -1, obj: result },
    ];

    for (const line of lines) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;

      const indent = line.search(/\S/);
      const trimmed = line.trim();

      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].obj;

      if (trimmed.startsWith("- ")) {
        const val = trimmed.slice(2).trim();
        if (!Array.isArray(parent)) {
          const key = stack[stack.length - 1].key;
          if (key) {
            const container =
              stack.length > 2 ? stack[stack.length - 2].obj : result;
            container[key] = [val];
            stack[stack.length - 1].obj = container[key];
          }
        } else {
          parent.push(val);
        }
      } else if (trimmed.includes(":")) {
        const colonIdx = trimmed.indexOf(":");
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();

        if (val === "" || val === "|" || val === ">") {
          parent[key] = {};
          stack.push({ indent, obj: parent[key], key });
        } else {
          let parsed: any = val;
          if (val === "true") parsed = true;
          else if (val === "false") parsed = false;
          else if (val === "null") parsed = null;
          else if (/^-?\d+(\.\d+)?$/.test(val)) parsed = Number(val);
          else parsed = val.replace(/^['"]|['"]$/g, "");

          parent[key] = parsed;
        }
      }
    }

    return { result };
  },
);

registerFunction(
  {
    id: "tool::regex_test",
    description: "Test a regex pattern against text",
    metadata: { category: "tool" },
  },
  async ({
    pattern,
    text,
    flags,
  }: {
    pattern: string;
    text: string;
    flags?: string;
  }) => {
    const safeFlags = (flags || "g").replace(/[^gimsuy]/g, "");
    const regex = new RegExp(pattern, safeFlags);
    const matches: any[] = [];
    let match: RegExpExecArray | null;

    let iterations = 0;
    while ((match = regex.exec(text)) !== null && iterations < 1000) {
      matches.push({
        match: match[0],
        index: match.index,
        groups: match.groups || null,
        captures: match.slice(1),
      });
      if (!regex.global) break;
      iterations++;
    }

    return { pattern, flags: safeFlags, matches, count: matches.length };
  },
);

registerFunction(
  {
    id: "tool::uuid_generate",
    description: "Generate a UUID v4",
    metadata: { category: "tool" },
  },
  async ({ count }: { count?: number }) => {
    const n = Math.min(count || 1, 100);
    const uuids = Array.from({ length: n }, () => randomUUID());
    return { uuids, count: n };
  },
);

registerFunction(
  {
    id: "tool::hash_compute",
    description: "Compute a hash (sha256, md5, sha1)",
    metadata: { category: "tool" },
  },
  async ({
    input,
    algorithm,
    encoding,
  }: {
    input: string;
    algorithm?: string;
    encoding?: "hex" | "base64";
  }) => {
    const ALLOWED_ALGORITHMS = new Set(["sha256", "sha1", "md5", "sha512"]);
    const algo = algorithm || "sha256";
    if (!ALLOWED_ALGORITHMS.has(algo)) {
      throw new Error(
        `Unsupported algorithm: ${algo}. Allowed: ${[...ALLOWED_ALGORITHMS].join(", ")}`,
      );
    }
    const enc = encoding || "hex";
    const hash = createHash(algo).update(input).digest(enc);
    return { hash, algorithm: algo, encoding: enc };
  },
);

registerFunction(
  {
    id: "tool::vector_store",
    description: "Store text with vector embedding for similarity search",
    metadata: { category: "tool" },
  },
  async ({
    id,
    text,
    metadata,
    namespace,
  }: {
    id?: string;
    text: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
  }) => {
    if (!text) throw new Error("text is required");
    const docId = id || randomUUID();
    const ns = namespace || "default";
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const wordSet = new Set(words);
    const termFreq: Record<string, number> = {};
    for (const w of words) {
      termFreq[w] = (termFreq[w] || 0) + 1;
    }

    await trigger("state::set", {
      scope: `vector_store:${ns}`,
      key: docId,
      value: {
        id: docId,
        text,
        metadata: metadata || {},
        terms: Object.fromEntries([...wordSet].map((w) => [w, termFreq[w]])),
        wordCount: words.length,
        storedAt: Date.now(),
      },
    });
    return { stored: true, id: docId, namespace: ns };
  },
);

registerFunction(
  {
    id: "tool::vector_search",
    description: "Search stored documents by similarity using BM25 scoring",
    metadata: { category: "tool" },
  },
  async ({
    query,
    namespace,
    limit,
  }: {
    query: string;
    namespace?: string;
    limit?: number;
  }) => {
    if (!query) throw new Error("query is required");
    const ns = namespace || "default";
    const maxResults = Math.min(limit || 10, 100);
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const docs = (await trigger("state::list", {
      scope: `vector_store:${ns}`,
    }).catch(() => [])) as any[];

    const k1 = 1.5;
    const b = 0.75;
    const entries = docs.map((d: any) => d.value).filter(Boolean);
    const avgDl =
      entries.length > 0
        ? entries.reduce((s: number, e: any) => s + (e.wordCount || 0), 0) /
          entries.length
        : 1;
    const N = entries.length || 1;

    const scored = entries.map((doc: any) => {
      let score = 0;
      for (const qt of queryTerms) {
        const tf = doc.terms?.[qt] || 0;
        const df = entries.filter((e: any) => e.terms?.[qt]).length;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const dl = doc.wordCount || 1;
        score +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl))));
      }
      return { id: doc.id, text: doc.text, metadata: doc.metadata, score };
    });

    scored.sort((a: any, b: any) => b.score - a.score);
    return { results: scored.slice(0, maxResults), total: entries.length };
  },
);

registerFunction(
  {
    id: "tool::vector_delete",
    description: "Delete a document from vector store",
    metadata: { category: "tool" },
  },
  async ({ id, namespace }: { id: string; namespace?: string }) => {
    if (!id) throw new Error("id is required");
    const ns = namespace || "default";
    await trigger("state::delete", { scope: `vector_store:${ns}`, key: id });
    return { deleted: true, id };
  },
);

registerFunction(
  {
    id: "tool::git_status",
    description: "Get git repository status, branch, and recent log",
    metadata: { category: "tool" },
  },
  async ({ cwd }: { cwd?: string }) => {
    const dir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(dir);

    const [statusResult, branchResult, logResult] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: dir,
        env: safeEnv(),
      }).catch((e: any) => ({ stdout: "", stderr: e.message })),
      execFileAsync("git", ["branch", "--show-current"], {
        cwd: dir,
        env: safeEnv(),
      }).catch((e: any) => ({ stdout: "unknown", stderr: e.message })),
      execFileAsync("git", ["log", "--oneline", "-10"], {
        cwd: dir,
        env: safeEnv(),
      }).catch((e: any) => ({ stdout: "", stderr: e.message })),
    ]);

    return {
      branch: (statusResult as any).stdout?.trim()
        ? undefined
        : (branchResult as any).stdout?.trim(),
      currentBranch: (branchResult as any).stdout?.trim(),
      status:
        (statusResult as any).stdout?.trim().split("\n").filter(Boolean) || [],
      recentCommits:
        (logResult as any).stdout?.trim().split("\n").filter(Boolean) || [],
    };
  },
);

registerFunction(
  {
    id: "tool::git_diff",
    description: "Show git diff for staged or unstaged changes",
    metadata: { category: "tool" },
  },
  async ({
    staged,
    file,
    cwd,
  }: {
    staged?: boolean;
    file?: string;
    cwd?: string;
  }) => {
    const dir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(dir);

    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) {
      const filePath = resolve(dir, file);
      assertPathContained(filePath);
      args.push("--", file);
    }

    const result = await execFileAsync("git", args, {
      cwd: dir,
      env: safeEnv(),
      maxBuffer: 1024 * 1024,
    }).catch((e: any) => ({ stdout: "", stderr: e.message }));

    return {
      diff: (result as any).stdout?.slice(0, 50000) || "",
      truncated: ((result as any).stdout?.length || 0) > 50000,
    };
  },
);

registerFunction(
  {
    id: "tool::git_commit",
    description: "Stage files and create a git commit",
    metadata: { category: "tool" },
  },
  async ({
    message,
    files,
    cwd,
  }: {
    message: string;
    files?: string[];
    cwd?: string;
  }) => {
    if (!message) throw new Error("commit message is required");
    const dir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(dir);

    if (files && files.length > 0) {
      for (const f of files) {
        assertPathContained(resolve(dir, f));
      }
      await execFileAsync("git", ["add", ...files], {
        cwd: dir,
        env: safeEnv(),
      });
    } else {
      await execFileAsync("git", ["add", "-A"], { cwd: dir, env: safeEnv() });
    }

    const result = await execFileAsync("git", ["commit", "-m", message], {
      cwd: dir,
      env: safeEnv(),
    });

    return { committed: true, output: result.stdout.trim() };
  },
);

registerFunction(
  {
    id: "tool::git_log",
    description: "Get git log with optional filters",
    metadata: { category: "tool" },
  },
  async ({
    count,
    author,
    since,
    file,
    cwd,
  }: {
    count?: number;
    author?: string;
    since?: string;
    file?: string;
    cwd?: string;
  }) => {
    const dir = cwd ? resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;
    assertPathContained(dir);

    const n = Math.min(count || 20, 100);
    const args = ["log", `--oneline`, `-${n}`, "--format=%H|%an|%ae|%ai|%s"];
    if (author) args.push(`--author=${author}`);
    if (since) args.push(`--since=${since}`);
    if (file) {
      assertPathContained(resolve(dir, file));
      args.push("--", file);
    }

    const result = await execFileAsync("git", args, {
      cwd: dir,
      env: safeEnv(),
    }).catch((e: any) => ({ stdout: "", stderr: e.message }));

    const commits = ((result as any).stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [hash, name, email, date, ...msgParts] = line.split("|");
        return { hash, author: name, email, date, message: msgParts.join("|") };
      });

    return { commits, count: commits.length };
  },
);

registerFunction(
  {
    id: "tool::sql_build",
    description: "Build parameterized SQL queries safely (no execution)",
    metadata: { category: "tool" },
  },
  async ({
    operation,
    table,
    columns,
    where,
    values,
    orderBy,
    limit,
    joins,
  }: {
    operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    table: string;
    columns?: string[];
    where?: Record<string, unknown>;
    values?: Record<string, unknown>;
    orderBy?: string;
    limit?: number;
    joins?: Array<{ type: string; table: string; on: string }>;
  }) => {
    if (!table || !operation)
      throw new Error("table and operation are required");
    const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
    if (!IDENT_RE.test(table)) throw new Error("Invalid table name");

    function assertIdentifier(name: string, label: string) {
      if (!IDENT_RE.test(name)) throw new Error(`Invalid ${label}: ${name}`);
    }

    const VALID_JOIN_TYPES = new Set([
      "INNER",
      "LEFT",
      "RIGHT",
      "CROSS",
      "FULL",
    ]);

    const params: unknown[] = [];
    let sql = "";

    if (operation === "SELECT") {
      if (columns?.length) {
        for (const col of columns) assertIdentifier(col, "column name");
      }
      const cols = columns?.length ? columns.join(", ") : "*";
      sql = `SELECT ${cols} FROM ${table}`;
      if (joins) {
        for (const j of joins) {
          const joinType = j.type.toUpperCase();
          if (!VALID_JOIN_TYPES.has(joinType))
            throw new Error(`Invalid join type: ${j.type}`);
          assertIdentifier(j.table, "join table name");
          if (
            !IDENT_RE.test(
              j.on
                .replace(/\s*=\s*/g, "=")
                .split("=")
                .map((s) => s.trim())
                .join(""),
            ) &&
            !/^[a-zA-Z0-9_.\s=]+$/.test(j.on)
          )
            throw new Error(`Invalid join condition: ${j.on}`);
          sql += ` ${joinType} JOIN ${j.table} ON ${j.on}`;
        }
      }
    } else if (operation === "INSERT") {
      if (!values || Object.keys(values).length === 0)
        throw new Error("values required for INSERT");
      const keys = Object.keys(values);
      for (const k of keys) assertIdentifier(k, "column name");
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders.join(", ")})`;
      params.push(...Object.values(values));
    } else if (operation === "UPDATE") {
      if (!values || Object.keys(values).length === 0)
        throw new Error("values required for UPDATE");
      const keys = Object.keys(values);
      for (const k of keys) assertIdentifier(k, "column name");
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      sql = `UPDATE ${table} SET ${sets.join(", ")}`;
      params.push(...Object.values(values));
    } else if (operation === "DELETE") {
      sql = `DELETE FROM ${table}`;
    }

    if (where && Object.keys(where).length > 0) {
      const offset = params.length;
      const whereKeys = Object.keys(where);
      for (const k of whereKeys) assertIdentifier(k, "where column");
      const conditions = whereKeys.map((k, i) => `${k} = $${offset + i + 1}`);
      sql += ` WHERE ${conditions.join(" AND ")}`;
      params.push(...Object.values(where));
    }

    if (orderBy) {
      const orderParts = orderBy.split(",").map((s) => s.trim());
      for (const part of orderParts) {
        const [col, dir] = part.split(/\s+/);
        assertIdentifier(col, "orderBy column");
        if (dir && !["ASC", "DESC"].includes(dir.toUpperCase()))
          throw new Error(`Invalid order direction: ${dir}`);
      }
      sql += ` ORDER BY ${orderBy}`;
    }
    if (limit) sql += ` LIMIT ${Math.min(limit, 10000)}`;

    return { sql, params, parameterized: true };
  },
);

registerFunction(
  {
    id: "tool::snapshot_create",
    description: "Create a snapshot of agent state for backup/restore",
    metadata: { category: "tool" },
  },
  async ({
    agentId,
    scopes,
    label,
  }: {
    agentId: string;
    scopes?: string[];
    label?: string;
  }) => {
    if (!agentId) throw new Error("agentId is required");
    const snapshotId = `snap_${randomUUID().slice(0, 8)}`;
    const targetScopes = scopes || ["agents", "sessions", "memories", "config"];
    const snapshot: Record<string, unknown> = {};

    for (const scope of targetScopes) {
      const data = (await trigger("state::list", { scope }).catch(
        () => [],
      )) as any[];
      const filtered = data.filter(
        (e: any) =>
          e.key === agentId ||
          e.key?.startsWith(`${agentId}:`) ||
          scope === "config",
      );
      snapshot[scope] = filtered.map((e: any) => ({
        key: e.key,
        value: e.value,
      }));
    }

    await trigger("state::set", {
      scope: "snapshots",
      key: snapshotId,
      value: {
        id: snapshotId,
        agentId,
        label: label || `Snapshot ${new Date().toISOString()}`,
        scopes: targetScopes,
        data: snapshot,
        createdAt: Date.now(),
        sizeEstimate: JSON.stringify(snapshot).length,
      },
    });

    return { snapshotId, agentId, scopes: targetScopes, label };
  },
);

registerFunction(
  {
    id: "tool::snapshot_restore",
    description: "Restore agent state from a snapshot",
    metadata: { category: "tool" },
  },
  async ({ snapshotId, dryRun }: { snapshotId: string; dryRun?: boolean }) => {
    if (!snapshotId) throw new Error("snapshotId is required");

    const snapshot: any = await trigger("state::get", {
      scope: "snapshots",
      key: snapshotId,
    });
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    const restoredKeys: string[] = [];
    for (const [scope, entries] of Object.entries(snapshot.data || {})) {
      for (const entry of entries as any[]) {
        restoredKeys.push(`${scope}:${entry.key}`);
        if (!dryRun) {
          await trigger("state::set", {
            scope,
            key: entry.key,
            value: entry.value,
          });
        }
      }
    }

    return {
      restored: !dryRun,
      dryRun: !!dryRun,
      snapshotId,
      agentId: snapshot.agentId,
      keysRestored: restoredKeys.length,
      keys: restoredKeys,
    };
  },
);

registerFunction(
  {
    id: "tool::snapshot_list",
    description: "List available snapshots",
    metadata: { category: "tool" },
  },
  async ({ agentId }: { agentId?: string }) => {
    const all = (await trigger("state::list", { scope: "snapshots" }).catch(
      () => [],
    )) as any[];
    let snapshots = all
      .map((e: any) => e.value)
      .filter(Boolean)
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));

    if (agentId) {
      snapshots = snapshots.filter((s: any) => s.agentId === agentId);
    }

    return {
      snapshots: snapshots.map((s: any) => ({
        id: s.id,
        agentId: s.agentId,
        label: s.label,
        scopes: s.scopes,
        createdAt: s.createdAt,
        sizeEstimate: s.sizeEstimate,
      })),
      count: snapshots.length,
    };
  },
);

registerFunction(
  {
    id: "tool::api_call",
    description: "Make HTTP API calls with retry and structured response",
    metadata: { category: "tool" },
  },
  async ({
    url,
    method,
    headers,
    body,
    timeout,
    retries,
  }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    retries?: number;
  }) => {
    if (!url) throw new Error("url is required");
    await assertNoSsrf(url);

    const httpMethod = (method || "GET").toUpperCase();
    const timeoutMs = Math.min(timeout || 30000, 60000);
    const maxRetries = Math.min(retries || 0, 3);

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const opts: RequestInit = {
            method: httpMethod,
            headers: {
              "User-Agent": "AgentOS/0.0.1",
              ...(headers || {}),
            },
            signal: controller.signal,
          };

          if (body && httpMethod !== "GET" && httpMethod !== "HEAD") {
            opts.body = typeof body === "string" ? body : JSON.stringify(body);
            if (!headers?.["Content-Type"]) {
              (opts.headers as Record<string, string>)["Content-Type"] =
                "application/json";
            }
          }

          const response = await fetch(url, opts);

          const contentType = response.headers.get("content-type") || "";
          let responseBody: unknown;
          if (contentType.includes("application/json")) {
            responseBody = await response.json();
          } else {
            const text = await response.text();
            responseBody = text.slice(0, 100000);
          }

          return {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
            attempt: attempt + 1,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (e: any) {
        lastError = e.message;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    return { error: lastError, attempts: maxRetries + 1 };
  },
);

registerFunction(
  {
    id: "tool::compose",
    description:
      "Chain multiple tool calls in sequence, piping outputs to inputs",
    metadata: { category: "tool" },
  },
  async ({
    steps,
    input,
  }: {
    steps: Array<{
      toolId: string;
      argsTemplate: Record<string, unknown>;
    }>;
    input?: Record<string, unknown>;
  }) => {
    if (!steps || steps.length === 0) throw new Error("steps are required");
    if (steps.length > 10) throw new Error("Maximum 10 steps allowed");

    let context: Record<string, unknown> = { ...(input || {}) };
    const results: Array<{
      step: number;
      toolId: string;
      output: unknown;
      durationMs: number;
    }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const resolvedArgs: Record<string, unknown> = {};

      for (const [key, val] of Object.entries(step.argsTemplate)) {
        if (typeof val === "string" && val.startsWith("$prev.")) {
          const path = val.slice(6);
          resolvedArgs[key] = (context as any)[path];
        } else if (typeof val === "string" && val.startsWith("$input.")) {
          const path = val.slice(7);
          resolvedArgs[key] = (input as any)?.[path];
        } else {
          resolvedArgs[key] = val;
        }
      }

      const start = Date.now();
      const output: any = await trigger(step.toolId, resolvedArgs).catch(
        (e: any) => ({ error: e.message }),
      );
      const durationMs = Date.now() - start;

      results.push({ step: i, toolId: step.toolId, output, durationMs });

      if (output?.error) {
        return { completed: false, failedAt: i, results, error: output.error };
      }

      context =
        typeof output === "object" && output !== null
          ? output
          : { result: output };
    }

    return {
      completed: true,
      stepsExecuted: steps.length,
      results,
      finalOutput: context,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "tool::vector_search",
  config: { api_path: "api/vector/search", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::git_status",
  config: { api_path: "api/git/status", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::git_diff",
  config: { api_path: "api/git/diff", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::git_log",
  config: { api_path: "api/git/log", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::sql_build",
  config: { api_path: "api/sql/build", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::snapshot_list",
  config: { api_path: "api/snapshots", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::snapshot_create",
  config: { api_path: "api/snapshots", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::api_call",
  config: { api_path: "api/tools/api-call", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::compose",
  config: { api_path: "api/tools/compose", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::todo_list",
  config: { api_path: "api/todos", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::todo_create",
  config: { api_path: "api/todos", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::cron_list",
  config: { api_path: "api/cron", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::agent_list",
  config: { api_path: "api/agents/list", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::system_info",
  config: { api_path: "api/system/info", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::memory_search",
  config: { api_path: "api/memory/search", http_method: "GET" },
});

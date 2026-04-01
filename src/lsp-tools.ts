import { httpOk } from "./shared/utils.js";
import { registerWorker, TriggerAction } from "iii-sdk";
import {
  ENGINE_URL,
  OTEL_CONFIG,
  registerShutdown,
  WORKSPACE_ROOT,
  assertPathContained,
} from "./shared/config.js";
import { readFile, writeFile } from "fs/promises";
import { resolve, extname, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { safeCall } from "./shared/errors.js";
import { createRecordMetric } from "./shared/metrics.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "lsp-tools",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const recordMetric = createRecordMetric(triggerVoid);
const execFileAsyncRaw = promisify(execFile);

async function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result: any = await execFileAsyncRaw(cmd, args, opts);
  if (typeof result === "string") return { stdout: result, stderr: "" };
  return { stdout: result?.stdout ?? "", stderr: result?.stderr ?? "" };
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const RUST_EXTENSIONS = new Set([".rs"]);

const GREP_INCLUDE_FLAGS = [
  "--include=*.ts", "--include=*.tsx", "--include=*.js",
  "--include=*.jsx", "--include=*.rs", "--include=*.py",
];

interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

interface Reference {
  file: string;
  line: number;
  content: string;
}

function detectLanguage(filePath: string): "typescript" | "rust" | "unknown" {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return "typescript";
  if (RUST_EXTENSIONS.has(ext)) return "rust";
  return "unknown";
}

function parseTsDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split("\n");
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4],
        message: match[5],
      });
    }
  }
  return diagnostics;
}

function parseRustDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.reason === "compiler-message" && msg.message) {
        const spans = msg.message.spans || [];
        const primary = spans.find((s: any) => s.is_primary) || spans[0];
        if (primary) {
          diagnostics.push({
            file: primary.file_name,
            line: primary.line_start,
            column: primary.column_start,
            severity: msg.message.level || "error",
            message: msg.message.message,
          });
        }
      }
    } catch {
      continue;
    }
  }
  return diagnostics;
}

const SYMBOL_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /^(export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: "function" },
  { pattern: /^(export\s+)?class\s+(\w+)/m, kind: "class" },
  { pattern: /^(export\s+)?(?:const|let|var)\s+(\w+)/m, kind: "variable" },
  { pattern: /^(export\s+)?type\s+(\w+)/m, kind: "type" },
  { pattern: /^(export\s+)?interface\s+(\w+)/m, kind: "interface" },
  { pattern: /^(export\s+)?enum\s+(\w+)/m, kind: "enum" },
  {
    pattern: /^export\s+default\s+(?:async\s+)?function\s+(\w+)?/m,
    kind: "function",
  },
  { pattern: /^export\s+default\s+class\s+(\w+)?/m, kind: "class" },
];

function extractSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, kind } of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const exported = line.trimStart().startsWith("export");
        const name =
          kind === "function" || kind === "class"
            ? match[2] || match[1]
            : match[2];
        if (name && name !== "export" && name !== "async") {
          symbols.push({ name, kind, line: i + 1, exported });
        }
        break;
      }
    }
  }
  return symbols;
}

const DEFINITION_PATTERNS = [
  { regex: /(?:async\s+)?function\s+{SYMBOL}\b/, kind: "function" },
  { regex: /class\s+{SYMBOL}\b/, kind: "class" },
  { regex: /(?:const|let|var)\s+{SYMBOL}\b/, kind: "variable" },
  { regex: /type\s+{SYMBOL}\b/, kind: "type" },
  { regex: /interface\s+{SYMBOL}\b/, kind: "interface" },
  { regex: /enum\s+{SYMBOL}\b/, kind: "enum" },
];


registerFunction(
  {
    id: "tool::lsp_diagnostics",
    description: "Get compiler/linter errors for a file",
    metadata: { category: "lsp" },
  },
  async (req: any) => {
    const { path } = req.body || req;
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    const lang = detectLanguage(resolved);
    let diagnostics: Diagnostic[] = [];

    if (lang === "typescript") {
      const result = await safeCall(
        async () =>
          execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
            cwd: WORKSPACE_ROOT,
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
          }),
        { stdout: "", stderr: "" },
        { operation: "tsc_check", functionId: "tool::lsp_diagnostics" },
      );

      const output = result.stdout + "\n" + result.stderr;
      diagnostics = parseTsDiagnostics(output);

      const relPath = relative(WORKSPACE_ROOT, resolved);
      diagnostics = diagnostics.filter(
        (d) => d.file === relPath || d.file === resolved,
      );
    } else if (lang === "rust") {
      const result = await safeCall(
        async () =>
          execFileAsync(
            "cargo",
            ["check", "--message-format=json"],
            {
              cwd: WORKSPACE_ROOT,
              timeout: 30_000,
              maxBuffer: 2 * 1024 * 1024,
            },
          ),
        { stdout: "", stderr: "" },
        { operation: "cargo_check", functionId: "tool::lsp_diagnostics" },
      );

      diagnostics = parseRustDiagnostics(result.stdout + "\n" + result.stderr);
      const relPath = relative(WORKSPACE_ROOT, resolved);
      diagnostics = diagnostics.filter(
        (d) => d.file === relPath || d.file === resolved,
      );
    } else {
      return httpOk(req, { path: resolved, language: lang, diagnostics: [], unsupported: true });
    }

    recordMetric("tool_execution_total", 1, {
      toolId: "tool::lsp_diagnostics",
      status: "success",
    });

    return httpOk(req, { path: resolved, language: lang, diagnostics });
  },
);

registerFunction(
  {
    id: "tool::lsp_symbols",
    description: "List all symbols in a file",
    metadata: { category: "lsp" },
  },
  async (req: any) => {
    const { path } = req.body || req;
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    const content = await readFile(resolved, "utf-8");
    const symbols = extractSymbols(content);

    recordMetric("tool_execution_total", 1, {
      toolId: "tool::lsp_symbols",
      status: "success",
    });

    return httpOk(req, { path: resolved, symbols });
  },
);

registerFunction(
  {
    id: "tool::lsp_references",
    description: "Find all references to a symbol",
    metadata: { category: "lsp" },
  },
  async (req: any) => {
    const { symbol, path } = req.body || req;
    if (!symbol || typeof symbol !== "string") {
      throw Object.assign(new Error("symbol is required"), {
        statusCode: 400,
      });
    }

    const searchPath = path
      ? resolve(WORKSPACE_ROOT, path)
      : WORKSPACE_ROOT;
    if (path) assertPathContained(searchPath);

    const result = await safeCall(
      async () =>
        execFileAsync(
          "grep",
          ["-rn", ...GREP_INCLUDE_FLAGS, "-w", symbol, searchPath],
          {
            cwd: WORKSPACE_ROOT,
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        ),
      { stdout: "", stderr: "" },
      { operation: "grep_references", functionId: "tool::lsp_references" },
    );

    const references: Reference[] = [];
    const lines = result.stdout.split("\n").filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(.+?):(\d+):(.+)$/);
      if (match) {
        references.push({
          file: relative(WORKSPACE_ROOT, match[1]),
          line: parseInt(match[2], 10),
          content: match[3].trim(),
        });
      }
    }

    recordMetric("tool_execution_total", 1, {
      toolId: "tool::lsp_references",
      status: "success",
    });

    return httpOk(req, { symbol, references: references.slice(0, 200) });
  },
);

registerFunction(
  {
    id: "tool::lsp_rename",
    description: "Rename a symbol across the project",
    metadata: { category: "lsp" },
  },
  async (req: any) => {
    const { oldName, newName, path } = req.body || req;
    if (!oldName || !newName) {
      throw Object.assign(
        new Error("oldName and newName are required"),
        { statusCode: 400 },
      );
    }

    const searchPath = path
      ? resolve(WORKSPACE_ROOT, path)
      : WORKSPACE_ROOT;
    if (path) assertPathContained(searchPath);

    const grepResult = await safeCall(
      async () =>
        execFileAsync(
          "grep",
          ["-rln", ...GREP_INCLUDE_FLAGS, "-w", oldName, searchPath],
          {
            cwd: WORKSPACE_ROOT,
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        ),
      { stdout: "", stderr: "" },
      { operation: "grep_files", functionId: "tool::lsp_rename" },
    );

    const files = grepResult.stdout.split("\n").filter(Boolean);
    const wordBoundary = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

    const renameResults = await Promise.all(
      files.map(async (filePath) => {
        assertPathContained(filePath);
        const content = await readFile(filePath, "utf-8");
        const matches = content.match(wordBoundary);
        if (!matches) return 0;
        const updated = content.replace(wordBoundary, newName);
        await safeCall(
          async () => writeFile(filePath, updated, "utf-8"),
          undefined,
          { operation: "write_renamed", functionId: "tool::lsp_rename" },
        );
        return matches.length;
      }),
    );
    const totalOccurrences = renameResults.reduce((a, b) => a + b, 0);

    recordMetric("tool_execution_total", 1, {
      toolId: "tool::lsp_rename",
      status: "success",
    });

    return httpOk(req, {
      oldName,
      newName,
      filesModified: files.length,
      occurrences: totalOccurrences,
    });
  },
);

registerFunction(
  {
    id: "tool::lsp_goto_definition",
    description: "Find where a symbol is defined",
    metadata: { category: "lsp" },
  },
  async (req: any) => {
    const { symbol } = req.body || req;
    if (!symbol || typeof symbol !== "string") {
      throw Object.assign(new Error("symbol is required"), {
        statusCode: 400,
      });
    }

    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const results = await Promise.all(
      DEFINITION_PATTERNS.map(async ({ regex, kind }) => {
        const pattern = regex.source.replace("{SYMBOL}", escapedSymbol);
        const result = await safeCall(
          async () =>
            execFileAsync(
              "grep",
              ["-rn", ...GREP_INCLUDE_FLAGS, "-E", pattern, WORKSPACE_ROOT],
              { cwd: WORKSPACE_ROOT, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
            ),
          { stdout: "", stderr: "" },
          { operation: "grep_definition", functionId: "tool::lsp_goto_definition" },
        );
        const firstLine = result.stdout.split("\n").find(Boolean);
        if (!firstLine) return null;
        const match = firstLine.match(/^(.+?):(\d+):(.+)$/);
        if (!match) return null;
        return { symbol, file: relative(WORKSPACE_ROOT, match[1]), line: parseInt(match[2], 10), kind };
      }),
    );

    const found = results.find(Boolean);
    if (found) {
      recordMetric("tool_execution_total", 1, { toolId: "tool::lsp_goto_definition", status: "success" });
      return httpOk(req, found);
    }

    return httpOk(req, { symbol, file: null, line: null, kind: null, notFound: true });
  },
);

registerTrigger({
  type: "http",
  function_id: "tool::lsp_diagnostics",
  config: { api_path: "api/lsp/diagnostics", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::lsp_symbols",
  config: { api_path: "api/lsp/symbols", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::lsp_references",
  config: { api_path: "api/lsp/references", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::lsp_rename",
  config: { api_path: "api/lsp/rename", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::lsp_goto_definition",
  config: { api_path: "api/lsp/goto-definition", http_method: "POST" },
});

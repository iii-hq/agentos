import { registerWorker, TriggerAction } from "iii-sdk";
import {
  ENGINE_URL,
  OTEL_CONFIG,
  registerShutdown,
  WORKSPACE_ROOT,
  assertPathContained,
} from "./shared/config.js";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { createRecordMetric } from "./shared/metrics.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "hashline",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const recordMetric = createRecordMetric(triggerVoid);

const HASH_CHARS = "ZPMQVRWSNKTXJBYH";

export function computeLineHash(lineNumber: number, content: string): string {
  const stripped = content.trimEnd();
  let hash = 0;
  const seed = /[\p{L}\p{N}]/u.test(stripped) ? 0 : lineNumber;
  for (let i = 0; i < stripped.length; i++) {
    hash = ((hash << 5) - hash + stripped.charCodeAt(i) + seed) | 0;
  }
  const idx = (hash >>> 0) % 256;
  return HASH_CHARS[idx >> 4] + HASH_CHARS[idx & 0xf];
}

function formatLine(
  lineNumber: number,
  content: string,
): { formatted: string; hash: string } {
  const hash = computeLineHash(lineNumber, content);
  return { formatted: `${lineNumber}#${hash}|${content}`, hash };
}

function parsePos(pos: string): { line: number; hash: string } {
  const match = pos.match(/^(\d+)#([A-Z]{2})$/);
  if (!match) {
    throw Object.assign(new Error(`Invalid position format: ${pos}`), {
      statusCode: 400,
    });
  }
  return { line: parseInt(match[1], 10), hash: match[2] };
}

function validateHash(
  lines: string[],
  lineNumber: number,
  expectedHash: string,
): void {
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw Object.assign(
      new Error(
        `Line ${lineNumber} out of range (file has ${lines.length} lines)`,
      ),
      { statusCode: 400 },
    );
  }
  const actualHash = computeLineHash(lineNumber, lines[lineNumber - 1]);
  if (actualHash !== expectedHash) {
    const context: string[] = [];
    const start = Math.max(1, lineNumber - 2);
    const end = Math.min(lines.length, lineNumber + 2);
    for (let i = start; i <= end; i++) {
      const h = computeLineHash(i, lines[i - 1]);
      context.push(`${i}#${h}|${lines[i - 1]}`);
    }
    throw Object.assign(
      new Error(
        `Hash mismatch at line ${lineNumber}: expected ${expectedHash}, got ${actualHash}. Current context:\n${context.join("\n")}`,
      ),
      { statusCode: 409 },
    );
  }
}

interface HashlineEdit {
  op: "replace" | "append" | "prepend";
  pos?: string;
  end?: string;
  lines: string | string[] | null;
}

function normalizeEditLines(
  input: string | string[] | null,
): string[] | null {
  if (input === null) return null;
  if (typeof input === "string") return input.split("\n");
  return input;
}

function applyEdits(
  fileLines: string[],
  edits: HashlineEdit[],
): string[] {
  const sorted = edits
    .map((edit, idx) => ({ edit, idx }))
    .sort((a, b) => {
      const lineA = a.edit.pos ? parsePos(a.edit.pos).line : 0;
      const lineB = b.edit.pos ? parsePos(b.edit.pos).line : 0;
      return lineB - lineA || b.idx - a.idx;
    });

  let result = [...fileLines];

  for (const { edit } of sorted) {
    const newLines = normalizeEditLines(edit.lines);

    if (edit.op === "replace") {
      if (!edit.pos) {
        throw Object.assign(
          new Error("replace requires pos"),
          { statusCode: 400 },
        );
      }
      const start = parsePos(edit.pos);
      validateHash(result, start.line, start.hash);

      if (edit.end) {
        const endPos = parsePos(edit.end);
        validateHash(result, endPos.line, endPos.hash);
        if (endPos.line < start.line) {
          throw Object.assign(
            new Error("end line must be >= start line"),
            { statusCode: 400 },
          );
        }
        const count = endPos.line - start.line + 1;
        if (newLines === null) {
          result.splice(start.line - 1, count);
        } else {
          result.splice(start.line - 1, count, ...newLines);
        }
      } else {
        if (newLines === null) {
          result.splice(start.line - 1, 1);
        } else {
          result.splice(start.line - 1, 1, ...newLines);
        }
      }
    } else if (edit.op === "append") {
      if (edit.pos) {
        const anchor = parsePos(edit.pos);
        validateHash(result, anchor.line, anchor.hash);
        const insertLines = newLines || [];
        result.splice(anchor.line, 0, ...insertLines);
      } else {
        const insertLines = newLines || [];
        result.push(...insertLines);
      }
    } else if (edit.op === "prepend") {
      if (edit.pos) {
        const anchor = parsePos(edit.pos);
        validateHash(result, anchor.line, anchor.hash);
        const insertLines = newLines || [];
        result.splice(anchor.line - 1, 0, ...insertLines);
      } else {
        const insertLines = newLines || [];
        result.unshift(...insertLines);
      }
    }
  }

  return result;
}

function formatRegion(
  lines: string[],
  startLine: number,
  endLine: number,
): string[] {
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  const output: string[] = [];
  for (let i = s; i <= e; i++) {
    const { formatted } = formatLine(i, lines[i - 1]);
    output.push(formatted);
  }
  return output;
}

function httpOk(req: any, data: any) {
  return req?.headers ? { status_code: 200, body: data } : data;
}

registerFunction(
  {
    id: "tool::hashline_read",
    description: "Read a file with hash-anchored line numbers",
    metadata: { category: "hashline" },
  },
  async (req: any) => {
    const { path, startLine, endLine } = req.body || req;
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");

    const start = startLine && startLine > 0 ? startLine : 1;
    const end =
      endLine && endLine <= lines.length ? endLine : lines.length;

    const output = formatRegion(lines, start, end);
    recordMetric("tool_execution_total", 1, {
      toolId: "tool::hashline_read",
      status: "success",
    });

    return httpOk(req, {
      path: resolved,
      totalLines: lines.length,
      startLine: start,
      endLine: end,
      lines: output,
    });
  },
);

registerFunction(
  {
    id: "tool::hashline_edit",
    description: "Apply hash-validated edits to a file",
    metadata: { category: "hashline" },
  },
  async (req: any) => {
    const { path, edits } = req.body || req;
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    if (!Array.isArray(edits) || edits.length === 0) {
      throw Object.assign(new Error("edits must be a non-empty array"), {
        statusCode: 400,
      });
    }

    const content = await readFile(resolved, "utf-8");
    const fileLines = content.split("\n");

    const result = applyEdits(fileLines, edits);

    await writeFile(resolved, result.join("\n"), "utf-8");

    let minLine = 1;
    let maxLine = result.length;
    for (const edit of edits) {
      if (edit.pos) {
        const parsed = parsePos(edit.pos);
        minLine = Math.max(1, Math.min(minLine, parsed.line - 2));
        maxLine = Math.min(result.length, Math.max(maxLine, parsed.line + 5));
      }
    }

    const affected = formatRegion(result, minLine, maxLine);
    recordMetric("tool_execution_total", 1, {
      toolId: "tool::hashline_edit",
      status: "success",
    });

    return httpOk(req, {
      path: resolved,
      totalLines: result.length,
      editsApplied: edits.length,
      affectedRegion: affected,
    });
  },
);

registerFunction(
  {
    id: "tool::hashline_diff",
    description: "Show diff between original and edited content (dry run)",
    metadata: { category: "hashline" },
  },
  async (req: any) => {
    const { path, edits } = req.body || req;
    const resolved = resolve(WORKSPACE_ROOT, path);
    assertPathContained(resolved);

    if (!Array.isArray(edits) || edits.length === 0) {
      throw Object.assign(new Error("edits must be a non-empty array"), {
        statusCode: 400,
      });
    }

    const content = await readFile(resolved, "utf-8");
    const originalLines = content.split("\n");
    const editedLines = applyEdits(originalLines, edits);

    const diff: string[] = [];
    let i = 0;
    let j = 0;

    while (i < originalLines.length || j < editedLines.length) {
      if (i < originalLines.length && j < editedLines.length) {
        if (originalLines[i] === editedLines[j]) {
          diff.push(` ${originalLines[i]}`);
          i++;
          j++;
        } else {
          diff.push(`-${originalLines[i]}`);
          i++;
          if (j < editedLines.length) {
            diff.push(`+${editedLines[j]}`);
            j++;
          }
        }
      } else if (i < originalLines.length) {
        diff.push(`-${originalLines[i]}`);
        i++;
      } else {
        diff.push(`+${editedLines[j]}`);
        j++;
      }
    }

    recordMetric("tool_execution_total", 1, {
      toolId: "tool::hashline_diff",
      status: "success",
    });

    return httpOk(req, {
      path: resolved,
      originalLines: originalLines.length,
      editedLines: editedLines.length,
      diff: diff.join("\n"),
    });
  },
);

registerTrigger({
  type: "http",
  function_id: "tool::hashline_read",
  config: { api_path: "api/hashline/read", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::hashline_edit",
  config: { api_path: "api/hashline/edit", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::hashline_diff",
  config: { api_path: "api/hashline/diff", http_method: "POST" },
});

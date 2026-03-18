import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import * as vm from "node:vm";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "code-agent",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction } = sdk;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 100_000;

const CODE_BLOCK_RE = /```(?:typescript|javascript|ts|js)\n([\s\S]*?)```/g;

interface ExecuteInput {
  code: string;
  agentId: string;
  timeout?: number;
}

interface DetectResult {
  hasCode: boolean;
  blocks: string[];
}

interface ExecuteResult {
  result: unknown;
  stdout: string;
  executionTimeMs: number;
}

registerFunction(
  {
    id: "agent::code_detect",
    description: "Detect executable code blocks in LLM response",
    metadata: { category: "code-agent" },
  },
  async ({ response }: { response: string }): Promise<DetectResult> => {
    if (!response) return { hasCode: false, blocks: [] };

    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(CODE_BLOCK_RE.source, CODE_BLOCK_RE.flags);

    while ((match = re.exec(response)) !== null) {
      const code = match[1].trim();
      if (code.length > 0) blocks.push(code);
    }

    return { hasCode: blocks.length > 0, blocks };
  },
);

registerFunction(
  {
    id: "agent::code_execute",
    description: "Execute agent-written TypeScript in a sandboxed context",
    metadata: { category: "code-agent" },
  },
  async (input: ExecuteInput): Promise<ExecuteResult> => {
    const { code, agentId, timeout: rawTimeout } = input;
    if (!code || !agentId) {
      return {
        result: { error: "code and agentId required" },
        stdout: "",
        executionTimeMs: 0,
      };
    }

    const timeoutMs = Math.max(
      1000,
      Math.min(Number(rawTimeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    const stdout: string[] = [];

    const sandboxConsole = {
      log: (...args: unknown[]) => {
        const line = args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ");
        if (stdout.join("\n").length + line.length < MAX_OUTPUT_LENGTH) {
          stdout.push(line);
        }
      },
    };

    const sandboxFetch = async (url: string, options?: RequestInit) => {
      const parsed = new URL(url);
      const blockedHosts = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "169.254.169.254",
        "metadata.google.internal",
      ];
      if (
        blockedHosts.includes(parsed.hostname) ||
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|fc00:|fd)/.test(
          parsed.hostname,
        )
      ) {
        throw new Error(
          `Blocked: cannot fetch private address ${parsed.hostname}`,
        );
      }
      const resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        status: resp.status,
        text: () => resp.text(),
        json: () => resp.json(),
      };
    };

    const context = vm.createContext(
      {
        console: sandboxConsole,
        fetch: sandboxFetch,
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Map,
        Set,
        Promise,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout: undefined,
        setInterval: undefined,
        process: undefined,
        require: undefined,
        import: undefined,
        eval: undefined,
        Function: undefined,
      },
      {
        codeGeneration: { strings: false, wasm: false },
      },
    );

    const start = performance.now();

    try {
      const script = new vm.Script(code, { filename: `agent-${agentId}.js` });
      const result = script.runInContext(context, {
        timeout: timeoutMs,
        breakOnSigint: true,
      });

      const resolved =
        result instanceof Promise
          ? await Promise.race([
              result,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("Async execution timeout")),
                  timeoutMs,
                ),
              ),
            ])
          : result;

      const executionTimeMs = Math.round(performance.now() - start);

      return {
        result: truncateResult(resolved),
        stdout: stdout.join("\n"),
        executionTimeMs,
      };
    } catch (err: any) {
      const executionTimeMs = Math.round(performance.now() - start);
      return {
        result: { error: err?.message || String(err) },
        stdout: stdout.join("\n"),
        executionTimeMs,
      };
    }
  },
);

function truncateResult(value: unknown): unknown {
  const str = JSON.stringify(value);
  if (!str || str.length <= MAX_OUTPUT_LENGTH) return value;
  return { truncated: true, preview: str.slice(0, MAX_OUTPUT_LENGTH) };
}

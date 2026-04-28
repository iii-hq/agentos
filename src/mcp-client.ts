import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { spawn, type ChildProcess } from "child_process";
import {
  validateMcpCommand,
  stripSecretsFromEnv,
  requireAuth,
} from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "mcp-client",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

interface McpConnection {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  process?: ChildProcess;
  tools: McpTool[];
  capabilities: Record<string, boolean>;
  connectedAt: number;
  buffer: string;
  nextRpcId: number;
  serveHandlerRef?: { id: string; unregister: () => void };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const connections = new Map<string, McpConnection>();
let serveRefs: {
  handlerRef: { id: string; unregister: () => void };
  triggerRef: { unregister: () => void };
} | null = null;
const pendingRequests = new Map<
  string,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function sendRpc(
  conn: McpConnection,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = conn.nextRpcId++;
  const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
  const requestKey = `${conn.id}:${id}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestKey);
      reject(new Error(`RPC timeout: ${method}`));
    }, 30_000);

    pendingRequests.set(requestKey, { resolve, reject, timer });

    if (conn.transport === "stdio" && conn.process?.stdin?.writable) {
      conn.process.stdin.write(JSON.stringify(message) + "\n");
    }
  });
}

function handleRpcResponse(conn: McpConnection, msg: JsonRpcMessage) {
  if (msg.id === undefined) return;
  const requestKey = `${conn.id}:${msg.id}`;
  const pending = pendingRequests.get(requestKey);
  if (!pending) return;

  pendingRequests.delete(requestKey);
  clearTimeout(pending.timer);

  if (msg.error) {
    pending.reject(
      new Error(`RPC error ${msg.error.code}: ${msg.error.message}`),
    );
  } else {
    pending.resolve(msg.result);
  }
}

function parseStdoutLine(conn: McpConnection, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg: JsonRpcMessage = JSON.parse(trimmed);
    if (msg.jsonrpc !== "2.0") return;
    handleRpcResponse(conn, msg);
  } catch {}
}

registerFunction(
  {
    id: "mcp::connect",
    description: "Connect to an MCP server via stdio or SSE",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    requireAuth(req);
    const { name, transport, command, args, url } = req.body || req;
    if (connections.has(name))
      throw new Error(`Connection '${name}' already exists`);

    const conn: McpConnection = {
      id: crypto.randomUUID(),
      name,
      transport,
      command,
      args,
      url,
      tools: [],
      capabilities: {},
      connectedAt: Date.now(),
      buffer: "",
      nextRpcId: 1,
    };

    if (transport === "stdio") {
      if (!command) throw new Error("stdio transport requires command");
      validateMcpCommand(command);

      const child = spawn(command, args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: stripSecretsFromEnv(),
      });

      child.stdout!.on("data", (chunk: Buffer) => {
        conn.buffer += chunk.toString();
        const lines = conn.buffer.split("\n");
        conn.buffer = lines.pop() || "";
        for (const line of lines) parseStdoutLine(conn, line);
      });

      child.on("exit", (code) => {
        connections.delete(name);
        triggerVoid("security::audit", {
          type: "mcp_disconnect",
          detail: { name, reason: "process_exit", code },
        });
      });

      conn.process = child;
    } else if (transport === "sse") {
      if (!url) throw new Error("SSE transport requires url");
    }

    connections.set(name, conn);

    const initResult = (await sendRpc(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "agentos", version: "0.0.1" },
    })) as any;

    conn.capabilities = initResult?.capabilities || {};

    const toolsResult = (await sendRpc(conn, "tools/list", {})) as any;
    conn.tools = (toolsResult?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || {},
    }));

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "mcp_connections",
        key: name,
        value: {
          id: conn.id,
          name,
          transport,
          command,
          url,
          toolCount: conn.tools.length,
          connectedAt: conn.connectedAt,
        },
      },
    });

    triggerVoid("security::audit", {
      type: "mcp_connect",
      detail: { name, transport, toolCount: conn.tools.length },
    });

    return {
      connected: true,
      name,
      tools: conn.tools.length,
      capabilities: conn.capabilities,
    };
  },
);

registerFunction(
  {
    id: "mcp::disconnect",
    description: "Disconnect from an MCP server",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    requireAuth(req);
    const { name } = req.body || req;
    const conn = connections.get(name);
    if (!conn) throw new Error(`No connection '${name}'`);

    if (conn.process) {
      conn.process.kill("SIGTERM");
    }

    connections.delete(name);
    await trigger({
      function_id: "state::delete",
      payload: { scope: "mcp_connections", key: name },
    }).catch(() => {});

    const connPrefix = conn.id + ":";
    for (const [key, pending] of pendingRequests) {
      if (key.startsWith(connPrefix)) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Connection closed"));
        pendingRequests.delete(key);
      }
    }

    return { disconnected: true, name };
  },
);

registerFunction(
  {
    id: "mcp::list_tools",
    description: "List tools from connected MCP servers",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const tools: Array<{
      server: string;
      name: string;
      namespaced: string;
      description: string;
    }> = [];

    for (const [name, conn] of connections) {
      for (const tool of conn.tools) {
        tools.push({
          server: name,
          name: tool.name,
          namespaced: `mcp_${name}_${tool.name}`,
          description: tool.description,
        });
      }
    }

    return { tools, count: tools.length };
  },
);

registerFunction(
  {
    id: "mcp::call_tool",
    description: "Call a tool on a connected MCP server",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { server, tool, arguments: toolArgs } = req.body || req;
    const conn = connections.get(server);
    if (!conn) throw new Error(`No connection '${server}'`);

    const available = conn.tools.find((t) => t.name === tool);
    if (!available)
      throw new Error(`Tool '${tool}' not found on server '${server}'`);

    const result = await sendRpc(conn, "tools/call", {
      name: tool,
      arguments: toolArgs,
    });

    triggerVoid("security::audit", {
      type: "mcp_tool_call",
      detail: { server, tool },
    });

    return result;
  },
);

registerFunction(
  {
    id: "mcp::list_connections",
    description: "List active MCP connections",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const list = Array.from(connections.values()).map((c) => ({
      id: c.id,
      name: c.name,
      transport: c.transport,
      toolCount: c.tools.length,
      connectedAt: c.connectedAt,
      uptime: Date.now() - c.connectedAt,
    }));

    return { connections: list, count: list.length };
  },
);

registerFunction(
  {
    id: "mcp::serve",
    description: "Register agentos as an MCP server exposing agent functions",
    metadata: { category: "mcp" },
  },
  async (req: any) => {
    requireAuth(req);
    const { tools: exposedTools } = req.body || req;
    const toolMap = new Map(exposedTools.map((t: any) => [t.name, t]));

    const handlerRef = registerFunction(
      {
        id: "mcp::serve_handler",
        description: "Handle incoming MCP JSON-RPC requests",
      },
      async (req) => {
        const body = req.body || req;
        const msg: JsonRpcMessage = body;

        if (msg.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "agentos", version: "0.0.1" },
            },
          };
        }

        if (msg.method === "tools/list") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: exposedTools.map((t: any) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          };
        }

        if (msg.method === "tools/call") {
          const params = msg.params as {
            name: string;
            arguments: Record<string, unknown>;
          };
          const tool: any = toolMap.get(params.name);
          if (!tool) {
            return {
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32601,
                message: `Tool not found: ${params.name}`,
              },
            };
          }

          try {
            const result = await trigger({
              function_id: tool.functionId,
              payload: params.arguments || {},
            });
            return {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            };
          } catch (err: any) {
            return {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: err.message }],
                isError: true,
              },
            };
          }
        }

        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        };
      },
    );

    const serveTrigger = registerTrigger({
      type: "http",
      function_id: "mcp::serve_handler",
      config: { api_path: "mcp/rpc", http_method: "POST" },
    });

    serveRefs = { handlerRef, triggerRef: serveTrigger };

    return { serving: true, tools: exposedTools.length };
  },
);

registerFunction(
  {
    id: "mcp::unserve",
    description: "Unregister the MCP serve handler and its HTTP trigger",
  },
  async (req: any) => {
    requireAuth(req);
    if (!serveRefs) {
      return { unserved: false, reason: "not serving" };
    }
    serveRefs.handlerRef.unregister();
    serveRefs.triggerRef.unregister();
    serveRefs = null;
    return { unserved: true };
  },
);

registerTrigger({
  type: "http",
  function_id: "mcp::connect",
  config: { api_path: "api/mcp/connect", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::disconnect",
  config: { api_path: "api/mcp/disconnect", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::list_tools",
  config: { api_path: "api/mcp/tools", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::call_tool",
  config: { api_path: "api/mcp/call", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::list_connections",
  config: { api_path: "api/mcp/connections", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::serve",
  config: { api_path: "api/mcp/serve", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "mcp::unserve",
  config: { api_path: "api/mcp/unserve", http_method: "POST" },
});

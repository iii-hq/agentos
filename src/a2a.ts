import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { assertNoSsrf, requireAuth } from "./shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "a2a" },
);

type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "cancelled"
  | "failed";

interface TextPart {
  type: "text";
  text: string;
}
interface FilePart {
  type: "file";
  file: { name: string; mimeType: string; bytes: string };
}
interface DataPart {
  type: "data";
  data: Record<string, unknown>;
}
type Part = TextPart | FilePart | DataPart;

interface A2aMessage {
  role: "user" | "agent";
  parts: Part[];
}

interface A2aTask {
  id: string;
  sessionId: string;
  status: { state: TaskState; message?: A2aMessage; timestamp: string };
  history: A2aMessage[];
  artifacts: Array<{ name: string; parts: Part[] }>;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];
  authentication: { schemes: string[] };
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

const MAX_TASKS = 1000;

async function getTaskOrder(): Promise<string[]> {
  return (
    (await trigger("state::get", { scope: "a2a_tasks", key: "_order" })) || []
  );
}

async function setTaskOrder(order: string[]): Promise<void> {
  await triggerVoid("state::set", {
    scope: "a2a_tasks",
    key: "_order",
    value: order,
  });
}

async function evictOldTasks(): Promise<void> {
  const order = await getTaskOrder();
  while (order.length >= MAX_TASKS) {
    const oldest = order.shift()!;
    await triggerVoid("state::set", {
      scope: "a2a_tasks",
      key: oldest,
      value: null,
    });
  }
  await setTaskOrder(order);
}

function createTaskId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

async function rpcCall(
  url: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any> {
  await assertNoSsrf(url);
  const rpcPayload = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
      signal: controller.signal,
    });
    const result = (await resp.json()) as any;
    if (result.error) {
      throw new Error(
        `A2A error ${result.error.code || ""}: ${result.error.message}`,
      );
    }
    return result.result;
  } finally {
    clearTimeout(timer);
  }
}

registerFunction(
  { id: "a2a::agent_card", description: "Build and serve the A2A AgentCard" },
  async ({
    baseUrl,
    name,
    description,
    skills,
  }: {
    baseUrl: string;
    name?: string;
    description?: string;
    skills?: AgentSkill[];
  }) => {
    const agentSkills =
      skills ||
      (await trigger("skill::list", {})
        .then((list: unknown) =>
          (list as any[]).slice(0, 20).map((s: any) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags || [],
            examples: [],
          })),
        )
        .catch(() => []));

    const card: AgentCard = {
      name: name || "agentsos",
      description:
        description ||
        "AI agent operating system with multi-agent orchestration",
      url: baseUrl,
      version: "0.1.0",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      skills: agentSkills as AgentSkill[],
      authentication: { schemes: ["bearer"] },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    };

    await trigger("state::set", {
      scope: "a2a",
      key: "agent_card",
      value: card,
    });

    return card;
  },
);

registerFunction(
  { id: "a2a::send_task", description: "Send task to an external A2A agent" },
  async ({
    agentUrl,
    message,
    sessionId,
    metadata,
  }: {
    agentUrl: string;
    message: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }) => {
    await assertNoSsrf(agentUrl);

    const taskId = createTaskId();
    const rpcPayload = {
      jsonrpc: "2.0",
      id: taskId,
      method: "tasks/send",
      params: {
        id: taskId,
        sessionId: sessionId || crypto.randomUUID(),
        message: { role: "user", parts: [{ type: "text", text: message }] },
        metadata: metadata || {},
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const resp = await fetch(agentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcPayload),
        signal: controller.signal,
      });

      const result = (await resp.json()) as any;

      if (result.error) {
        throw new Error(
          `A2A error ${result.error.code}: ${result.error.message}`,
        );
      }

      const task: A2aTask = {
        id: taskId,
        sessionId: result.result?.sessionId || rpcPayload.params.sessionId,
        status: result.result?.status || {
          state: "submitted",
          timestamp: nowIso(),
        },
        history: result.result?.history || [],
        artifacts: result.result?.artifacts || [],
        metadata: metadata || {},
        createdAt: Date.now(),
      };

      await evictOldTasks();
      await triggerVoid("state::set", {
        scope: "a2a_tasks",
        key: taskId,
        value: task,
      });
      const order = await getTaskOrder();
      order.push(taskId);
      await setTaskOrder(order);

      return task;
    } finally {
      clearTimeout(timer);
    }
  },
);

registerFunction(
  { id: "a2a::get_task", description: "Get task status" },
  async ({ taskId, agentUrl }: { taskId: string; agentUrl?: string }) => {
    if (agentUrl) {
      return rpcCall(agentUrl, "tasks/get", { id: taskId });
    }

    const task: A2aTask | null = await trigger("state::get", {
      scope: "a2a_tasks",
      key: taskId,
    });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  },
);

registerFunction(
  { id: "a2a::cancel_task", description: "Cancel a task" },
  async ({ taskId, agentUrl }: { taskId: string; agentUrl?: string }) => {
    if (agentUrl) {
      return rpcCall(agentUrl, "tasks/cancel", { id: taskId });
    }

    const task: A2aTask | null = await trigger("state::get", {
      scope: "a2a_tasks",
      key: taskId,
    });
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.status.state === "completed" || task.status.state === "failed") {
      throw new Error(`Cannot cancel task in state: ${task.status.state}`);
    }

    task.status = { state: "cancelled", timestamp: nowIso() };
    await triggerVoid("state::set", {
      scope: "a2a_tasks",
      key: taskId,
      value: task,
    });
    return task;
  },
);

registerFunction(
  {
    id: "a2a::handle_task",
    description: "Handle incoming A2A task request and route to local agent",
  },
  async (req) => {
    requireAuth(req);
    const body = req.body || req;
    const { jsonrpc, id: rpcId, method, params } = body;

    if (jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: rpcId,
        error: { code: -32600, message: "Invalid JSON-RPC" },
      };
    }

    if (method === "tasks/send") {
      const { id: taskId, sessionId, message, metadata } = params;
      const tid = taskId || createTaskId();

      const task: A2aTask = {
        id: tid,
        sessionId: sessionId || crypto.randomUUID(),
        status: { state: "working", timestamp: nowIso() },
        history: [message],
        artifacts: [],
        metadata: metadata || {},
        createdAt: Date.now(),
      };

      await evictOldTasks();
      await triggerVoid("state::set", {
        scope: "a2a_tasks",
        key: tid,
        value: task,
      });
      const order = await getTaskOrder();
      order.push(tid);
      await setTaskOrder(order);

      const userText = message.parts
        .filter((p: Part) => p.type === "text")
        .map((p: TextPart) => p.text)
        .join("\n");

      try {
        const response: any = await trigger("agent::chat", {
          agentId: "default",
          message: userText,
          sessionId: task.sessionId,
        });

        const agentMessage: A2aMessage = {
          role: "agent",
          parts: [{ type: "text", text: response.content }],
        };

        task.history.push(agentMessage);
        task.status = {
          state: "completed",
          message: agentMessage,
          timestamp: nowIso(),
        };

        await triggerVoid("state::set", {
          scope: "a2a_tasks",
          key: tid,
          value: task,
        });
        return { jsonrpc: "2.0", id: rpcId, result: task };
      } catch (err: any) {
        task.status = {
          state: "failed",
          message: {
            role: "agent",
            parts: [{ type: "text", text: err.message }],
          },
          timestamp: nowIso(),
        };
        await triggerVoid("state::set", {
          scope: "a2a_tasks",
          key: tid,
          value: task,
        });
        return { jsonrpc: "2.0", id: rpcId, result: task };
      }
    }

    if (method === "tasks/get") {
      const task: A2aTask | null = await trigger("state::get", {
        scope: "a2a_tasks",
        key: params.id,
      });
      if (!task) {
        return {
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32001, message: "Task not found" },
        };
      }
      return { jsonrpc: "2.0", id: rpcId, result: task };
    }

    if (method === "tasks/cancel") {
      const task: A2aTask | null = await trigger("state::get", {
        scope: "a2a_tasks",
        key: params.id,
      });
      if (!task) {
        return {
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32001, message: "Task not found" },
        };
      }
      task.status = { state: "cancelled", timestamp: nowIso() };
      await triggerVoid("state::set", {
        scope: "a2a_tasks",
        key: params.id,
        value: task,
      });
      return { jsonrpc: "2.0", id: rpcId, result: task };
    }

    return {
      jsonrpc: "2.0",
      id: rpcId,
      error: { code: -32601, message: "Method not found" },
    };
  },
);

registerFunction(
  {
    id: "a2a::discover",
    description: "Discover an external agent by fetching its AgentCard",
  },
  async ({ url }: { url: string }) => {
    await assertNoSsrf(url);
    const cardUrl = url.replace(/\/+$/, "") + "/.well-known/agent.json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const resp = await fetch(cardUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!resp.ok)
        throw new Error(`Failed to fetch AgentCard: ${resp.status}`);

      const card = (await resp.json()) as AgentCard;

      await trigger("state::set", {
        scope: "a2a",
        key: `discovered:${new URL(url).hostname}`,
        value: { card, discoveredAt: Date.now(), url },
      });

      return { discovered: true, card };
    } finally {
      clearTimeout(timer);
    }
  },
);

registerTrigger({
  type: "http",
  function_id: "a2a::agent_card",
  config: { api_path: ".well-known/agent.json", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::handle_task",
  config: { api_path: "a2a/rpc", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::send_task",
  config: { api_path: "api/a2a/send", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::get_task",
  config: { api_path: "api/a2a/task", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::cancel_task",
  config: { api_path: "api/a2a/cancel", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "a2a::discover",
  config: { api_path: "api/a2a/discover", http_method: "POST" },
});

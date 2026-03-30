import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";
import { stripCodeFences } from "./shared/utils.js";

const log = createLogger("task-decomposer");
const sdk = registerWorker(ENGINE_URL, { workerName: "task-decomposer", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const MAX_DEPTH = 3;
const MAX_SUBTASKS = 10;

type TaskStatus = "pending" | "in_progress" | "complete" | "failed" | "blocked";

interface Task {
  id: string;
  rootId: string;
  parentId: string | null;
  description: string;
  status: TaskStatus;
  depth: number;
  children: string[];
  createdAt: number;
  updatedAt: number;
}

registerFunction(
  {
    id: "task::decompose",
    description: "Recursively decompose a complex task into subtasks with hierarchical IDs",
    metadata: { category: "task" },
  },
  async (req: any) => {
    const { description, rootId: existingRootId, parentId, depth, model } =
      req.body || req;

    if (!description) {
      throw Object.assign(new Error("description is required"), { statusCode: 400 });
    }

    const currentDepth = depth || 0;
    if (currentDepth >= MAX_DEPTH) {
      return { decomposed: false, reason: "Max depth reached" };
    }

    const rootId = existingRootId || crypto.randomUUID();
    const taskId = parentId ? parentId : rootId;

    const llmResult: any = await trigger({
      function_id: "llm::chat",
      payload: {
        model: model || "default",
        messages: [
          {
            role: "system",
            content: `Decompose the following task into subtasks. Return JSON: { "subtasks": [{ "id": "<parentId>.<n>", "description": "..." }] }. Maximum ${MAX_SUBTASKS} subtasks. Parent ID is "${taskId}". Use hierarchical numbering (e.g., ${taskId}.1, ${taskId}.2).`,
          },
          { role: "user", content: description },
        ],
      },
    });

    let subtasks: { id: string; description: string }[] = [];
    try {
      const parsed = JSON.parse(stripCodeFences(llmResult?.content || "{}"));
      subtasks = (parsed.subtasks || []).slice(0, MAX_SUBTASKS);
    } catch {
      log.warn("Failed to parse LLM decomposition", { rootId, taskId });
      return { decomposed: false, reason: "LLM parse failure", rootId };
    }

    if (!parentId) {
      const rootTask: Task = {
        id: rootId,
        rootId,
        parentId: null,
        description,
        status: "pending",
        depth: 0,
        children: subtasks.map((s) => s.id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${rootId}`, key: rootId, value: rootTask },
      });
    }

    const created: Task[] = [];
    for (const sub of subtasks) {
      const task: Task = {
        id: sub.id,
        rootId,
        parentId: taskId,
        description: sub.description,
        status: "pending",
        depth: currentDepth + 1,
        children: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${rootId}`, key: sub.id, value: task },
      });

      await trigger({
        function_id: "state::set",
        payload: {
          scope: `task_edges:${rootId}`,
          key: `${taskId}->${sub.id}`,
          value: { parent: taskId, child: sub.id },
        },
      });

      created.push(task);
    }

    if (parentId) {
      const parentTask: any = await trigger({
        function_id: "state::get",
        payload: { scope: `tasks:${rootId}`, key: parentId },
      });
      if (parentTask) {
        parentTask.children = [
          ...new Set([...parentTask.children, ...subtasks.map((s) => s.id)]),
        ];
        parentTask.updatedAt = Date.now();
        await trigger({
          function_id: "state::set",
          payload: { scope: `tasks:${rootId}`, key: parentId, value: parentTask },
        });
      }
    }

    log.info("Task decomposed", { rootId, taskId, subtaskCount: created.length });
    recordMetric("task_decomposed", created.length, { rootId }, "counter");

    return { rootId, taskId, subtasks: created };
  },
);

registerFunction(
  {
    id: "task::get",
    description: "Get a task by rootId and taskId",
    metadata: { category: "task" },
  },
  async (req: any) => {
    const { rootId, taskId } = req.body || req;

    if (!rootId || !taskId) {
      throw Object.assign(new Error("rootId and taskId are required"), { statusCode: 400 });
    }

    const task = await trigger({
      function_id: "state::get",
      payload: { scope: `tasks:${rootId}`, key: taskId },
    });

    if (!task) {
      throw Object.assign(new Error("Task not found"), { statusCode: 404 });
    }

    return task;
  },
);

registerFunction(
  {
    id: "task::update_status",
    description: "Update task status and propagate to parent",
    metadata: { category: "task" },
  },
  async (req: any) => {
    const { rootId, taskId, status } = req.body || req;

    if (!rootId || !taskId || !status) {
      throw Object.assign(
        new Error("rootId, taskId, and status are required"),
        { statusCode: 400 },
      );
    }

    const validStatuses: TaskStatus[] = [
      "pending",
      "in_progress",
      "complete",
      "failed",
      "blocked",
    ];
    if (!validStatuses.includes(status)) {
      throw Object.assign(new Error(`Invalid status: ${status}`), { statusCode: 400 });
    }

    const task: any = await trigger({
      function_id: "state::get",
      payload: { scope: `tasks:${rootId}`, key: taskId },
    });

    if (!task) {
      throw Object.assign(new Error("Task not found"), { statusCode: 404 });
    }

    task.status = status;
    task.updatedAt = Date.now();
    await trigger({
      function_id: "state::set",
      payload: { scope: `tasks:${rootId}`, key: taskId, value: task },
    });

    let parentId = task.parentId;
    while (parentId) {
      const parent: any = await trigger({
        function_id: "state::get",
        payload: { scope: `tasks:${rootId}`, key: parentId },
      });

      if (!parent || parent.children.length === 0) break;

      const siblings: any[] = await Promise.all(
        parent.children.map((childId: string) =>
          trigger({
            function_id: "state::get",
            payload: { scope: `tasks:${rootId}`, key: childId },
          }),
        ),
      );

      const allComplete = siblings.every((s) => s?.status === "complete");
      const anyFailed = siblings.some((s) => s?.status === "failed");

      let newParentStatus: TaskStatus | null = null;
      if (allComplete) {
        newParentStatus = "complete";
      } else if (anyFailed) {
        newParentStatus = "blocked";
      }

      if (!newParentStatus || parent.status === newParentStatus) break;

      parent.status = newParentStatus;
      parent.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${rootId}`, key: parent.id, value: parent },
      });

      parentId = parent.parentId;
    }

    log.info("Task status updated", { rootId, taskId, status });
    recordMetric("task_status_updated", 1, { rootId, status }, "counter");

    return { taskId, status, updatedAt: task.updatedAt };
  },
);

registerFunction(
  {
    id: "task::list",
    description: "List tasks by rootId with optional status filter",
    metadata: { category: "task" },
  },
  async (req: any) => {
    const { rootId, status } = req.body || req;

    if (!rootId) {
      throw Object.assign(new Error("rootId is required"), { statusCode: 400 });
    }

    const entries: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `tasks:${rootId}` },
        }),
      [],
      { operation: "list_tasks" },
    );

    let tasks = entries.map((e) => e.value || e);
    if (status) {
      tasks = tasks.filter((t: any) => t.status === status);
    }

    return { rootId, count: tasks.length, tasks };
  },
);

registerFunction(
  {
    id: "task::spawn_workers",
    description: "Spawn agents for pending leaf tasks",
    metadata: { category: "task" },
  },
  async (req: any) => {
    const { rootId } = req.body || req;

    if (!rootId) {
      throw Object.assign(new Error("rootId is required"), { statusCode: 400 });
    }

    const entries: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `tasks:${rootId}` },
        }),
      [],
      { operation: "list_tasks_for_spawn" },
    );

    const tasks = entries.map((e) => e.value || e);
    const leafPending = tasks.filter(
      (t: any) => t.status === "pending" && t.children.length === 0,
    );

    let spawned = 0;
    for (const task of leafPending) {
      triggerVoid("tool::agent_spawn", {
        template: "task-worker",
        message: task.description,
        metadata: { rootId, taskId: task.id },
      });
      spawned++;
    }

    log.info("Spawned task workers", { rootId, count: spawned });
    recordMetric("task_workers_spawned", spawned, { rootId }, "counter");

    return { rootId, spawned };
  },
);

registerTrigger({
  type: "http",
  function_id: "task::decompose",
  config: { api_path: "api/tasks/decompose", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "task::get",
  config: { api_path: "api/tasks/get", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "task::update_status",
  config: { api_path: "api/tasks/status", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "task::list",
  config: { api_path: "api/tasks/list", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "task::spawn_workers",
  config: { api_path: "api/tasks/spawn", http_method: "POST" },
});

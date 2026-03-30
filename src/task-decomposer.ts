import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";
import { stripCodeFences } from "./shared/utils.js";

const log = createLogger("task-decomposer");

const sdk = registerWorker(ENGINE_URL, {
  workerName: "task-decomposer",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const MAX_DEPTH = 3;
const MAX_SUBTASKS = 10;

type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

interface Task {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  status: TaskStatus;
  depth: number;
  dependencies: string[];
  agentId?: string;
  createdAt: number;
  updatedAt: number;
}

registerFunction(
  {
    id: "task::decompose",
    description: "LLM breaks a complex task into independent subtasks",
    metadata: { category: "task" },
  },
  async ({
    description,
    parentId = null,
    depth = 0,
    rootId,
  }: {
    description: string;
    parentId?: string | null;
    depth?: number;
    rootId?: string;
  }) => {
    const actualRootId =
      rootId || `root_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (depth >= MAX_DEPTH) {
      const leafId = parentId
        ? `${parentId}.1`
        : "1";
      const task: Task = {
        id: leafId,
        parentId,
        name: description.slice(0, 100),
        description,
        status: "pending",
        depth,
        dependencies: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${actualRootId}`, key: leafId, value: task },
      });
      return { rootId: actualRootId, tasks: [task] };
    }

    let llmResult: any;
    try {
      llmResult = await trigger({
        function_id: "llm::complete",
        payload: {
          model: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 2048,
          },
          systemPrompt:
            "You decompose tasks into independent subtasks. Output only JSON.",
          messages: [
            {
              role: "user",
              content: `Break this task into independent, parallelizable subtasks.
If the task is already atomic (single developer can complete in one session), return it as a single subtask.

Task: ${description}

Return JSON array:
[{"name": "...", "description": "...", "dependencies": []}]

Each subtask should be independently completable. Dependencies reference other subtask names.
Maximum ${MAX_SUBTASKS} subtasks. Prefer fewer, larger subtasks.`,
            },
          ],
        },
      });
    } catch {
      const task: Task = {
        id: parentId ? `${parentId}.1` : "1",
        parentId,
        name: description.slice(0, 100),
        description,
        status: "pending",
        depth,
        dependencies: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${actualRootId}`, key: task.id, value: task },
      });
      return { rootId: actualRootId, tasks: [task] };
    }

    let subtasks: any[];
    try {
      subtasks = JSON.parse(stripCodeFences(llmResult?.content || "[]"));
      if (!Array.isArray(subtasks)) subtasks = [subtasks];
    } catch {
      subtasks = [{ name: description.slice(0, 100), description, dependencies: [] }];
    }

    subtasks = subtasks.slice(0, MAX_SUBTASKS);

    const tasks: Task[] = [];
    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i];
      const taskId = parentId ? `${parentId}.${i + 1}` : `${i + 1}`;
      const task: Task = {
        id: taskId,
        parentId,
        name: (st.name || "").slice(0, 100) || `Subtask ${i + 1}`,
        description: st.description || "",
        status: "pending",
        depth,
        dependencies: Array.isArray(st.dependencies) ? st.dependencies : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${actualRootId}`, key: taskId, value: task },
      });
      tasks.push(task);
    }

    if (parentId) {
      await trigger({
        function_id: "state::set",
        payload: {
          scope: `task_edges:${actualRootId}`,
          key: parentId,
          value: { children: tasks.map((t) => t.id) },
        },
      });
    }

    recordMetric("task_decompositions_total", 1, {
      depth: String(depth),
      count: String(tasks.length),
    });
    log.info("Task decomposed", {
      rootId: actualRootId,
      depth,
      subtasks: tasks.length,
    });

    return { rootId: actualRootId, tasks };
  },
);

registerFunction(
  {
    id: "task::get",
    description: "Get task by hierarchical ID",
    metadata: { category: "task" },
  },
  async ({ rootId, taskId }: { rootId: string; taskId: string }) => {
    return safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `tasks:${rootId}`, key: taskId },
        }),
      null,
      { operation: "get_task" },
    );
  },
);

registerFunction(
  {
    id: "task::update_status",
    description: "Update task status, propagate to parent",
    metadata: { category: "task" },
  },
  async ({
    rootId,
    taskId,
    status,
    agentId,
  }: {
    rootId: string;
    taskId: string;
    status: TaskStatus;
    agentId?: string;
  }) => {
    const task: any = await trigger({
      function_id: "state::get",
      payload: { scope: `tasks:${rootId}`, key: taskId },
    });
    if (!task) return { updated: false, reason: "Task not found" };

    task.status = status;
    task.updatedAt = Date.now();
    if (agentId) task.agentId = agentId;

    await trigger({
      function_id: "state::set",
      payload: { scope: `tasks:${rootId}`, key: taskId, value: task },
    });

    if (task.parentId) {
      const edges: any = await safeCall(
        () =>
          trigger({
            function_id: "state::get",
            payload: { scope: `task_edges:${rootId}`, key: task.parentId },
          }),
        null,
        { operation: "get_edges" },
      );

      if (edges?.children) {
        const siblings = await Promise.all(
          edges.children.map((childId: string) =>
            safeCall(
              () =>
                trigger({
                  function_id: "state::get",
                  payload: { scope: `tasks:${rootId}`, key: childId },
                }),
              null,
              { operation: "get_sibling" },
            ),
          ),
        );
        const siblingStatuses: TaskStatus[] = siblings
          .filter(Boolean)
          .map((c: any) => c.status);

        if (siblingStatuses.every((s) => s === "completed")) {
          await trigger({
            function_id: "task::update_status",
            payload: { rootId, taskId: task.parentId, status: "completed" },
          });
        } else if (status === "failed") {
          await trigger({
            function_id: "task::update_status",
            payload: { rootId, taskId: task.parentId, status: "blocked" },
          });
        }
      }
    }

    return { updated: true, taskId, status };
  },
);

registerFunction(
  {
    id: "task::list",
    description: "List tasks with optional status filter",
    metadata: { category: "task" },
  },
  async ({
    rootId,
    status,
    limit: rawLimit = 50,
  }: {
    rootId: string;
    status?: TaskStatus;
    limit?: number;
  }) => {
    const limit = Math.max(1, Math.min(Number(rawLimit) || 50, 200));
    const all: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `tasks:${rootId}` },
        }),
      [],
      { operation: "list_tasks" },
    );

    let tasks = all.map((e: any) => e.value).filter(Boolean);
    if (status) tasks = tasks.filter((t: any) => t.status === status);

    return tasks
      .sort((a: any, b: any) => a.id.localeCompare(b.id))
      .slice(0, limit);
  },
);

registerFunction(
  {
    id: "task::spawn_workers",
    description: "Spawn agents for each leaf task",
    metadata: { category: "task" },
  },
  async ({ rootId }: { rootId: string }) => {
    const all: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `tasks:${rootId}` },
        }),
      [],
      { operation: "list_tasks_for_spawn" },
    );

    const tasks = all.map((e: any) => e.value).filter(Boolean);

    const edges: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `task_edges:${rootId}` },
        }),
      [],
      { operation: "list_edges" },
    );
    const parentIds = new Set(
      edges.map((e: any) => e.key).filter(Boolean),
    );

    const leafTasks = tasks.filter(
      (t: any) => t.status === "pending" && !parentIds.has(t.id),
    );

    let spawned = 0;
    for (const task of leafTasks) {
      const siblingContext = tasks
        .filter((t: any) => t.parentId === task.parentId && t.id !== task.id)
        .map((t: any) => `- ${t.name}: ${t.status}`)
        .join("\n");

      const systemPrompt = `You are working on task: ${task.name}

Description: ${task.description}

${siblingContext ? `Sibling tasks (for context only — do NOT work on these):\n${siblingContext}` : ""}

Focus exclusively on your assigned task. Report completion when done.`;

      triggerVoid("tool::agent_spawn", {
        agentId: `task-worker-${rootId}-${task.id}`,
        template: "task-worker",
        systemPrompt,
        metadata: { rootId, taskId: task.id },
      });

      task.status = "in_progress";
      task.updatedAt = Date.now();
      await trigger({
        function_id: "state::set",
        payload: { scope: `tasks:${rootId}`, key: task.id, value: task },
      });
      spawned++;
    }

    recordMetric("task_workers_spawned", spawned, { rootId });
    log.info("Spawned task workers", { rootId, spawned, total: leafTasks.length });

    return { spawned, leafTasks: leafTasks.length };
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

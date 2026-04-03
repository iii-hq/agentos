import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";
import { safePagination } from "./shared/validate.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "workflow",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

type StepMode = "sequential" | "fanout" | "collect" | "conditional" | "loop";
type ErrorMode = "fail" | "skip" | "retry";

interface WorkflowStep {
  name: string;
  functionId: string;
  promptTemplate?: string;
  mode: StepMode;
  timeoutMs: number;
  errorMode: ErrorMode;
  maxRetries?: number;
  outputVar?: string;
  condition?: string;
  maxIterations?: number;
  until?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}

interface StepResult {
  stepName: string;
  output: unknown;
  durationMs: number;
  error?: string;
}

registerFunction(
  {
    id: "workflow::create",
    description: "Register a workflow definition",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    requireAuth(req);
    const workflow: Workflow = req.body || req;
    const id = workflow.id || crypto.randomUUID();
    await trigger({ function_id: "state::set", payload: {
      scope: "workflows",
      key: id,
      value: { ...workflow, id, createdAt: Date.now() },
    } });
    return { id };
  },
);

registerFunction(
  {
    id: "workflow::run",
    description: "Execute a workflow",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { workflowId, input, agentId } = req.body || req;
    const workflow: Workflow = await trigger({ function_id: "state::get", payload: {
      scope: "workflows",
      key: workflowId,
    } });

    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    if (agentId) {
      for (const step of workflow.steps) {
        const cap = step.functionId.split("::")[0];
        await trigger({ function_id: "security::check_capability", payload: {
          agentId,
          capability: cap,
          resource: step.functionId,
        } });
      }
    }

    const runId = crypto.randomUUID();
    const vars: Record<string, unknown> = { input };
    const results: StepResult[] = [];

    await trigger({ function_id: "state::set", payload: {
      scope: "workflow_runs",
      key: runId,
      value: { runId, workflowId, status: "running", startedAt: Date.now(), results: [] },
    } });

    let i = 0;
    while (i < workflow.steps.length) {
      await assertRunNotCancelled(runId);
      const step = workflow.steps[i];
      const startMs = Date.now();

      try {
        switch (step.mode) {
          case "sequential": {
            const prompt = interpolate(
              step.promptTemplate || "{{input}}",
              vars,
            );
            const output = await trigger({ function_id: step.functionId, payload: {
              ...vars,
              input: vars.input,
              prompt,
            } });
            if (step.outputVar) vars[step.outputVar] = output;
            vars.input = output;
            results.push({
              stepName: step.name,
              output,
              durationMs: Date.now() - startMs,
            });
            break;
          }

          case "fanout": {
            const fanoutSteps: WorkflowStep[] = [];
            let j = i;
            while (
              j < workflow.steps.length &&
              workflow.steps[j].mode === "fanout"
            ) {
              fanoutSteps.push(workflow.steps[j]);
              j++;
            }

            const fanoutResults = await Promise.all(
              fanoutSteps.map(async (fs) => {
                const prompt = interpolate(
                  fs.promptTemplate || "{{input}}",
                  vars,
                );
                return trigger({ function_id: fs.functionId, payload: { ...vars, prompt } });
              }),
            );

            vars.__fanout = fanoutResults;
            fanoutSteps.forEach((fs, idx) => {
              if (fs.outputVar) vars[fs.outputVar] = fanoutResults[idx];
              results.push({
                stepName: fs.name,
                output: fanoutResults[idx],
                durationMs: Date.now() - startMs,
              });
            });

            i = j - 1;
            break;
          }

          case "collect": {
            const prompt = interpolate(
              step.promptTemplate || "{{__fanout}}",
              vars,
            );
            const output = await trigger({ function_id: step.functionId, payload: {
              ...vars,
              fanoutResults: vars.__fanout,
              prompt,
            } });
            if (step.outputVar) vars[step.outputVar] = output;
            vars.input = output;
            results.push({
              stepName: step.name,
              output,
              durationMs: Date.now() - startMs,
            });
            break;
          }

          case "conditional": {
            const prevOutput = String(vars.input || "");
            if (
              step.condition &&
              !prevOutput.toLowerCase().includes(step.condition.toLowerCase())
            ) {
              results.push({
                stepName: step.name,
                output: "skipped",
                durationMs: Date.now() - startMs,
              });
              break;
            }
            const prompt = interpolate(
              step.promptTemplate || "{{input}}",
              vars,
            );
            const output = await trigger({ function_id: step.functionId, payload: { ...vars, prompt } });
            if (step.outputVar) vars[step.outputVar] = output;
            vars.input = output;
            results.push({
              stepName: step.name,
              output,
              durationMs: Date.now() - startMs,
            });
            break;
          }

          case "loop": {
            const max = step.maxIterations || 10;
            let loopOutput: unknown = null;
            for (let iter = 0; iter < max; iter++) {
              const prompt = interpolate(
                step.promptTemplate || "{{input}}",
                vars,
              );
              loopOutput = await trigger({ function_id: step.functionId, payload: {
                ...vars,
                prompt,
                iteration: iter,
              } });
              if (step.outputVar) vars[step.outputVar] = loopOutput;
              vars.input = loopOutput;

              if (
                step.until &&
                String(loopOutput)
                  .toLowerCase()
                  .includes(step.until.toLowerCase())
              ) {
                break;
              }
            }
            results.push({
              stepName: step.name,
              output: loopOutput,
              durationMs: Date.now() - startMs,
            });
            break;
          }
        }
      } catch (err: any) {
        if (step.errorMode === "skip") {
          results.push({
            stepName: step.name,
            output: null,
            durationMs: Date.now() - startMs,
            error: err.message,
          });
        } else if (step.errorMode === "retry") {
          const maxRetries = step.maxRetries || 3;
          let retried = false;
          for (let r = 0; r < maxRetries; r++) {
            try {
              await assertRunNotCancelled(runId);
              const prompt = interpolate(
                step.promptTemplate || "{{input}}",
                vars,
              );
              const output = await trigger({ function_id: step.functionId, payload: {
                ...vars,
                prompt,
              } });
              if (step.outputVar) vars[step.outputVar] = output;
              vars.input = output;
              results.push({
                stepName: step.name,
                output,
                durationMs: Date.now() - startMs,
              });
              retried = true;
              break;
            } catch {
              continue;
            }
          }
          if (!retried) {
            await markRunFailed(runId, err.message, results);
            throw err;
          }
        } else {
          await markRunFailed(runId, err.message, results);
          throw err;
        }
      }

      i++;
    }

    await assertRunNotCancelled(runId);
    await trigger({ function_id: "state::update", payload: {
      scope: "workflow_runs",
      key: runId,
      operations: [
        { type: "set", path: "status", value: "completed" },
        { type: "set", path: "completedAt", value: Date.now() },
        { type: "set", path: "results", value: results },
      ],
    } });

    return { runId, results, vars };
  },
);

registerFunction(
  {
    id: "workflow::get_run",
    description: "Get one workflow run by id",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { runId } = req.body || req;
    return trigger({ function_id: "state::get", payload: {
      scope: "workflow_runs",
      key: runId,
    } });
  },
);

registerFunction(
  {
    id: "workflow::cancel",
    description: "Request cancellation of a workflow run",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { runId } = req.body || req;
    const run = await trigger({ function_id: "state::get", payload: {
      scope: "workflow_runs",
      key: runId,
    } }) as any;

    if (!run) throw new Error(`Workflow run ${runId} not found`);

    await trigger({ function_id: "state::update", payload: {
      scope: "workflow_runs",
      key: runId,
      operations: [
        { type: "set", path: "status", value: "cancel_requested" },
        { type: "set", path: "cancelRequestedAt", value: Date.now() },
      ],
    } });

    return { cancelled: true, runId };
  },
);

registerFunction(
  {
    id: "workflow::list",
    description: "List all workflows",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    return trigger({ function_id: "state::list", payload: { scope: "workflows" } });
  },
);

registerFunction(
  {
    id: "workflow::runs",
    description: "List runs for a workflow",
    metadata: { category: "workflow" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const { workflowId } = input;
    const { limit, offset } = safePagination(input.limit, input.offset);

    const all: any[] = (await trigger({ function_id: "state::list", payload: {
      scope: "workflow_runs",
    } })) as any[];
    const filtered = all
      .filter((r: any) => r.value?.workflowId === workflowId)
      .slice(offset, offset + limit);

    return { runs: filtered, total: all.length, limit, offset };
  },
);

registerTrigger({
  type: "http",
  function_id: "workflow::run",
  config: { api_path: "api/workflows/run", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "workflow::create",
  config: { api_path: "api/workflows", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "workflow::list",
  config: { api_path: "api/workflows", http_method: "GET" },
});

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    if (val === undefined) return `{{${key}}}`;
    return typeof val === "string" ? val : JSON.stringify(val);
  });
}

async function markRunFailed(
  runId: string,
  error: string,
  results: StepResult[],
) {
  await trigger({ function_id: "state::update", payload: {
    scope: "workflow_runs",
    key: runId,
    operations: [
      { type: "set", path: "status", value: "failed" },
      { type: "set", path: "failedAt", value: Date.now() },
      { type: "set", path: "error", value: error },
      { type: "set", path: "results", value: results },
    ],
  } });
}

async function assertRunNotCancelled(runId: string) {
  const run = await trigger({ function_id: "state::get", payload: {
    scope: "workflow_runs",
    key: runId,
  } }) as any;

  if (run?.status !== "cancel_requested") return;

  await trigger({ function_id: "state::update", payload: {
    scope: "workflow_runs",
    key: runId,
    operations: [
      { type: "set", path: "status", value: "cancelled" },
      { type: "set", path: "cancelledAt", value: Date.now() },
      { type: "set", path: "results", value: run?.results ?? [] },
    ],
  } });

  throw new Error("Workflow run cancelled");
}

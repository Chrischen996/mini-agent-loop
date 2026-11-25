// Detached sub-agent worker context initialization for the CLI entrypoint.
//
// Split out of `cli.ts` `main`: when the CLI is re-invoked as a detached
// sub-agent or batch worker it resolves the env-provided task/job/owner IDs,
// re-attaches to the owner's task registry, and lets the worker's persisted
// options override the parsed argv. That block is self-contained (env +
// process only), so it runs before argument parsing with an explicit
// return value instead of inlining into `main`.

import { SubagentTaskRegistry, type SubagentTaskRecord } from "../subagent/task-registry.ts";
import { waitForDetachedWorkerStart } from "../subagent/worker-host.ts";
import type { ParsedCliArgs, CliSubagentWorkerOptions } from "../cli.ts";

const SUBAGENT_WORKER_TASK_ENV = "MINI_AGENT_SUBAGENT_WORKER_TASK_ID";
const SUBAGENT_WORKER_OWNER_ENV = "MINI_AGENT_SUBAGENT_WORKER_OWNER_SESSION_ID";
const SUBAGENT_BATCH_WORKER_JOB_ENV = "MINI_AGENT_SUBAGENT_BATCH_WORKER_JOB_ID";
const GOAL_WORKER_REGISTRY_ROOT_ENV = "MINI_AGENT_GOAL_WORKER_REGISTRY_ROOT";

/**
 * Resolve the detached-worker context (registry + task record + owner
 * session), if this invocation is one. `main` calls it before parsing argv
 * so the worker's registry is available for both the parse override and the
 * later tool wiring.
 */
export async function initCliWorkerContext(): Promise<{
  workerTaskId: string | undefined;
  batchWorkerJobId: string | undefined;
  workerOwnerSessionId: string | undefined;
  workerRecord: SubagentTaskRecord | undefined;
  taskRegistry: SubagentTaskRegistry | undefined;
}> {
  const workerTaskId = process.env[SUBAGENT_WORKER_TASK_ENV]?.trim();
  const batchWorkerJobId = process.env[SUBAGENT_BATCH_WORKER_JOB_ENV]?.trim();
  const workerOwnerSessionId = process.env[SUBAGENT_WORKER_OWNER_ENV]?.trim();
  let workerRecord: SubagentTaskRecord | undefined;
  let taskRegistry: SubagentTaskRegistry | undefined;
  if (workerTaskId && batchWorkerJobId) throw new Error("CLI cannot run a task worker and batch worker at the same time.");
  if (workerTaskId || batchWorkerJobId) {
    await waitForDetachedWorkerStart();
    if (!workerOwnerSessionId) throw new Error("Detached sub-agent worker has no owning session ID.");
    // Goal workers run with cwd inside an isolated worktree, but their task
    // record lives in the owner's live checkout — point the registry there.
    taskRegistry = new SubagentTaskRegistry(process.env[GOAL_WORKER_REGISTRY_ROOT_ENV]?.trim() || process.cwd());
    await taskRegistry.initialize();
    if (workerTaskId) {
      workerRecord = await taskRegistry.get(workerTaskId, workerOwnerSessionId);
      if (!workerRecord || (workerRecord.status !== "queued" && workerRecord.status !== "running")) {
        throw new Error("Detached sub-agent task is missing or no longer active.");
      }
    }
  }
  return { workerTaskId, batchWorkerJobId, workerOwnerSessionId, workerRecord, taskRegistry };
}

/**
 * Apply a detached worker's persisted options onto the parsed args (the
 * worker is the authority for its own tool/mode selection). Returns the
 * parsed args unchanged when this is not a worker invocation.
 */
export function applyCliWorkerOptions(
  workerOptions: CliSubagentWorkerOptions | undefined,
  parsed: ParsedCliArgs,
  isWorker: boolean,
): ParsedCliArgs {
  if (!isWorker || !workerOptions) return parsed;
  return {
    ...parsed,
    tools: workerOptions.tools,
    excludeTools: workerOptions.excludeTools,
    allowMcpTools: workerOptions.allowMcpTools,
    mcpAllowlist: workerOptions.mcpAllowlist,
    mode: workerOptions.mode,
    modeExplicit: true,
    sandboxEnabled: workerOptions.sandboxConfig !== null,
  };
}

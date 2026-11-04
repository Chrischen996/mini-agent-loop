import { fork } from "node:child_process";
import type { SubagentTaskRegistry } from "./task-registry.ts";

export type DetachedSubagentWorkerOptions = {
  entryPoint: string;
  cwd: string;
  execArgv: string[];
  env: NodeJS.ProcessEnv;
  taskId: string;
  registry: SubagentTaskRegistry;
};

export type DetachedSubagentBatchWorkerOptions = Omit<DetachedSubagentWorkerOptions, "taskId" | "registry"> & {
  jobId: string;
  setWorkerPid: (pid?: number) => Promise<void>;
};

/** Start a detached CLI worker after its PID is durably attached to the task. */
export async function launchDetachedSubagentWorker(options: DetachedSubagentWorkerOptions): Promise<void> {
  const child = fork(options.entryPoint, [], {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.unref();

  if (!child.pid) {
    child.kill();
    throw new Error("Detached worker did not receive a process ID.");
  }

  try {
    await options.registry.setWorkerPid(options.taskId, child.pid);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Detached worker did not accept its startup signal.")), 15_000);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", onError);
      child.send("start", (error) => {
        clearTimeout(timer);
        child.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  if (child.connected) child.disconnect();
}

export async function launchDetachedSubagentBatchWorker(options: DetachedSubagentBatchWorkerOptions): Promise<void> {
  const child = fork(options.entryPoint, [], {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.unref();
  if (!child.pid) {
    child.kill();
    throw new Error("Detached batch worker did not receive a process ID.");
  }

  try {
    await options.setWorkerPid(child.pid);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Detached batch worker did not accept its startup signal.")), 15_000);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", onError);
      child.send("start", (error) => {
        clearTimeout(timer);
        child.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    child.kill();
    await options.setWorkerPid(undefined).catch(() => undefined);
    throw error;
  }
  if (child.connected) child.disconnect();
}

/** Gate worker startup until the parent has persisted its PID in the task record. */
export async function waitForDetachedWorkerStart(): Promise<void> {
  if (typeof process.send !== "function") throw new Error("Detached worker must be started by the CLI worker host.");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (message === "start") finish();
      else finish(new Error("Invalid detached worker startup message."));
    };
    const onDisconnect = () => finish(new Error("Detached worker host disconnected before startup."));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for detached worker startup.")), 30_000);
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
  process.disconnect?.();
}

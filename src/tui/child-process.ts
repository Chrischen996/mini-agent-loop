import { spawn, type SpawnOptions } from "node:child_process";

export type ChildProcessRunOptions = SpawnOptions & {
  input?: string;
  timeoutMs?: number;
  timeoutMessage?: string;
  failureMessage?: (code: number | null) => string;
};

/** Run a short-lived platform command with one consistent lifecycle policy. */
export function runChildProcess(
  command: string,
  args: string[],
  options: ChildProcessRunOptions = {},
): Promise<void> {
  const {
    input,
    timeoutMs = 5_000,
    timeoutMessage = `${command} timed out`,
    failureMessage = (code) => `${command} exited with code ${code ?? "unknown"}`,
    ...spawnOptions
  } = options;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...spawnOptions,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(timeoutMessage));
    }, timeoutMs);

    child.stderr?.resume();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(failureMessage(code)));
    });
    if (input !== undefined) {
      child.stdin?.once("error", () => {
        /* The child may exit before stdin finishes flushing. */
      });
      child.stdin?.end(input);
    }
  });
}

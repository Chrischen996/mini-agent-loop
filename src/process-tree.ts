import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Terminate a child and its descendants when the child owns a process group. */
export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    taskkill.once("error", () => {
      try {
        child.kill(signal);
      } catch {
        // Cleanup is best-effort after a process has already exited.
      }
    });
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between checking its pid and signalling it.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cleanup is best-effort after a process has already exited.
  }
}

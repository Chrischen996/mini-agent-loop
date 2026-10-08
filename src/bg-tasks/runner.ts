import { existsSync, readFileSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dir = process.argv[2];
if (!dir) throw new Error("Task directory required");

const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const resultPath = join(dir, "result.json");
const gatePath = join(dir, "start.signal");
const cancelPath = join(dir, "cancel.json");

async function waitGate(path: string, ms: number) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Gate timeout");
    await new Promise(r => setTimeout(r, 20));
  }
}

function finalize(exitCode: number | null, signal: string | null, reason?: string) {
  if (existsSync(resultPath)) return;
  const cancel = existsSync(cancelPath) ? JSON.parse(readFileSync(cancelPath, "utf8")) : undefined;
  const status = cancel ? (cancel.reason === "timed_out" ? "timed_out" : "cancelled") : (exitCode === 0 ? "completed" : "failed");
  const res = { schemaVersion: 1, taskId: meta.taskId, status, exitCode, signal, startedAt: meta.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString(), reason: reason ?? cancel?.reason };
  const temp = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(res) + "\n", { mode: 0o600, flag: "wx" });
  try { linkSync(temp, resultPath); } catch (e) { if ((e as any).code !== "EEXIST") throw e; } finally { unlinkSync(temp); }
}

process.on("SIGTERM", () => { finalize(null, "SIGTERM", "runner terminated"); process.exit(128); });
process.on("SIGINT", () => { /* allow Ctrl+C to reach child */ });

(async () => {
  await waitGate(gatePath, 10000);
  const startedAt = new Date().toISOString();
  meta.startedAt = startedAt;

  const child = spawn(meta.shell || "/bin/sh", ["-lc", meta.command], { cwd: meta.cwd, env: process.env, stdio: "inherit" });

  child.once("error", (e) => { finalize(null, null, e.message); process.exitCode = 1; });
  child.once("close", (code, sig) => { finalize(code, sig); process.exitCode = code ?? (sig ? 128 : 1); });
})();

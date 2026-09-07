import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { terminateProcessTree } from "../src/process-tree.ts";

describe("terminateProcessTree", () => {
  it("stops a detached shell and its descendants", async () => {
    if (process.platform === "win32") return;

    const child = spawn("bash", ["-lc", "sleep 30"], {
      stdio: "ignore",
      detached: true,
    });
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
      if (child.pid !== undefined) resolve();
    });

    terminateProcessTree(child);
    const forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_000);
    try {
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      assert.ok(Date.now() - startedAt < 2_000);
    } finally {
      clearTimeout(forceKill);
    }
  });
});

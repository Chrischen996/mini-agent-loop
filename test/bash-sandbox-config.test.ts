import assert from "node:assert/strict";
import test from "node:test";
import { createBashTool } from "../src/tools/bash.ts";
import type { SandboxRunner } from "../src/sandbox/types.ts";

test("bash sandbox defaults config when runner has no config", async () => {
  let received: { timeout?: number; allowNetwork?: boolean } | undefined;
  const runner: SandboxRunner = {
    type: "node",
    isolation: "process-isolation",
    async execute(options) {
      received = options;
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    },
    async cleanup() {},
  };

  const tool = createBashTool(process.cwd(), { runner });
  const result = await tool.execute({ command: "printf ok" });

  assert.equal(result.content, "ok");
  assert.equal(result.isError, false);
  assert.deepEqual(received && {
    timeout: received.timeout,
    allowNetwork: received.allowNetwork,
  }, {
    timeout: 30000,
    allowNetwork: false,
  });
});

test("bash rejects invalid timeouts before sandbox execution", async () => {
  let executed = false;
  const runner: SandboxRunner = {
    type: "node",
    isolation: "process-isolation",
    async execute() {
      executed = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
    async cleanup() {},
  };

  const tool = createBashTool(process.cwd(), { runner });
  const result = await tool.execute({ command: "printf never", timeout: 0 });

  assert.equal(result.content, "Invalid timeout: must be greater than 0 seconds");
  assert.equal(result.isError, true);
  assert.equal(executed, false);
});

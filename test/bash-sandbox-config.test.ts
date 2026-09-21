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

test("direct bash timeout terminates descendant processes and returns", async () => {
  const tool = createBashTool(process.cwd());
  const startedAt = Date.now();
  const result = await tool.execute({
    command: "sleep 30",
    timeout: 0.05,
  });

  assert.equal(result.isError, true);
  assert.match(String(result.content), /timed out after 0\.05 seconds/);
  assert.ok(Date.now() - startedAt < 2_000, "timeout should not wait for descendants");
});

test("direct bash applies the configured default timeout", async () => {
  const noSandboxRunner: SandboxRunner = {
    type: "none",
    isolation: "none",
    async execute() {
      throw new Error("sandbox should not execute");
    },
    async cleanup() {},
  };
  const tool = createBashTool(process.cwd(), {
    runner: noSandboxRunner,
    config: { timeout: 50 },
  });
  const result = await tool.execute({ command: "sleep 30" });

  assert.equal(result.isError, true);
  assert.match(String(result.content), /timed out after 0\.05 seconds/);
});

test("bash forwards abort signals through a configured sandbox runner", async () => {
  let receivedSignal: AbortSignal | undefined;
  const runner: SandboxRunner = {
    type: "node",
    isolation: "process-isolation",
    async execute(options) {
      receivedSignal = options.signal;
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    },
    async cleanup() {},
  };
  const controller = new AbortController();
  const tool = createBashTool(process.cwd(), { runner });

  await tool.execute({ command: "printf ok" }, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("bash reports sandbox timeouts before inspecting the exit code", async () => {
  const runner: SandboxRunner = {
    type: "node",
    isolation: "process-isolation",
    async execute() {
      return { stdout: "partial", stderr: "", exitCode: 0, timedOut: true };
    },
    async cleanup() {},
  };
  const result = await createBashTool(process.cwd(), { runner }).execute({ command: "sleep 1" });

  assert.equal(result.isError, true);
  assert.match(String(result.content), /command timed out after 30 seconds/);
});

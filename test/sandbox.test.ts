import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import {
  createSandboxRunner,
  detectDocker,
  detectBestSandboxType,
  NodeSandboxRunner,
  type SandboxConfig,
} from "../src/sandbox/index.ts";

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-sandbox-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("sandbox detection", () => {
  it("detects available sandbox types", async () => {
    const hasDocker = await detectDocker();
    assert.equal(typeof hasDocker, "boolean");

    const config: SandboxConfig = { enabled: true, type: "auto" };
    const sandboxType = await detectBestSandboxType(config);
    assert.ok(["docker", "node", "none"].includes(sandboxType));
  });

  it("respects disabled sandbox config", async () => {
    const sandboxType = await detectBestSandboxType({ enabled: false });
    assert.equal(sandboxType, "none");
  });

  it("forces node sandbox when requested", async () => {
    const sandboxType = await detectBestSandboxType({ enabled: true, type: "node" });
    assert.equal(sandboxType, "node");
  });

  it("fails closed when secure sandbox is required but only Node is selected", async () => {
    await assert.rejects(
      () => detectBestSandboxType({ enabled: true, mode: "required", type: "node" }),
      /Secure sandbox required/,
    );
  });
});

describe("NodeSandboxRunner", () => {
  it("executes simple commands", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      assert.equal(runner.isolation, "process-isolation");
      const result = await runner.execute({
        command: "echo",
        args: ["hello world"],
        cwd,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /hello world/);
      assert.equal(result.timedOut, false);
    });
  });

  it("captures stderr", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "node",
        args: ["-e", "console.error('test error')"],
        cwd,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /test error/);
    });
  });

  it("enforces timeout", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "sleep",
        args: ["5"],
        cwd,
        timeout: 500,
      });
      assert.equal(result.timedOut, true);
      assert.notEqual(result.exitCode, 0);
    });
  });

  it("handles non-zero exit codes", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "node",
        args: ["-e", "process.exit(42)"],
        cwd,
      });
      assert.equal(result.exitCode, 42);
    });
  });

  it("sets network blocking proxy vars", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "node",
        args: ["-e", "console.log(process.env.https_proxy)"],
        cwd,
        allowNetwork: false,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /http:\/\/127\.0\.0\.1:0/);
    });
  });

  it("allows network when requested", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "node",
        args: ["-e", "console.log(process.env.https_proxy || 'none')"],
        cwd,
        allowNetwork: true,
      });
      assert.equal(result.exitCode, 0);
    });
  });

  it("passes custom environment variables", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "node",
        args: ["-e", "console.log(process.env.TEST_VAR)"],
        cwd,
        env: { TEST_VAR: "custom_value" },
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /custom_value/);
    });
  });

  it("does not inherit arbitrary host environment variables", async () => {
    await withTempDir(async (cwd) => {
      const key = "MINI_AGENT_SANDBOX_TEST_SECRET";
      const previous = process.env[key];
      process.env[key] = "must-not-leak";
      try {
        const runner = new NodeSandboxRunner();
        const result = await runner.execute({
          command: "node",
          args: ["-e", `console.log(process.env.${key} ? 'present' : 'absent')`],
          cwd,
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /absent/);
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    });
  });

  it("supports stdin input", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "cat",
        args: [],
        cwd,
        stdin: "test input\n",
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /test input/);
    });
  });
});

describe("createSandboxRunner", () => {
  it("creates appropriate runner based on config", async () => {
    const runner = await createSandboxRunner({ enabled: true, type: "node" });
    assert.equal(runner.type, "node");
    await runner.cleanup();
  });

  it("creates disabled runner when sandbox is off", async () => {
    const runner = await createSandboxRunner({ enabled: false });
    assert.equal(runner.type, "none");
    await runner.cleanup();
  });
});

describe("sandbox integration", () => {
  it("node runner executes but workspace tools handle path validation", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(path.join(cwd, "test.txt"), "safe content", "utf8");

      const runner = new NodeSandboxRunner();
      const result = await runner.execute({
        command: "cat",
        args: ["test.txt"],
        cwd,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /safe content/);
    });
  });

  it("isolates processes", async () => {
    await withTempDir(async (cwd) => {
      const runner = new NodeSandboxRunner();
      const result1 = await runner.execute({
        command: "node",
        args: ["-e", "console.log(process.pid)"],
        cwd,
      });
      const result2 = await runner.execute({
        command: "node",
        args: ["-e", "console.log(process.pid)"],
        cwd,
      });
      assert.equal(result1.exitCode, 0);
      assert.equal(result2.exitCode, 0);
      assert.notEqual(result1.stdout.trim(), result2.stdout.trim());
    });
  });
});

describe("bash tool sandbox integration", () => {
  it("falls back to direct spawn when no sandbox is configured", async () => {
    const { createBashTool } = await import("../src/tools/bash.ts");
    const tmpDir = await mkdtemp(path.join(tmpdir(), "mini-agent-bash-"));
    try {
      const tool = createBashTool(tmpDir);
      const result = await tool.execute({ command: "echo hello" });
      assert.ok(!result.isError);
      assert.match(contentAsString(result.content), /hello/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes through node sandbox runner when configured", async () => {
    const { createBashTool } = await import("../src/tools/bash.ts");
    const { NodeSandboxRunner } = await import("../src/sandbox/index.ts");
    const tmpDir = await mkdtemp(path.join(tmpdir(), "mini-agent-sandbox-"));
    try {
      const runner = new NodeSandboxRunner();
      const tool = createBashTool(tmpDir, { runner, config: { enabled: true, type: "node" } });
      const result = await tool.execute({ command: "echo sandboxed" });
      assert.ok(!result.isError);
      assert.match(contentAsString(result.content), /sandboxed/);
      // Verify network isolation
      const netResult = await tool.execute({ command: "curl -s --max-time 2 https://example.com || echo unreachable", timeout: 5 });
      assert.ok(contentAsString(netResult.content).includes("unreachable") || netResult.isError);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error when sandbox execution fails", async () => {
    const { createBashTool } = await import("../src/tools/bash.ts");
    const tmpDir = await mkdtemp(path.join(tmpdir(), "mini-agent-bash-"));
    try {
      const tool = createBashTool(tmpDir);
      const result = await tool.execute({ command: "nonexistent_command_xyz" });
      assert.ok(result.isError);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

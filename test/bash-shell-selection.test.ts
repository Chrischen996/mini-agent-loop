import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { NodeSandboxRunner, DockerSandboxRunner } from "../src/sandbox/index.ts";
import { describeShell, resolveShell } from "../src/tools/shell.ts";

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-bash-shell-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("bash tool shell selection", () => {
  it("advertises bash syntax on Unix", { skip: process.platform === "win32" }, async () => {
    await withTempDir(async (tmpDir) => {
      const tool = createBashTool(tmpDir);
      assert.equal(resolveShell().kind, "bash");
      assert.match(tool.description, /bash/);
      assert.doesNotMatch(tool.description, /PowerShell/);
    });
  });

  it("advertises PowerShell syntax for the node sandbox runner", async () => {
    await withTempDir(async (tmpDir) => {
      const runner = new NodeSandboxRunner();
      const tool = createBashTool(tmpDir, { runner, config: { enabled: true, type: "node" } });
      assert.equal(tool.description, describeShell(resolveShell()));
      await runner.cleanup();
    });
  });

  it("advertises bash syntax for the docker sandbox runner even on Windows hosts", () => {
    // Simulated docker runner: the container shell is always Linux bash.
    const tool = createBashTool("unused", { runner: new DockerSandboxRunner() });
    const dockerDescription = describeShell({ command: "bash", args: ["-lc"], kind: "bash" });
    assert.equal(tool.description, dockerDescription);
    assert.doesNotMatch(tool.description, /PowerShell/);
  });

  it("executes a command and reports success on this platform", async () => {
    await withTempDir(async (tmpDir) => {
      const tool = createBashTool(tmpDir);
      // Portable across bash, PowerShell, and cmd.
      const result = await tool.execute({ command: "echo shell-ok" });
      assert.ok(!result.isError);
      assert.match(contentAsString(result.content), /shell-ok/);
    });
  });
});

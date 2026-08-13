import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { GitWorkflow } from "../src/git/workflow.ts";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "mini-agent", GIT_AUTHOR_EMAIL: "mini-agent@example.invalid", GIT_COMMITTER_NAME: "mini-agent", GIT_COMMITTER_EMAIL: "mini-agent@example.invalid" },
  });
  return result.stdout;
}

describe("GitWorkflow", () => {
  it("creates a checkpoint and restores tracked and untracked changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-git-"));
    try {
      await git(root, "init", "-q");
      await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-qm", "initial");
      const workflow = new GitWorkflow(root, { checkpointDir: path.join(root, "checkpoint-index") });
      await writeFile(path.join(root, "tracked.txt"), "checkpoint\n", "utf8");
      await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
      await writeFile(path.join(root, "staged.txt"), "staged at checkpoint\n", "utf8");
      await git(root, "add", "staged.txt");
      const checkpoint = await workflow.createCheckpoint("before change");
      await writeFile(path.join(root, "tracked.txt"), "broken\n", "utf8");
      await writeFile(path.join(root, "new.txt"), "changed\n", "utf8");
      await writeFile(path.join(root, "staged.txt"), "broken staged\n", "utf8");
      await git(root, "add", "staged.txt");
      await writeFile(path.join(root, "extra.txt"), "extra\n", "utf8");
      await workflow.undo(checkpoint.id);
      assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "checkpoint\n");
      assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "new\n");
      assert.equal(await readFile(path.join(root, "staged.txt"), "utf8"), "staged at checkpoint\n");
      const restoredStatus = await git(root, "status", "--porcelain");
      assert.match(restoredStatus, /^ M tracked\.txt$/m);
      assert.match(restoredStatus, /^A  staged\.txt$/m);
      assert.match(restoredStatus, /^\?\? new\.txt$/m);
      await assert.rejects(readFile(path.join(root, "extra.txt"), "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports branch state and refuses isolation from a dirty worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-git-status-"));
    try {
      await git(root, "init", "-q");
      await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-qm", "initial");
      const worktreeDir = `${root}-worktrees`;
      const workflow = new GitWorkflow(root, { checkpointDir: path.join(root, "checkpoint-index"), worktreeDir });
      const status = await workflow.status();
      assert.equal(status.dirty, false);
      await writeFile(path.join(root, "tracked.txt"), "dirty\n", "utf8");
      await assert.rejects(workflow.createIsolatedBranch("task"), /clean worktree/);
      await git(root, "restore", "tracked.txt");
      const isolated = await workflow.createIsolatedBranch("task");
      assert.match(isolated.branch, /^mini-agent\/task-/);
      assert.equal(await readFile(path.join(isolated.path, "tracked.txt"), "utf8"), "one\n");
      await git(root, "worktree", "remove", "--force", isolated.path);
      await rm(worktreeDir, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

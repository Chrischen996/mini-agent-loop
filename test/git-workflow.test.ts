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
  it("lists staged, unstaged, and untracked workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-git-changes-"));
    try {
      await git(root, "init", "-q");
      await git(root, "config", "core.autocrlf", "false");
      await writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-qm", "initial");

      await writeFile(path.join(root, "tracked.txt"), "staged\n", "utf8");
      await git(root, "add", "tracked.txt");
      await writeFile(path.join(root, "tracked.txt"), "staged\nunstaged\n", "utf8");
      await writeFile(path.join(root, "new file.txt"), "new\n", "utf8");

      const workflow = new GitWorkflow(root);
      const changedFiles = await (workflow as unknown as {
        changedFiles: () => Promise<Array<{ path: string; status: string }>>;
      }).changedFiles();
      assert.deepEqual(changedFiles, [
        { path: "new file.txt", status: "??", staged: false, unstaged: false, untracked: true },
        { path: "tracked.txt", status: "MM", staged: true, unstaged: true, untracked: false },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows a file diff for staged and unstaged changes and for new files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-git-file-diff-"));
    try {
      await git(root, "init", "-q");
      await git(root, "config", "core.autocrlf", "false");
      await writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-qm", "initial");

      await writeFile(path.join(root, "tracked.txt"), "base\nstaged line\n", "utf8");
      await git(root, "add", "tracked.txt");
      await writeFile(path.join(root, "tracked.txt"), "base\nstaged line\nunstaged line\n", "utf8");
      await writeFile(path.join(root, "new file.txt"), "new line\n", "utf8");

      const workflow = new GitWorkflow(root);
      const fileDiff = (workflow as unknown as { diffPath: (file: string) => Promise<string> }).diffPath;
      const tracked = await fileDiff.call(workflow, "tracked.txt");
      const added = await fileDiff.call(workflow, "new file.txt");
      assert.match(tracked, /\+staged line/);
      assert.match(tracked, /\+unstaged line/);
      assert.match(added, /diff --git a\/new file\.txt b\/new file\.txt/);
      assert.match(added, /\+new line/);
      await assert.rejects(fileDiff.call(workflow, "../outside.txt"), /changed workspace file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a checkpoint and restores tracked and untracked changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-git-"));
    try {
      await git(root, "init", "-q");
      await git(root, "config", "core.autocrlf", "false");
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
      await git(root, "config", "core.autocrlf", "false");
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
      const [isolated, concurrent] = await Promise.all([
        workflow.createIsolatedBranch("task"),
        workflow.createIsolatedBranch("task"),
      ]);
      assert.match(isolated.branch, /^mini-agent\/task-/);
      assert.notEqual(isolated.branch, concurrent.branch);
      assert.notEqual(isolated.path, concurrent.path);
      assert.equal(await workflow.isRegisteredWorktree(isolated.path), true, await git(root, "worktree", "list", "--porcelain"));
      assert.equal(await workflow.isRegisteredWorktree(concurrent.path), true);
      assert.equal(await readFile(path.join(isolated.path, "tracked.txt"), "utf8"), "one\n");
      await git(root, "worktree", "remove", "--force", isolated.path);
      await git(root, "worktree", "remove", "--force", concurrent.path);
      assert.equal(await workflow.isRegisteredWorktree(isolated.path), false);
      await rm(worktreeDir, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

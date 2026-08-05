import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGitBranch } from "../src/tui/git-branch.ts";

const execFileAsync = promisify(execFile);

describe("TUI git branch", () => {
  it("reads the current branch without a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-agent-branch-test-"));
    try {
      await execFileAsync("git", ["init", "-b", "feature/image-status"], { cwd: directory });
      assert.equal(await getGitBranch(directory), "feature/image-status");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hides the branch outside a Git worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-agent-non-git-test-"));
    try {
      assert.equal(await getGitBranch(directory), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

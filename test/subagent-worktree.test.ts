import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createSubagentTool, resolveSubagentWorktree, SubagentTaskRegistry } from "../src/subagent/index.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { SubagentEvent } from "../src/subagent/types.ts";
import type { Tool, ToolExecutionOptions, ToolResult } from "../src/tools/types.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(dir: string): Promise<string> {
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "worktree-test@example.com");
  git(repo, "config", "user.name", "worktree-test");
  await writeFile(path.join(repo, "file.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const llm = makeLlmConfig({ apiKey: "test-key", baseUrl: "http://localhost/v1", model: "faux" });

describe("resolveSubagentWorktree", () => {
  it("creates a fresh worktree in the source repository", async () => {
    await withTempDir("subagent-wt-", async (dir) => {
      const repo = await makeRepo(dir);
      const outcome = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000000",
        worktreeBaseDir: path.join(dir, "worktrees"),
      });
      assert.equal(outcome.kind, "isolated");
      if (outcome.kind !== "isolated") return;
      assert.match(outcome.worktreeBranch, /^mini-agent\/subagent-/);
      assert.equal(outcome.worktreePath.startsWith(path.join(dir, "worktrees")), true);
      assert.equal(existsSync(outcome.worktreePath), true);
      // The isolated worktree is a registered git worktree of the source repo.
      assert.ok(git(repo, "worktree", "list", "--porcelain").includes(outcome.worktreePath));
    });
  });

  it("reuses a registered persisted worktree on resume", async () => {
    await withTempDir("subagent-wt-resume-", async (dir) => {
      const repo = await makeRepo(dir);
      const baseDir = path.join(dir, "worktrees");
      const first = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000001",
        worktreeBaseDir: baseDir,
      });
      assert.equal(first.kind, "isolated");
      if (first.kind !== "isolated") return;
      const second = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000001",
        worktreeBaseDir: baseDir,
        resume: { worktreePath: first.worktreePath, worktreeBranch: first.worktreeBranch },
      });
      assert.deepEqual(second, first, "a registered worktree is reused, not re-created");
    });
  });

  it("rehydrates a removed worktree from its persisted branch", async () => {
    await withTempDir("subagent-wt-rehydrate-", async (dir) => {
      const repo = await makeRepo(dir);
      const baseDir = path.join(dir, "worktrees");
      const first = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000002",
        worktreeBaseDir: baseDir,
      });
      assert.equal(first.kind, "isolated");
      if (first.kind !== "isolated") return;
      // Remove the worktree directory but keep the branch (like a cleaned-up session).
      git(repo, "worktree", "remove", "--force", first.worktreePath);
      assert.equal(existsSync(first.worktreePath), false);
      const rehydrated = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000002",
        worktreeBaseDir: baseDir,
        resume: { worktreePath: first.worktreePath, worktreeBranch: first.worktreeBranch },
      });
      assert.equal(rehydrated.kind, "isolated");
      if (rehydrated.kind === "isolated") {
        assert.equal(rehydrated.worktreePath, first.worktreePath);
        assert.equal(existsSync(rehydrated.worktreePath), true);
      }
    });
  });

  it("falls back to the shared workspace when the source is not a git repository", async () => {
    await withTempDir("subagent-wt-fallback-", async (dir) => {
      const outcome = await resolveSubagentWorktree({ sourceCwd: dir, taskId: "sub_00000000-0000-4000-8000-000000000003" });
      assert.equal(outcome.kind, "shared");
      if (outcome.kind === "shared") assert.match(outcome.reason, /shared workspace/);
    });
  });

  it("falls back to shared on resume when the persisted worktree cannot be rehydrated", async () => {
    await withTempDir("subagent-wt-resume-fallback-", async (dir) => {
      const repo = await makeRepo(dir);
      const baseDir = path.join(dir, "worktrees");
      const outcome = await resolveSubagentWorktree({
        sourceCwd: repo,
        taskId: "sub_00000000-0000-4000-8000-000000000004",
        worktreeBaseDir: baseDir,
        resume: {
          worktreePath: path.join(baseDir, "gone"),
          worktreeBranch: "mini-agent/subagent-does-not-exist",
        },
      });
      assert.equal(outcome.kind, "shared");
      if (outcome.kind === "shared") assert.match(outcome.reason, /could not be rehydrated/);
    });
  });
});

describe("subagent tool worktree isolation", () => {
  it("runs the child's tools inside the isolated worktree and persists the record", async () => {
    await withTempDir("subagent-tool-wt-", async (dir) => {
      const repo = await makeRepo(dir);
      const baseDir = path.join(dir, "worktrees");
      const seenCwds: Array<string | undefined> = [];
      const cwdProbe: Tool = {
        name: "cwd_probe",
        description: "records the execution cwd",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_args, _signal, options?: ToolExecutionOptions): Promise<ToolResult> => {
          seenCwds.push(options?.cwd);
          return { content: "cwd recorded" };
        },
      };
      let chatTurn = 0;
      const chat: ChatFn = async () => {
        chatTurn += 1;
        if (chatTurn === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "probe_1", name: "cwd_probe", arguments: {} }],
          };
        }
        return { role: "assistant", content: "work finished" };
      };
      const events: SubagentEvent[] = [];
      const registry = new SubagentTaskRegistry(dir);
      const tool = createSubagentTool({
        parentLlm: llm,
        parentTools: [cwdProbe],
        taskRegistry: registry,
        chat,
        worktreeBaseDir: baseDir,
        worktreeSourceCwd: repo,
        onSubagentEvent: (event) => { events.push(event); },
      });
      const result = await tool.execute(
        { task: "probe the workspace", isolation: "worktree", runInBackground: false },
        undefined,
        { sessionId: "session-wt" },
      );
      assert.equal(result.isError, undefined);
      assert.match(String(result.content), /\[worktree\]/, "result carries the merge hint");
      const ended = events.find((event) => event.type === "subagent_end") as Extract<SubagentEvent, { type: "subagent_end" }>;
      assert.ok(ended.worktreePath, "end event carries the worktree path");
      assert.match(ended.worktreePath!, new RegExp(baseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const record = await registry.get(ended.id, "session-wt");
      assert.equal(record?.isolation, "worktree");
      assert.equal(record?.worktreePath, ended.worktreePath);
      assert.equal(record?.worktreeBranch, ended.worktreeBranch);
      assert.equal(record?.status, "completed");
      // The child's tools executed inside the isolated worktree, not the live checkout.
      const worktreeCwds = seenCwds.filter((cwd) => cwd !== undefined);
      assert.ok(worktreeCwds.length > 0, "at least one tool call saw the execution cwd");
      assert.ok(worktreeCwds.every((cwd) => cwd === ended.worktreePath), "all child tool calls ran in the worktree");
    });
  });
});

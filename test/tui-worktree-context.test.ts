import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionManager } from "../src/permissions.ts";
import type { Tool } from "../src/tools/types.ts";
import { resolveAtRefs } from "../src/tui/at-refs-resolver.ts";
import { runDirectTool } from "../src/tui/direct-tool-runner.ts";

describe("TUI worktree execution context", () => {
  it("passes the active cwd to directly invoked tools", async () => {
    const projectCwd = "/project/root";
    const worktreeCwd = "/isolated/agent-1";
    let executedCwd: string | undefined;
    const tool: Tool = {
      name: "read",
      description: "Read a workspace file.",
      annotations: { readOnlyHint: true },
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, _signal, options) => {
        executedCwd = options?.cwd;
        return { content: "read" };
      },
    };

    await runDirectTool("read", {}, {
      allTools: [tool],
      permissionSessionId: "agent-session",
      getPermissionManager: () => new PermissionManager("bypass"),
      abortSignal: new AbortController().signal,
      dispatch: () => {},
      runtimeContext: { workspaceId: projectCwd, cwd: worktreeCwd },
    });

    assert.equal(executedCwd, worktreeCwd);
  });

  it("resolves @file references from the active worktree", async () => {
    const worktreeCwd = "/isolated/agent-2";
    let executedCwd: string | undefined;
    const tool: Tool = {
      name: "read",
      description: "Read a workspace file.",
      annotations: { readOnlyHint: true },
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, _signal, options) => {
        executedCwd = options?.cwd;
        return { content: "worktree file contents" };
      },
    };
    const permissions = new PermissionManager("bypass");
    const signal = new AbortController().signal;
    const turn = permissions.beginTurn("agent-session", () => {}, signal);

    try {
      const result = await resolveAtRefs(
        "Inspect @src/index.ts",
        turn,
        [tool],
        undefined,
        { workspaceId: "/project/root", cwd: worktreeCwd },
      );
      assert.equal(executedCwd, worktreeCwd);
      assert.ok(Array.isArray(result));
      assert.ok(result.some((part) => part.type === "text" && part.text.includes("worktree file contents")));
    } finally {
      turn.close();
    }
  });
});

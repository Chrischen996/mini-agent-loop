import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveToolCapabilities } from "../src/runtime/tool-types.ts";
import { PermissionManager } from "../src/permissions.ts";
import type { Tool } from "../src/tools/types.ts";

describe("bg-tasks security & capabilities", () => {
  const dummyTool = (name: string): Tool => ({
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
  });

  it("marks bg_send as execution/write tool requiring approval", () => {
    const caps = resolveToolCapabilities(dummyTool("bg_send"));
    assert.equal(caps.executeProcess, true);
    assert.equal(caps.writeWorkspace, true);
    assert.equal(caps.requiresApproval, true);
  });

  it("marks bg_status, bg_logs, and bg_wait as read-only tools", () => {
    for (const name of ["bg_status", "bg_logs", "bg_wait"]) {
      const caps = resolveToolCapabilities(dummyTool(name));
      assert.equal(caps.readWorkspace, true, `${name} should have readWorkspace=true`);
      assert.equal(caps.writeWorkspace, false, `${name} should have writeWorkspace=false`);
      assert.equal(caps.executeProcess, false, `${name} should have executeProcess=false`);
    }
  });

  it("allows safe read-only commands in bg_start under plan mode", async () => {
    const pm = new PermissionManager("plan");
    let executions = 0;
    const tool: Tool = {
      name: "bg_start",
      description: "start bg task",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions += 1;
        return { content: "ok" };
      },
    };
    const turn = pm.beginTurn("session-1", () => {});
    const res = await turn.execute(tool, { command: "git log --oneline -n 10" });
    assert.equal(res.content, "ok");
    assert.equal(executions, 1);
    turn.close();
  });

  it("denies dangerous/write commands in bg_start under plan mode", async () => {
    const pm = new PermissionManager("plan");
    let executions = 0;
    const tool: Tool = {
      name: "bg_start",
      description: "start bg task",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions += 1;
        return { content: "ok" };
      },
    };
    const turn = pm.beginTurn("session-1", () => {});
    await assert.rejects(
      async () => {
        await turn.execute(tool, { command: "rm -rf node_modules" });
      },
      /plan mode is analysis-only/i,
    );
    assert.equal(executions, 0);
    turn.close();
  });

  it("allows bg_status, bg_logs, bg_wait, and bg_kill in plan mode", async () => {
    const pm = new PermissionManager("plan");
    const turn = pm.beginTurn("session-1", () => {});
    for (const name of ["bg_status", "bg_logs", "bg_wait", "bg_kill"]) {
      let executions = 0;
      const tool: Tool = {
        name,
        description: "read or manage bg task",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executions += 1;
          return { content: "ok" };
        },
      };
      const res = await turn.execute(tool, {});
      assert.equal(res.content, "ok");
      assert.equal(executions, 1, `${name} should be executed`);
    }
    turn.close();
  });
});

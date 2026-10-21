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

  it("marks the newer read-only background-task tools as read-only", () => {
    for (const name of ["bg_status_by_tag", "bg_search_logs"]) {
      const caps = resolveToolCapabilities(dummyTool(name));
      assert.equal(caps.readWorkspace, true, `${name} should read workspace`);
      assert.equal(caps.executeProcess, false, `${name} should not execute processes`);
      assert.equal(caps.requiresApproval, false, `${name} should not require approval`);
    }
  });

  it("blocks bg_snapshot and bg_start templates in plan mode", async () => {
    const pm = new PermissionManager("plan");
    const turn = pm.beginTurn("session-1", () => {});
    const snapshotTool: Tool = {
      name: "bg_snapshot",
      description: "snapshot writer",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };
    await assert.rejects(
      async () => {
        await turn.execute(snapshotTool, { taskId: "bg_1" });
      },
      /plan mode is analysis-only/i,
    );
    // A template hides its command until the manager expands it, so plan mode
    // cannot vouch for it.
    const startTool: Tool = {
      name: "bg_start",
      description: "start bg task",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };
    await assert.rejects(
      async () => {
        await turn.execute(startTool, { template: "nightly" });
      },
      /plan mode is analysis-only/i,
    );
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

  it("allows read-only bg commands in plan mode", async () => {
    const pm = new PermissionManager("plan");
    const turn = pm.beginTurn("session-1", () => {});
    for (const name of ["bg_status", "bg_logs", "bg_wait", "bg_status_by_tag", "bg_search_logs"]) {
      let executions = 0;
      const tool: Tool = {
        name,
        description: "read bg task state",
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

  it("denies bg process-control tools in plan mode", async () => {
    const pm = new PermissionManager("plan");
    const turn = pm.beginTurn("session-1", () => {});
    for (const name of ["bg_kill", "bg_kill_by_tag", "bg_replay"]) {
      let executions = 0;
      const tool: Tool = {
        name,
        description: "control bg task process",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executions += 1;
          return { content: "ok" };
        },
      };
      await assert.rejects(
        async () => {
          await turn.execute(tool, {});
        },
        /plan mode is analysis-only/i,
      );
      assert.equal(executions, 0, `${name} should not be executed`);
    }
    turn.close();
  });

  it("marks bg_snapshot as a write tool and bg process controls as approval-gated", () => {
    const snapshot = resolveToolCapabilities(dummyTool("bg_snapshot"));
    assert.equal(snapshot.writeWorkspace, true);
    assert.equal(snapshot.requiresApproval, true);

    for (const name of ["bg_kill", "bg_kill_by_tag", "bg_replay"]) {
      const caps = resolveToolCapabilities(dummyTool(name));
      assert.equal(caps.executeProcess, true, `${name} should execute a process`);
      assert.equal(caps.requiresApproval, true, `${name} should require approval`);
    }
  });
});

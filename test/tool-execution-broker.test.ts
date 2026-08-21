import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionManager, PermissionModeChangedError } from "../src/permissions.ts";
import {
  createToolExecutionFingerprint,
  ToolExecutionBroker,
} from "../src/runtime/tool-execution-broker.ts";
import {
  NetworkPolicyError,
  PolicyRevisionChangedError,
  SandboxPolicyError,
  ToolPolicyError,
} from "../src/runtime/policy-types.ts";
import { resolveToolCapabilities } from "../src/runtime/tool-types.ts";
import type { Tool } from "../src/tools/types.ts";

function tool(name: string, execute: Tool["execute"] = async () => ({ content: "ok" })): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object" },
    execute,
  };
}

describe("ToolExecutionBroker", () => {
  it("resolves local read and write capabilities when tools omit declarations", () => {
    const read = resolveToolCapabilities(tool("read"), { path: "README.md" });
    const write = resolveToolCapabilities(tool("write"), { path: "README.md" });
    assert.equal(read.readWorkspace, true);
    assert.equal(read.writeWorkspace, false);
    assert.equal(read.requiresApproval, false);
    assert.equal(write.writeWorkspace, true);
    assert.equal(write.requiresApproval, true);
  });

  it("does not treat a remote MCP read-looking tool as a local safe read", async () => {
    const mcpRead = {
      ...tool("read"),
      source: { kind: "mcp", serverId: "remote", toolName: "read" } as const,
    };
    const capabilities = resolveToolCapabilities(mcpRead);
    assert.equal(capabilities.readWorkspace, true);
    assert.equal(capabilities.externalData, true);
    assert.equal(capabilities.requiresApproval, true);

    const manager = new PermissionManager("plan");
    const turn = manager.beginTurn("mcp", () => {
      throw new Error("plan mode must not open interactive approval");
    });
    try {
      await assert.rejects(
        () => new ToolExecutionBroker().execute(mcpRead, {}, { permissionTurn: turn }),
        /Permission denied.*plan mode/,
      );
    } finally {
      turn.close();
    }
  });

  it("keeps fingerprints stable when argument object keys are reordered", () => {
    const read = tool("read");
    const first = createToolExecutionFingerprint(read, { path: "a", options: { limit: 10, offset: 1 } }, {
      taskId: "task_1",
      workspaceId: "workspace_1",
      policyRevision: 3,
    });
    const second = createToolExecutionFingerprint(read, { options: { offset: 1, limit: 10 }, path: "a" }, {
      taskId: "task_1",
      workspaceId: "workspace_1",
      policyRevision: 3,
    });
    assert.equal(first, second);
  });

  it("rejects a stale policy before executing the tool", async () => {
    let revision = 1;
    let executions = 0;
    const broker = new ToolExecutionBroker();
    await assert.rejects(
      () => broker.execute(tool("write", async () => {
        executions += 1;
        return { content: "must not run" };
      }), {}, {
        policyRevision: 1,
        getPolicyRevision: () => revision,
        beforeExecute: () => {
          revision = 2;
        },
      }),
      (error: unknown) => error instanceof PolicyRevisionChangedError,
    );
    assert.equal(executions, 0);
  });

  it("propagates abort signals and rejects already aborted calls", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const broker = new ToolExecutionBroker();
    const result = await broker.execute(tool("read", async (_args, signal) => {
      received = signal;
      return { content: "ok" };
    }), {}, { signal: controller.signal });
    assert.equal(result.content, "ok");
    assert.equal(received, controller.signal);

    controller.abort();
    await assert.rejects(
      () => broker.execute(tool("read", async () => ({ content: "must not run" })), {}, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  });

  it("requires secure isolation when required sandbox policy is explicit", async () => {
    await assert.rejects(
      () => new ToolExecutionBroker().execute(tool("bash"), { command: "printf ok" }, {
        sandboxMode: "required",
        sandboxIsolation: "process-isolation",
      }),
      (error: unknown) => error instanceof SandboxPolicyError,
    );

    await assert.rejects(
      () => new ToolExecutionBroker().execute(tool("write"), {}, {
        sandboxMode: "required",
        sandboxIsolation: "none",
      }),
      (error: unknown) => error instanceof SandboxPolicyError,
    );
  });

  it("enforces the runtime tool and network policy before execution", async () => {
    let executions = 0;
    await assert.rejects(
      () => new ToolExecutionBroker().execute(tool("write", async () => {
        executions += 1;
        return { content: "must not run" };
      }), {}, { allowedTools: ["read"] }),
      (error: unknown) => error instanceof ToolPolicyError,
    );
    assert.equal(executions, 0);

    await assert.rejects(
      () => new ToolExecutionBroker().execute({
        ...tool("fetch"),
        capabilities: { network: true },
      }, {}, { network: "none" }),
      (error: unknown) => error instanceof NetworkPolicyError,
    );
  });

  it("routes an authorized tool through one turn and emits audit events", async () => {
    const manager = new PermissionManager("bypass");
    const events: string[] = [];
    const turn = manager.beginTurn("audit", () => {});
    try {
      const result = await new ToolExecutionBroker().execute(tool("read"), {}, {
        permissionTurn: turn,
        onAudit: (event) => events.push(event.type),
      });
      assert.equal(result.content, "ok");
      assert.deepEqual(events, ["requested", "started", "completed"]);
    } finally {
      turn.close();
    }
  });

  it("propagates permission revision cancellation through the broker", async () => {
    const manager = new PermissionManager("bypass");
    const turn = manager.beginTurn("revision", () => {});
    const pending = new ToolExecutionBroker().execute(tool("read", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { content: "late" };
    }), {}, { permissionTurn: turn });
    manager.setMode("plan");
    await assert.rejects(pending, (error: unknown) => error instanceof PermissionModeChangedError);
    turn.close();
  });
});

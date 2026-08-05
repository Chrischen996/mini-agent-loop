import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PermissionManager,
  PermissionModeChangedError,
  type PermissionMode,
} from "../src/permissions.ts";
import type { Tool } from "../src/tools/types.ts";

const writeTool: Tool = {
  name: "write",
  description: "write",
  parameters: { type: "object" },
  execute: async () => ({ content: "ok" }),
};

describe("PermissionManager", () => {
  it("pauses a write tool until allowed", async () => {
    const manager = new PermissionManager();
    let requestId = "";
    const pending = manager.authorize("session", writeTool, { path: "a.txt" }, undefined, (request) => {
      requestId = request.id;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestId);
    assert.equal(manager.resolve("session", requestId, "allow"), true);
    await pending;
  });

  it("automatically allows read-only tools and rejects denial", async () => {
    const manager = new PermissionManager();
    const readTool = { ...writeTool, name: "read" };
    await manager.authorize("session", readTool, {}, undefined, () => {
      throw new Error("read should not request permission");
    });
    let requestId = "";
    const pending = manager.authorize("session", writeTool, {}, undefined, (request) => {
      requestId = request.id;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.resolve("session", requestId, "deny"), true);
    await assert.rejects(pending, /Permission denied/);
  });

  it("automatically allows read-only codebase operations after opening a handle", async () => {
    const manager = new PermissionManager();
    for (const name of ["codebase_search", "codebase_read", "codebase_explain"]) {
      await manager.authorize("session", { ...writeTool, name }, {}, undefined, () => {
        throw new Error(`${name} should not request permission`);
      });
    }
  });

  it("treats pi-web-access reads as read-only open-world tools", async () => {
    const webTool: Tool = {
      ...writeTool,
      name: "web_search",
      source: { kind: "web", package: "pi-web-access" },
      annotations: { readOnlyHint: true, openWorldHint: true },
    };
    await new PermissionManager("plan").authorize("session", webTool, { query: "test" }, undefined, () => {
      throw new Error("plan web search should not request approval");
    });
    await new PermissionManager("auto").authorize("session", webTool, { query: "test" }, undefined, () => {
      throw new Error("auto web search should not request approval");
    });

    const manual = new PermissionManager("manual");
    let requestId = "";
    const pending = manual.authorize("session", webTool, { query: "test" }, undefined, (request) => {
      requestId = request.id;
      assert.equal(request.risk, "medium");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestId);
    manual.resolve("session", requestId, "deny");
    await assert.rejects(pending, /Permission denied/);
  });

  it("keeps codebase_open behind a medium-risk approval", async () => {
    const manager = new PermissionManager();
    let requestId = "";
    const pending = manager.authorize(
      "session",
      { ...writeTool, name: "codebase_open" },
      { repository: "octo/project" },
      undefined,
      (request) => {
        requestId = request.id;
        assert.equal(request.risk, "medium");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestId);
    manager.resolve("session", requestId, "deny");
    await assert.rejects(pending, /Permission denied/);
  });

  it("never auto-allows an MCP tool based on its name or annotations", async () => {
    const manager = new PermissionManager();
    const remoteRead: Tool = {
      ...writeTool,
      name: "read",
      source: { kind: "mcp", serverId: "remote", toolName: "read" },
      annotations: { readOnlyHint: true },
    };
    let requestId = "";
    let seenRisk = "";
    const pending = manager.authorize("session", remoteRead, {}, undefined, (request) => {
      requestId = request.id;
      seenRisk = request.risk;
      assert.deepEqual(request.source, remoteRead.source);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestId);
    assert.equal(seenRisk, "high");
    manager.resolve("session", requestId, "deny");
    await assert.rejects(pending, /Permission denied/);
  });

  it("bypass mode allows MCP tools through the shared policy", async () => {
    const manager = new PermissionManager("bypass");
    const remoteWrite: Tool = {
      ...writeTool,
      source: { kind: "mcp", serverId: "remote", toolName: "write" },
    };
    await manager.authorize("session", remoteWrite, {}, undefined, () => {
      throw new Error("bypass mode must not request MCP approval");
    });
  });

  describe("Permission Modes", () => {
    it("plan mode: hard-denies write tools, allows read-only bash, and hard-denies dangerous bash", async () => {
      const manager = new PermissionManager("plan");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };
      const readToolMock = { ...writeTool, name: "read" };

      // Write is analysis-only: hard-deny without opening an approval prompt
      const writeEvents: Array<{ type: string; id: string }> = [];
      manager.onPermissionEvent = (event) => {
        writeEvents.push({ type: event.type, id: event.request.id });
      };
      await assert.rejects(
        manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(writeEvents.length, 2);
      assert.equal(writeEvents[0]?.type, "request");
      assert.equal(writeEvents[1]?.type, "deny");
      assert.equal(manager.resolve("session", writeEvents[0]!.id, "allow"), false);

      // Read-only bash should auto-allow in plan mode
      await manager.authorize("session", bashToolMock, { command: "find . -type f | head -50" }, undefined, () => {
        throw new Error("read-only bash should auto-allow in plan mode");
      });

      // Read-only bash should not be blocked by dangerous-looking search terms
      await manager.authorize("session", bashToolMock, { command: "grep rm README.md" }, undefined, () => {
        throw new Error("grep with a dangerous-looking search term should still auto-allow in plan mode");
      });

      // Dangerous bash is hard-denied in plan mode
      const bashEvents: Array<{ type: string; risk: string }> = [];
      manager.onPermissionEvent = (event) => {
        bashEvents.push({ type: event.type, risk: event.request.risk });
      };
      await assert.rejects(
        manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(bashEvents[0]?.type, "request");
      assert.equal(bashEvents[0]?.risk, "high");
      assert.equal(bashEvents[1]?.type, "deny");

      // Shell wrappers should still catch dangerous inner commands
      const wrappedEvents: Array<{ type: string; risk: string }> = [];
      manager.onPermissionEvent = (event) => {
        wrappedEvents.push({ type: event.type, risk: event.request.risk });
      };
      await assert.rejects(
        manager.authorize("session", bashToolMock, { command: "bash -c 'rm -rf /'" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(wrappedEvents[0]?.type, "request");
      assert.equal(wrappedEvents[0]?.risk, "high");
      assert.equal(wrappedEvents[1]?.type, "deny");

      // Read should auto-allow
      await manager.authorize("session", readToolMock, { path: "test.txt" }, undefined, () => {
        throw new Error("read should auto-allow in plan mode");
      });
    });

    it("bypass mode: auto-allows everything including write and bash", async () => {
      const manager = new PermissionManager("bypass");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };

      // Write should auto-allow
      await manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
        throw new Error("write should auto-allow in bypass mode");
      });

      // Bash should auto-allow
      await manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, () => {
        throw new Error("bash should auto-allow in bypass mode");
      });
    });

    it("manual mode: requires approval for every tool including read", async () => {
      const manager = new PermissionManager("manual");
      const readToolMock = { ...writeTool, name: "read" };
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };

      let readRequestId = "";
      const readPending = manager.authorize("session", readToolMock, { path: "test.txt" }, undefined, (request) => {
        readRequestId = request.id;
        assert.equal(request.risk, "medium");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(readRequestId);
      manager.resolve("session", readRequestId, "allow");
      await readPending;

      let writeRequestId = "";
      const writePending = manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, (request) => {
        writeRequestId = request.id;
        assert.equal(request.risk, "medium");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(writeRequestId);
      manager.resolve("session", writeRequestId, "deny");
      await assert.rejects(writePending, /Permission denied/);

      let bashRequestId = "";
      const bashPending = manager.authorize("session", bashToolMock, { command: "echo hello" }, undefined, (request) => {
        bashRequestId = request.id;
        assert.equal(request.risk, "medium");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(bashRequestId);
      manager.resolve("session", bashRequestId, "allow");
      await bashPending;
    });

    it("auto mode: allows read-only tools automatically", async () => {
      const manager = new PermissionManager("auto");
      const readToolMock = { ...writeTool, name: "read" };
      const grepToolMock = { ...writeTool, name: "grep" };

      await manager.authorize("session", readToolMock, { path: "test.txt" }, undefined, () => {
        throw new Error("read should auto-allow in auto mode");
      });
      await manager.authorize("session", grepToolMock, { pattern: "test" }, undefined, () => {
        throw new Error("grep should auto-allow in auto mode");
      });
    });

    it("auto mode: requests permission for write and bash tools", async () => {
      const manager = new PermissionManager("auto");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };

      let writeRequestId = "";
      const writePending = manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, (request) => {
        writeRequestId = request.id;
        assert.equal(request.risk, "medium");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(writeRequestId);
      manager.resolve("session", writeRequestId, "deny");
      await assert.rejects(writePending, /Permission denied/);

      let bashRequestId = "";
      const bashPending = manager.authorize("session", bashToolMock, { command: "echo hello" }, undefined, (request) => {
        bashRequestId = request.id;
        assert.equal(request.risk, "medium");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(bashRequestId);
      manager.resolve("session", bashRequestId, "allow");
      await bashPending;
    });

    it("auto mode: marks dangerous bash commands as high risk", async () => {
      const manager = new PermissionManager("auto");
      const bashToolMock = { ...writeTool, name: "bash" };

      let seenRisk = "";
      let bashRequestId = "";
      const pending = manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, (request) => {
        bashRequestId = request.id;
        seenRisk = request.risk;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seenRisk, "high");
      manager.resolve("session", bashRequestId, "deny");
      await assert.rejects(pending, /Permission denied/);
    });

    it("can switch modes dynamically", async () => {
      const manager = new PermissionManager("plan");
      const writeToolMock = { ...writeTool, name: "write" };

      // In plan mode, writes are hard-denied
      await assert.rejects(
        manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );

      // Switch to bypass mode
      manager.setMode("bypass");

      // Now should auto-allow
      await manager.authorize("session", writeToolMock, { path: "test2.txt", content: "world" }, undefined, () => {
        throw new Error("write should auto-allow after switching to bypass mode");
      });
    });

    it("does not reuse an approval after switching modes", async () => {
      const manager = new PermissionManager("auto");
      let requestId = "";
      const args = { path: "same.txt", content: "hello" };
      const first = manager.authorize("session", writeTool, args, undefined, (request) => {
        requestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      manager.resolve("session", requestId, "allow");
      await first;

      manager.setMode("manual");
      requestId = "";
      const second = manager.authorize("session", writeTool, args, undefined, (request) => {
        requestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(requestId);
      manager.resolve("session", requestId, "deny");
      await assert.rejects(second, /Permission denied/);
    });

    it("does not reuse a local approval for an MCP tool with the same name and args", async () => {
      const manager = new PermissionManager("auto");
      const args = { path: "same.txt", content: "hello" };
      let localRequestId = "";
      const local = manager.authorize("source", writeTool, args, undefined, (request) => {
        localRequestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      manager.resolve("source", localRequestId, "allow");
      await local;

      let remoteRequestId = "";
      const remote = manager.authorize("source", {
        ...writeTool,
        source: { kind: "mcp", serverId: "remote", toolName: "write" },
      }, args, undefined, (request) => {
        remoteRequestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(remoteRequestId);
      manager.resolve("source", remoteRequestId, "deny");
      await assert.rejects(remote, /Permission denied/);
    });

    it("serializes and deserializes state correctly", async () => {
      const manager = new PermissionManager("auto");
      let requestId = "";
      const pending = manager.authorize("session", writeTool, { path: "test.txt", content: "hello" }, undefined, (request) => {
        requestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(requestId);
      manager.resolve("session", requestId, "allow");
      await pending;

      const serialized = manager.serialize();
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.mode, "auto");
      assert.equal(parsed.approved.length, 1);

      const manager3 = new PermissionManager("plan");
      manager3.deserialize(serialized);
      assert.equal(manager3.getMode(), "auto");
      await manager3.authorize("session", writeTool, { path: "test.txt", content: "hello" }, undefined, () => {
        throw new Error("serialized approval should allow the same write tool without prompting");
      });
    });

    it("handles invalid deserialization gracefully", () => {
      const manager = new PermissionManager("auto");
      manager.deserialize("invalid json");
      assert.equal(manager.getMode(), "auto");
    });

    it("calls onPermissionEvent callback for all events", async () => {
      // Test bypass mode - should trigger allow event but not onRequest
      const bypassManager = new PermissionManager("bypass");
      const events: Array<{ type: string; tool: string }> = [];
      bypassManager.onPermissionEvent = (event) => {
        events.push({ type: event.type, tool: event.request.tool });
      };
      await bypassManager.authorize("session", writeTool, { path: "test.txt" }, undefined, () => {
        throw new Error("should not request permission in bypass mode");
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "allow");
      assert.equal(events[0]?.tool, "write");

      // Test plan mode - should trigger request + deny events and hard-fail
      const planManager = new PermissionManager("plan");
      const planEvents: Array<{ type: string; tool: string; id: string }> = [];
      planManager.onPermissionEvent = (event) => {
        planEvents.push({ type: event.type, tool: event.request.tool, id: event.request.id });
      };
      await assert.rejects(
        planManager.authorize("session", writeTool, { path: "test.txt" }, undefined, () => {
          // noop
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(planEvents.length, 2);
      assert.equal(planEvents[0]?.type, "request");
      assert.equal(planEvents[0]?.tool, "write");
      assert.equal(planEvents[1]?.type, "deny");
    });

    it("enforces the complete four-mode matrix through one turn context", async () => {
      const makeTool = (kind: "read" | "write" | "bash" | "mcp"): Tool => {
        if (kind === "bash") return { ...writeTool, name: "bash" };
        if (kind === "mcp") {
          return {
            ...writeTool,
            name: "read",
            source: { kind: "mcp", serverId: "matrix", toolName: "read" },
          };
        }
        return { ...writeTool, name: kind };
      };

      const matrix: Array<{ mode: PermissionMode; kind: "read" | "write" | "bash" | "mcp"; args: Record<string, unknown>; outcome: "allow" | "deny" }> = [
        { mode: "plan", kind: "read", args: {}, outcome: "allow" },
        { mode: "plan", kind: "write", args: {}, outcome: "deny" },
        { mode: "plan", kind: "bash", args: { command: "printf ok" }, outcome: "allow" },
        { mode: "plan", kind: "bash", args: { command: "rm -rf /tmp/x" }, outcome: "deny" },
        { mode: "plan", kind: "mcp", args: {}, outcome: "deny" },
        { mode: "manual", kind: "read", args: {}, outcome: "allow" },
        { mode: "manual", kind: "write", args: {}, outcome: "allow" },
        { mode: "manual", kind: "bash", args: { command: "printf ok" }, outcome: "allow" },
        { mode: "manual", kind: "mcp", args: {}, outcome: "allow" },
        { mode: "auto", kind: "read", args: {}, outcome: "allow" },
        { mode: "auto", kind: "write", args: {}, outcome: "allow" },
        { mode: "auto", kind: "bash", args: { command: "printf ok" }, outcome: "allow" },
        { mode: "auto", kind: "mcp", args: {}, outcome: "allow" },
        { mode: "bypass", kind: "read", args: {}, outcome: "allow" },
        { mode: "bypass", kind: "write", args: {}, outcome: "allow" },
        { mode: "bypass", kind: "bash", args: { command: "rm -rf /tmp/x" }, outcome: "allow" },
        { mode: "bypass", kind: "mcp", args: {}, outcome: "allow" },
      ];

      for (const testCase of matrix) {
        const manager = new PermissionManager(testCase.mode);
        const tool = makeTool(testCase.kind);
        let executions = 0;
        const executable = { ...tool, execute: async () => { executions += 1; return { content: "ok" }; } };
        let requestId = "";
        const turn = manager.beginTurn("matrix", (request) => { requestId = request.id; });
        const pending = turn.execute(executable, testCase.args);
        const settled = pending.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        if (requestId) manager.resolve("matrix", requestId, testCase.outcome);

        if (testCase.outcome === "allow") {
          const result = await settled;
          assert.equal(result.ok, true, `${testCase.mode}/${testCase.kind} should be allowed`);
          assert.equal(executions, 1, `${testCase.mode}/${testCase.kind} should execute exactly once`);
        } else {
          const result = await settled;
          assert.equal(result.ok, false, `${testCase.mode}/${testCase.kind} should be denied`);
          assert.equal(executions, 0, `${testCase.mode}/${testCase.kind} must not execute`);
        }
        turn.close();
      }
    });

    it("hard-denies Plan MCP calls without entering approval or executing", async () => {
      const manager = new PermissionManager("plan");
      const mcpTool: Tool = {
        ...writeTool,
        name: "bash",
        source: { kind: "mcp", serverId: "plan-test", toolName: "search" },
      };
      let requestCount = 0;
      let executionCount = 0;
      const turn = manager.beginTurn("plan", () => { requestCount += 1; });
      const pending = turn.execute({ ...mcpTool, execute: async () => { executionCount += 1; return { content: "bad" }; } }, { command: "printf ok" });
      await assert.rejects(pending, /plan mode/);
      assert.equal(requestCount, 0);
      assert.equal(executionCount, 0);
      turn.close();
    });

    it("cancels pending approval atomically and prevents the stale tool from starting", async () => {
      const manager = new PermissionManager("auto");
      let requestId = "";
      let executions = 0;
      const turn = manager.beginTurn("switch", (request) => { requestId = request.id; });
      const pending = turn.execute({ ...writeTool, execute: async () => { executions += 1; return { content: "stale" }; } }, { path: "stale.txt" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(requestId);
      const change = manager.setMode("bypass");
      assert.deepEqual(change, {
        changed: true,
        previousMode: "auto",
        mode: "bypass",
        previousRevision: 0,
        revision: 1,
        interrupted: true,
      });
      await assert.rejects(pending, (error: unknown) => error instanceof PermissionModeChangedError);
      assert.equal(executions, 0);
      turn.close();
    });

    it("cancels an in-flight tool and rejects its late result after a mode switch", async () => {
      const manager = new PermissionManager("auto");
      let toolSignal: AbortSignal | undefined;
      let release: (() => void) | undefined;
      const turn = manager.beginTurn("in-flight", () => {});
      const pending = turn.execute({
        ...writeTool,
        name: "read",
        execute: async (_args, signal) => {
          toolSignal = signal;
          await new Promise<void>((resolve) => { release = resolve; });
          return { content: "late" };
        },
      }, {});
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(toolSignal);
      manager.setMode("manual");
      assert.equal(toolSignal?.aborted, true);
      release?.();
      await assert.rejects(pending, (error: unknown) => error instanceof PermissionModeChangedError);
      turn.close();
    });

    it("does not interrupt an active turn when setting the same mode", async () => {
      const manager = new PermissionManager("auto");
      const turn = manager.beginTurn("same", () => {});
      const change = manager.setMode("auto");
      assert.equal(change.changed, false);
      assert.equal(change.interrupted, false);
      assert.equal(turn.signal.aborted, false);
      turn.close();
    });
  });
});

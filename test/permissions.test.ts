import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionManager } from "../src/permissions.ts";
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

  describe("Permission Modes", () => {
    it("plan mode: blocks write tools, allows read-only bash, and blocks dangerous bash", async () => {
      const manager = new PermissionManager("plan");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };
      const readToolMock = { ...writeTool, name: "read" };

      // Write should request permission
      let writeRequestId = "";
      const writePending = manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, (request) => {
        writeRequestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(writeRequestId);
      manager.resolve("session", writeRequestId, "deny");
      await assert.rejects(writePending, /Permission denied/);

      // Read-only bash should auto-allow in plan mode
      await manager.authorize("session", bashToolMock, { command: "find . -type f | head -50" }, undefined, () => {
        throw new Error("read-only bash should auto-allow in plan mode");
      });

      // Read-only bash should not be blocked by dangerous-looking search terms
      await manager.authorize("session", bashToolMock, { command: "grep rm README.md" }, undefined, () => {
        throw new Error("grep with a dangerous-looking search term should still auto-allow in plan mode");
      });

      // Dangerous bash should still request permission
      let bashRequestId = "";
      const bashPending = manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, (request) => {
        bashRequestId = request.id;
        assert.equal(request.risk, "high");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(bashRequestId);
      manager.resolve("session", bashRequestId, "deny");
      await assert.rejects(bashPending, /Permission denied/);

      // Shell wrappers should still catch dangerous inner commands
      let wrappedRequestId = "";
      const wrappedPending = manager.authorize("session", bashToolMock, { command: "bash -c 'rm -rf /'" }, undefined, (request) => {
        wrappedRequestId = request.id;
        assert.equal(request.risk, "high");
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(wrappedRequestId);
      manager.resolve("session", wrappedRequestId, "deny");
      await assert.rejects(wrappedPending, /Permission denied/);

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

      // In plan mode, should request permission
      let planRequestId = "";
      const planPending = manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, (request) => {
        planRequestId = request.id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(planRequestId);

      // Switch to bypass mode
      manager.setMode("bypass");

      // Now should auto-allow
      await manager.authorize("session", writeToolMock, { path: "test2.txt", content: "world" }, undefined, () => {
        throw new Error("write should auto-allow after switching to bypass mode");
      });
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

      // Test plan mode - should trigger request event
      const planManager = new PermissionManager("plan");
      const planEvents: Array<{ type: string; tool: string; id: string }> = [];
      planManager.onPermissionEvent = (event) => {
        planEvents.push({ type: event.type, tool: event.request.tool, id: event.request.id });
      };
      const pending = planManager.authorize("session", writeTool, { path: "test.txt" }, undefined, (request) => {
        // noop
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(planEvents.length, 1);
      assert.equal(planEvents[0]?.type, "request");
      assert.equal(planEvents[0]?.tool, "write");
      planManager.resolve("session", planEvents[0]!.id, "deny");
      await assert.rejects(pending, /Permission denied/);
    });
  });
});

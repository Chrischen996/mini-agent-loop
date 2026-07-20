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
});

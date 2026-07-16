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
});

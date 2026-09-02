import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { sanitizeResumableMessages, SessionManager } from "../src/session-manager.ts";

describe("SessionManager", () => {
  it("sanitizes interrupted and orphaned tool history before resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-sanitize-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      const messages = [
        { role: "system" as const, content: "system" },
        { role: "user" as const, content: "first" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "call-one", name: "read", arguments: {} },
            { id: "call-two", name: "read", arguments: {} },
          ],
        },
        { role: "tool" as const, toolCallId: "call-one", name: "read", content: "partial" },
        { role: "user" as const, content: "second" },
        { role: "tool" as const, toolCallId: "orphan", name: "read", content: "orphan" },
        { role: "assistant" as const, content: "" },
        { role: "assistant" as const, content: "recovered" },
      ];

      assert.deepEqual(
        sanitizeResumableMessages(messages).map((message) => [message.role, message.content]),
        [
          ["system", "system"],
          ["user", "first"],
          ["user", "second"],
          ["assistant", "recovered"],
        ],
      );
      await manager.save({ id: "sanitize-session", messages });
      const restored = await manager.load("sanitize-session");
      assert.deepEqual(restored?.messages.map((message) => [message.role, message.content]), [
        ["system", "system"],
        ["user", "first"],
        ["user", "second"],
        ["assistant", "recovered"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete assistant tool-call blocks resumable", () => {
    const messages = sanitizeResumableMessages([
      { role: "system", content: "system" },
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-read", name: "read", arguments: {} }],
      },
      { role: "tool", toolCallId: "call-read", name: "read", content: "file contents" },
      { role: "assistant", content: "finished" },
    ]);

    assert.deepEqual(messages.map((message) => message.role), [
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("allocates and switches active session ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-id-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      const first = manager.sessionId;
      const second = manager.newSession();

      assert.match(first, /^[a-z0-9-]+$/i);
      assert.match(second, /^[a-z0-9-]+$/i);
      assert.notEqual(first, second);
      assert.equal(manager.sessionId, second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves createdAt when a later snapshot omits it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-created-"));
    try {
      const manager = new SessionManager({ dataDir: root, workspaceId: "/workspace/app" });
      await manager.save({
        id: "created-at-session",
        createdAt: 123,
        messages: [],
      });
      await manager.save({
        id: "created-at-session",
        messages: [{ role: "user", content: "second turn" }],
      });

      assert.equal((await manager.load("created-at-session"))?.createdAt, 123);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves fork metadata when a later snapshot omits it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-fork-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      await manager.save({
        id: "fork-session",
        parentSessionId: "parent-session",
        forkedFromMessage: 3,
        forkedFromMessageId: "msg-3",
        messages: [],
      });
      await manager.save({ id: "fork-session", messages: [{ role: "user", content: "next" }] });

      const restored = await manager.load("fork-session");
      assert.equal(restored?.parentSessionId, "parent-session");
      assert.equal(restored?.forkedFromMessage, 3);
      assert.equal(restored?.forkedFromMessageId, "msg-3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forks a session into a new record without changing the parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-fork-copy-"));
    try {
      const manager = new SessionManager({ dataDir: root, workspaceId: "/workspace/app" });
      await manager.save({
        id: "fork-parent",
        createdAt: 123,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
        ],
        skillNames: ["parent-skill"],
      });

      const child = await manager.fork("fork-parent", "fork-child");

      assert.equal(child?.id, "fork-child");
      assert.equal(child?.parentSessionId, "fork-parent");
      assert.equal(child?.forkedFromMessage, 2);
      assert.equal(child?.forkedFromMessageId, child?.messages.at(-1)?.id);
      assert.notEqual(child?.createdAt, 123);
      const parent = await manager.load("fork-parent");
      assert.deepEqual(parent?.messages.map(({ role, content }) => ({ role, content })), [
        { role: "system", content: "system" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
      ]);
      assert.equal(parent?.parentSessionId, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not share mutable fork state with the parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-fork-isolation-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      await manager.save({
        id: "isolation-parent",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        todos: [{ id: "todo-1", content: "Keep separate", status: "pending" }],
      });

      const child = await manager.fork("isolation-parent", "isolation-child");
      assert.ok(child);
      child.messages[1] = { role: "user", content: "child-only" };
      child.todos![0]!.content = "changed in child";

      const parent = await manager.load("isolation-parent");
      assert.equal(parent?.messages.length, 1);
      assert.deepEqual(parent?.messages[0]?.content, [{ type: "text", text: "hello" }]);
      assert.equal(parent?.todos?.[0]?.content, "Keep separate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the user prompt before the model turn starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-turn-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      await manager.saveTurnStart({
        id: "turn-start-session",
        messages: [{ role: "system", content: "system" }],
        content: "before provider call",
      });

      const messages = (await manager.load("turn-start-session"))?.messages ?? [];
      assert.deepEqual(messages.map((message) => [message.role, message.content]), [
        ["system", "system"],
        ["user", "before provider call"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the most recently active session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-recent-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      await manager.save({
        id: "older-session",
        lastActiveAt: 100,
        messages: [{ role: "user", content: "older" }],
      });
      await manager.save({
        id: "newer-session",
        lastActiveAt: 200,
        messages: [{ role: "user", content: "newer" }],
      });

      assert.equal((await manager.loadMostRecent())?.id, "newer-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a session and rotates the active id when necessary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-remove-"));
    try {
      const manager = new SessionManager({ dataDir: root });
      const activeId = manager.sessionId;
      await manager.save({ id: activeId, messages: [] });

      await manager.remove(activeId);

      assert.equal(await manager.load(activeId), undefined);
      assert.notEqual(manager.sessionId, activeId);
      assert.deepEqual(await manager.loadAll(), new Map());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues compaction counting after a manager restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-compaction-"));
    try {
      await new SessionManager({ dataDir: root, compactThreshold: 3 }).save({
        id: "restart-compaction-session",
        messages: [{ role: "user", content: "v1" }],
      });
      await new SessionManager({ dataDir: root, compactThreshold: 3 }).save({
        id: "restart-compaction-session",
        messages: [{ role: "user", content: "v2" }],
      });
      await new SessionManager({ dataDir: root, compactThreshold: 3 }).save({
        id: "restart-compaction-session",
        messages: [{ role: "user", content: "v3" }],
      });

      const raw = await readFile(path.join(root, "restart-compaction-session", "events.jsonl"), "utf8");
      assert.equal(raw.trim().split("\n").filter(Boolean).length, 1);
      assert.equal(
        (await new SessionManager({ dataDir: root }).load("restart-compaction-session"))?.messages[0]?.content,
        "v3",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps session listing and loading isolated by workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-workspace-"));
    try {
      const first = new SessionManager({ dataDir: root, workspaceId: "/workspace/one" });
      const second = new SessionManager({ dataDir: root, workspaceId: "/workspace/two" });
      await first.save({ id: "one", messages: [{ role: "user", content: "one" }] });
      await second.save({ id: "two", messages: [{ role: "user", content: "two" }] });

      assert.deepEqual((await first.list()).map((session) => session.id), ["one"]);
      assert.deepEqual((await second.list()).map((session) => session.id), ["two"]);
      assert.equal(await first.load("two"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects writes that try to reuse another workspace's session id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-write-scope-"));
    try {
      const first = new SessionManager({ dataDir: root, workspaceId: "/workspace/one" });
      const second = new SessionManager({ dataDir: root, workspaceId: "/workspace/two" });
      await first.save({ id: "scoped-session", messages: [{ role: "user", content: "keep me" }] });

      await assert.rejects(
        second.save({ id: "scoped-session", messages: [{ role: "user", content: "do not overwrite" }] }),
        /another workspace/,
      );
      assert.equal((await first.load("scoped-session"))?.messages[0]?.content, "keep me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create duplicate session_created records on concurrent first saves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-manager-race-"));
    try {
      const first = new SessionManager({ dataDir: root, workspaceId: "/workspace/race" });
      const second = new SessionManager({ dataDir: root, workspaceId: "/workspace/race" });
      await Promise.all([
        first.save({ id: "race-session", messages: [{ role: "user", content: "first" }] }),
        second.save({ id: "race-session", messages: [{ role: "user", content: "second" }] }),
      ]);

      const raw = await readFile(path.join(root, "race-session", "events.jsonl"), "utf8");
      const events = raw.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      assert.equal(events.filter((event) => event.type === "session_created").length, 1);
      assert.equal(events.filter((event) => event.type === "session_snapshot").length, 2);
      assert.ok(["first", "second"].includes(
        (await new SessionManager({ dataDir: root }).load("race-session"))?.messages[0]?.content as string,
      ));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

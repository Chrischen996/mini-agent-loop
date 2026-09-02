import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { truncateSessionMessages } from "../src/server.ts";
import { SessionStore } from "../src/session-store.ts";
import type { TodoItem } from "../src/tools/todo.ts";
import type { ExecutionPlan } from "../src/plan-act/types.ts";

describe("SessionStore", () => {
  it("truncates an incomplete assistant tool-call block as one unit", () => {
    const messages = truncateSessionMessages([
      { role: "system", content: "system" },
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-one", name: "read", arguments: {} },
          { id: "call-two", name: "read", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "call-one", name: "read", content: "one" },
      { role: "tool", toolCallId: "call-two", name: "read", content: "two" },
      { role: "assistant", content: "complete" },
    ], 3);

    assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  });

  it("evicts sessions that exceed TTL on load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-ttl-"));
    try {
      const store = new SessionStore(root, { sessionTtlMs: 1_000 });
      const old = { id: "old-session", createdAt: Date.now() - 5_000, messages: [{ role: "user" as const, content: "old" }] };
      const recent = { id: "recent-session", createdAt: Date.now(), messages: [{ role: "user" as const, content: "new" }] };
      await store.create(old);
      await store.create(recent);
      await store.compact({
        ...old,
        lastActiveAt: Date.now() - 5_000,
      });

      const loaded = await new SessionStore(root, { sessionTtlMs: 1_000 }).loadAll();
      assert.equal(loaded.has("old-session"), false, "expired session should be evicted");
      assert.equal(loaded.has("recent-session"), true, "recent session should remain");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bypass TTL when loading an explicit session id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-explicit-ttl-"));
    try {
      const store = new SessionStore(root, { sessionTtlMs: 1_000 });
      const stale = {
        id: "expired-explicit",
        createdAt: Date.now() - 2_000,
        messages: [{ role: "user" as const, content: "stale" }],
      };
      await store.create(stale);
      await store.compact({ ...stale, lastActiveAt: Date.now() - 2_000 });

      assert.equal(await store.load("expired-explicit"), undefined);
      await assert.rejects(
        readFile(path.join(root, "expired-explicit", "events.jsonl")),
        /ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evicts oldest sessions when exceeding maxSessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-max-"));
    try {
      const store = new SessionStore(root, { maxSessions: 2 });
      const now = Date.now();
      const s1 = { id: "session-1", createdAt: now - 3000, messages: [{ role: "user" as const, content: "1" }] };
      const s2 = { id: "session-2", createdAt: now - 2000, messages: [{ role: "user" as const, content: "2" }] };
      const s3 = { id: "session-3", createdAt: now - 1000, messages: [{ role: "user" as const, content: "3" }] };
      await store.create(s1);
      await store.create(s2);
      await store.create(s3);

      const loaded = await new SessionStore(root, { maxSessions: 2 }).loadAll();
      assert.equal(loaded.size, 2, "should keep only 2 sessions");
      assert.equal(loaded.has("session-1"), false, "oldest should be evicted");
      assert.equal(loaded.has("session-2"), true);
      assert.equal(loaded.has("session-3"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores messages from JSONL snapshots and skips malformed records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-store-"));
    try {
      const session = {
        id: "session-test",
        createdAt: Date.now(),
        messages: [
          { role: "system" as const, content: "system" },
          { role: "user" as const, content: "hello" },
        ],
      };
      const store = new SessionStore(root);
      await store.create(session);
      await appendFile(path.join(root, session.id, "events.jsonl"), "{broken json}\n", "utf8");

      const restored = await new SessionStore(root).loadAll();
      assert.deepEqual(restored.get(session.id)?.messages, session.messages);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips fork metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-fork-"));
    try {
      const store = new SessionStore(root);
      await store.create({
        id: "child-session",
        createdAt: Date.now(),
        parentSessionId: "parent-session",
        forkedFromMessage: 3,
        forkedFromMessageId: "msg-parent-3",
        messages: [],
      });
      const restored = await store.loadAll();
      assert.equal(restored.get("child-session")?.parentSessionId, "parent-session");
      assert.equal(restored.get("child-session")?.forkedFromMessage, 3);
      assert.equal(restored.get("child-session")?.forkedFromMessageId, "msg-parent-3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips the session thinking mode and current level", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-thinking-"));
    try {
      const store = new SessionStore(root);
      await store.create({
        id: "adaptive-session",
        createdAt: Date.now(),
        thinkingMode: "adaptive",
        thinkingLevel: "high",
        messages: [{ role: "user", content: "continue the task" }],
      });

      const restored = await new SessionStore(root).loadAll();
      assert.equal(restored.get("adaptive-session")?.thinkingMode, "adaptive");
      assert.equal(restored.get("adaptive-session")?.thinkingLevel, "high");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips active skill names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-skills-"));
    try {
      const store = new SessionStore(root);
      await store.create({
        id: "skill-session",
        createdAt: Date.now(),
        skillNames: ["research", "review"],
        messages: [{ role: "user", content: "continue the task" }],
      });

      const restored = await new SessionStore(root).loadAll();
      assert.deepEqual(restored.get("skill-session")?.skillNames, ["research", "review"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips todo snapshots and their version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-todos-"));
    try {
      const todos: TodoItem[] = [
        { id: "todo-1", content: "Persist this todo", status: "in_progress" },
      ];
      const store = new SessionStore(root);
      await store.create({
        id: "todo-session",
        createdAt: Date.now(),
        messages: [],
        todos,
        todoVersion: 4,
      });

      const restored = await store.loadAll();
      assert.deepEqual(restored.get("todo-session")?.todos, todos);
      assert.equal(restored.get("todo-session")?.todoVersion, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults missing todo fields for legacy sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-legacy-"));
    try {
      const sessionId = "legacy-session";
      await mkdir(path.join(root, sessionId), { recursive: true });
      await appendFile(
        path.join(root, sessionId, "events.jsonl"),
        `${JSON.stringify({
          type: "session_created",
          sessionId,
          createdAt: Date.now(),
        })}\n${JSON.stringify({
          type: "session_snapshot",
          sessionId,
          createdAt: Date.now(),
          messages: [],
        })}\n`,
        "utf8",
      );

      const restored = await new SessionStore(root).loadAll();
      assert.deepEqual(restored.get(sessionId)?.todos, []);
      assert.equal(restored.get(sessionId)?.todoVersion, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compacts events.jsonl to a single snapshot after the threshold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-compact-"));
    try {
      const store = new SessionStore(root, { compactThreshold: 3 });
      const session = {
        id: "compact-session",
        createdAt: Date.now(),
        messages: [{ role: "user" as const, content: "v1" }],
      };
      await store.create(session);
      for (const version of ["v2", "v3", "v4", "v5"]) {
        session.messages = [{ role: "user" as const, content: version }];
        await store.save(session);
      }

      const raw = await readFile(path.join(root, session.id, "events.jsonl"), "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      assert.ok(lines.length < 5, `expected compaction, got ${lines.length} lines`);
      // The surviving snapshot must be the latest state.
      const restored = await new SessionStore(root).loadAll();
      assert.equal(restored.get(session.id)?.messages[0]?.role, "user");
      assert.equal(restored.get(session.id)?.messages[0]?.content, "v5");
      assert.match(restored.get(session.id)?.messages[0]?.id ?? "", /^msg_[a-f0-9]{24}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a single session by id via load()", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-load-"));
    try {
      const store = new SessionStore(root);
      const session = {
        id: "single-session",
        createdAt: Date.now(),
        messages: [{ role: "user" as const, content: "hello" }],
      };
      await store.create(session);

      const loaded = await store.load("single-session");
      assert.equal(loaded?.id, "single-session");
      assert.deepEqual(loaded?.messages, session.messages);
      assert.equal(await store.load("missing-session"), undefined);
      // Path traversal attempts are rejected.
      assert.equal(await store.load("../escape"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe session ids before touching the filesystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-id-validation-"));
    try {
      const store = new SessionStore(root);
      const unsafe = { id: "../outside", createdAt: Date.now(), messages: [] };

      await assert.rejects(store.save(unsafe), /Invalid session id/);
      await assert.rejects(store.create(unsafe), /Invalid session id/);
      await assert.rejects(store.remove("../outside"), /Invalid session id/);
      await assert.rejects(store.compact(unsafe), /Invalid session id/);
      assert.equal(await store.load("../outside"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists sessions most-recently-active first with previews", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-list-"));
    try {
      const store = new SessionStore(root);
      const older = { id: "older", createdAt: Date.now() - 10_000, messages: [{ role: "user" as const, content: "first question" }] };
      const newer = { id: "newer", createdAt: Date.now() - 20_000, messages: [{ role: "user" as const, content: "second question" }] };
      await store.create(older);
      // Ensure distinct lastActiveAt ordering despite coarse timestamps.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.create(newer);

      const list = await store.listSessions();
      assert.equal(list.length, 2);
      assert.equal(list[0]!.id, "newer", "most recently active should be first");
      assert.equal(list[0]!.preview, "second question");
      assert.ok(list[0]!.lastActiveAt >= list[1]!.lastActiveAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes system-only sessions without spending a resume-list slot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-list-filter-"));
    try {
      const store = new SessionStore(root, { maxSessions: 1 });
      await store.create({
        id: "system-only",
        createdAt: Date.now(),
        messages: [{ role: "system", content: "system prompt" }],
      });
      await store.create({
        id: "older-user",
        createdAt: Date.now(),
        messages: [{ role: "user", content: "older prompt" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.create({
        id: "newer-user",
        createdAt: Date.now(),
        messages: [{ role: "system", content: "system prompt" }, { role: "user", content: "newer prompt" }],
      });

      assert.deepEqual((await store.listSessions()).map((session) => session.id), ["newer-user"]);
      const loaded = await new SessionStore(root, { maxSessions: 1 }).loadAll();
      assert.equal(loaded.has("newer-user"), true, "a system-only record must not evict a resumable session");
      assert.equal(loaded.has("system-only"), true, "non-expired records remain loadable for compatibility");
      assert.equal((await store.load("system-only"))?.messages.length, 1);
      assert.equal(await store.load("older-user"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans expired system-only sessions while listing resumable sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-list-expired-system-"));
    try {
      const store = new SessionStore(root, { sessionTtlMs: 1_000 });
      const stale = {
        id: "expired-system-only",
        createdAt: Date.now(),
        messages: [{ role: "system" as const, content: "system prompt" }],
      };
      await store.create(stale);
      await store.compact({ ...stale, lastActiveAt: Date.now() - 5_000 });

      assert.deepEqual(await store.listSessions(), []);
      await assert.rejects(
        readFile(path.join(root, stale.id, "events.jsonl")),
        /ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips lastActiveAt and evicts by recency over maxSessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-recency-"));
    try {
      const store = new SessionStore(root);
      const stale = { id: "stale", createdAt: Date.now() - 30_000, messages: [] };
      const freshOld = { id: "fresh-old", createdAt: Date.now() - 20_000, messages: [] };
      await store.create(stale);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.create(freshOld);
      // Refresh the stale session so its lastActiveAt is now the newest even
      // though createdAt is oldest — eviction must keep it.
      await store.save(stale);

      const loaded = await new SessionStore(root, { maxSessions: 1 }).loadAll();
      assert.equal(loaded.size, 1);
      assert.equal(loaded.has("stale"), true, "recently-active session should survive");
      const restored = loaded.get("stale")!;
      assert.ok(restored.lastActiveAt !== undefined, "lastActiveAt should round-trip");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters sessions by workspace scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-workspace-"));
    try {
      const first = new SessionStore(root, { workspaceId: "/workspace/one" });
      const second = new SessionStore(root, { workspaceId: "/workspace/two" });
      await first.create({ id: "one", createdAt: Date.now(), messages: [{ role: "user", content: "one" }] });
      await second.create({ id: "two", createdAt: Date.now(), messages: [{ role: "user", content: "two" }] });

      assert.equal((await first.listSessions()).map((item) => item.id).join(), "one");
      assert.equal((await second.listSessions()).map((item) => item.id).join(), "two");
      assert.equal(await first.load("two"), undefined);
      assert.equal((await new SessionStore(root).listSessions()).length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims legacy unscoped sessions for the first workspace that opens them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-legacy-scope-"));
    try {
      const legacy = new SessionStore(root);
      await legacy.create({
        id: "legacy-scope-session",
        createdAt: Date.now(),
        messages: [{ role: "user", content: "old prompt" }],
      });

      const firstWorkspace = new SessionStore(root, { workspaceId: "/workspace/first" });
      const restored = await firstWorkspace.load("legacy-scope-session");
      assert.equal(restored?.workspaceId, "/workspace/first");
      assert.equal(restored?.messages[0]?.content, "old prompt");

      const secondWorkspace = new SessionStore(root, { workspaceId: "/workspace/second" });
      assert.equal(await secondWorkspace.load("legacy-scope-session"), undefined);
      assert.deepEqual(
        (await firstWorkspace.listSessions()).map((item) => item.id),
        ["legacy-scope-session"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats null currentPlan as an explicit clear", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-plan-clear-"));
    try {
      const store = new SessionStore(root);
      const plan: ExecutionPlan = {
        id: "plan-1",
        sessionId: "plan-session",
        createdAt: Date.now(),
        summary: "do it",
        steps: [],
        risks: [],
        requiredTools: [],
        status: "draft",
      };
      await store.create({ id: "plan-session", createdAt: Date.now(), currentPlan: plan, messages: [] });
      await store.save({ id: "plan-session", createdAt: Date.now(), currentPlan: undefined, messages: [] });

      assert.equal((await store.load("plan-session"))?.currentPlan, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent saves without losing snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-lock-"));
    try {
      const first = new SessionStore(root, { compactThreshold: 100 });
      const second = new SessionStore(root, { compactThreshold: 100 });
      const session = { id: "locked-session", createdAt: Date.now(), messages: [] };
      await first.create(session);
      await Promise.all([
        first.save({ ...session, messages: [{ role: "user", content: "first" }] }),
        second.save({ ...session, messages: [{ role: "user", content: "second" }] }),
      ]);

      const lines = (await readFile(path.join(root, session.id, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean);
      assert.equal(lines.length, 4);
      assert.ok(["first", "second"].includes((await new SessionStore(root).load(session.id))?.messages[0]?.content as string));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps create() from appending a second session_created event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-create-once-"));
    try {
      const store = new SessionStore(root);
      const session = { id: "create-once", createdAt: Date.now(), messages: [] };
      await store.create(session);
      await assert.rejects(store.create(session), /Session already exists/);

      const events = (await readFile(path.join(root, session.id, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      assert.equal(events.filter((event) => event.type === "session_created").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

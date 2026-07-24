import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "../src/session-store.ts";

describe("SessionStore", () => {
  it("evicts sessions that exceed TTL on load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-ttl-"));
    try {
      const store = new SessionStore(root, { sessionTtlMs: 1_000 });
      const old = { id: "old-session", createdAt: Date.now() - 5_000, messages: [{ role: "user" as const, content: "old" }] };
      const recent = { id: "recent-session", createdAt: Date.now(), messages: [{ role: "user" as const, content: "new" }] };
      await store.create(old);
      await store.create(recent);

      const loaded = await new SessionStore(root, { sessionTtlMs: 1_000 }).loadAll();
      assert.equal(loaded.has("old-session"), false, "expired session should be evicted");
      assert.equal(loaded.has("recent-session"), true, "recent session should remain");
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
});

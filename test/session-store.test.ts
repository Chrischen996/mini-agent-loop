import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "../src/session-store.ts";

describe("SessionStore", () => {
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

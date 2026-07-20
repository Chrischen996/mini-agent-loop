import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeepWikiClient } from "../src/codebase/deepwiki-client.ts";
import { DeepWikiProvider } from "../src/codebase/deepwiki-provider.ts";
import { RepositoryStore } from "../src/codebase/repository-store.ts";

const live = process.env.RUN_LIVE_DEEPWIKI_TEST === "1";

describe("DeepWiki live smoke", { skip: !live }, () => {
  it("runs structure, contents, and question for a public repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-deepwiki-live-"));
    const store = new RepositoryStore({ rootDir: root, timeoutMs: 60_000 });
    const client = new DeepWikiClient({ timeoutMs: 30_000, maxResultBytes: 102_400 });
    const provider = new DeepWikiProvider(store, client);
    try {
      const handle = await store.open("octocat/Hello-World");
      const structure = await provider.explain(handle.handle, "structure");
      const contents = await provider.explain(handle.handle, "contents");
      const question = await provider.explain(handle.handle, "question", "What does this repository contain?");
      for (const evidence of [structure, contents, question]) {
        assert.equal(evidence.provider, "deepwiki");
        assert.equal(evidence.generated, true);
        assert.equal(evidence.repository, "octocat/Hello-World");
        assert.equal(evidence.revision, undefined);
        assert.ok(evidence.content.length > 0);
      }
    } finally {
      await Promise.all([provider.close(), store.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

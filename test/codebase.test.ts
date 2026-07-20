import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseRepositoryRef } from "../src/codebase/repository-ref.ts";
import { RepositoryStore } from "../src/codebase/repository-store.ts";

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function createSourceRepository(root: string, content = "export function runAgentLoop() { return true; }\n"): Promise<{ source: string; branch: string }> {
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "loop.ts"), content, "utf8");
  await runGit(source, ["init", "-q"]);
  await runGit(source, ["config", "user.email", "test@example.com"]);
  await runGit(source, ["config", "user.name", "Test"]);
  await runGit(source, ["add", "."]);
  await runGit(source, ["commit", "-qm", "initial"]);
  return { source, branch: (await runGit(source, ["branch", "--show-current"])).trim() };
}

describe("repository refs", () => {
  it("accepts owner/repo and GitHub tree URLs", () => {
    assert.deepEqual(parseRepositoryRef("octo/project"), { repository: "octo/project" });
    assert.deepEqual(parseRepositoryRef("https://github.com/octo/project/tree/main/src"), {
      repository: "octo/project",
      ref: "main/src",
    });
  });

  it("rejects credentials, non-GitHub hosts, and traversal", () => {
    assert.throws(() => parseRepositoryRef("https://user:token@github.com/octo/project"));
    assert.throws(() => parseRepositoryRef("https://gitlab.com/octo/project"));
    assert.throws(() => parseRepositoryRef("octo/project", "../main"));
    assert.throws(() => parseRepositoryRef("octo/project", "--upload-pack=evil"));
    assert.throws(() => parseRepositoryRef("../project"));
  });

  it("uses a local bare clone for offline open, search, and read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-codebase-"));
    const cache = path.join(root, "cache");
    const { source } = await createSourceRepository(root);
    let clones = 0;
    const store = new RepositoryStore({ rootDir: cache, cloneUrl: () => { clones += 1; return source; } });
    try {
      const first = await store.open("octo/project");
      const second = await store.open("octo/project");
      assert.equal(clones, 1);
      assert.equal(first.revision, second.revision);
      const matches = await store.search(first.handle, "runAgentLoop");
      assert.equal(matches[0]?.path, "loop.ts");
      assert.equal(matches[0]?.startLine, 1);
      const file = await store.read(first.handle, "loop.ts", 1, 1);
      assert.match(file.content, /runAgentLoop/);
      assert.equal(file.generated, false);
      assert.deepEqual(await store.search(first.handle, "does-not-exist"), []);
      await assert.rejects(store.read("repo_unknown", "loop.ts"), /Unknown codebase handle/);
      await assert.rejects(store.read(first.handle, "../loop.ts"), /Invalid repository path/);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes different refs for the same repository into one clone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-codebase-concurrent-"));
    const { source, branch } = await createSourceRepository(root);
    let clones = 0;
    const store = new RepositoryStore({ rootDir: path.join(root, "cache"), cloneUrl: () => { clones += 1; return source; } });
    try {
      const [head, named] = await Promise.all([
        store.open("octo/project"),
        store.open("octo/project", branch),
      ]);
      assert.equal(clones, 1);
      assert.equal(head.revision, named.revision);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclones expired caches and removes failed temporary clones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-codebase-expiry-"));
    const { source } = await createSourceRepository(root);
    const cache = path.join(root, "cache");
    let now = 1_000_000;
    let clones = 0;
    let fail = true;
    const cloneUrl = () => { clones += 1; return fail ? path.join(root, "missing") : source; };
    const first = new RepositoryStore({ rootDir: cache, cacheTtlMs: 1000, now: () => now, cloneUrl });
    try {
      await assert.rejects(first.open("octo/project"), /Git operation failed/);
      assert.deepEqual((await readdir(cache)).filter((name) => name.includes(".tmp-")), []);
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(first.open("octo/aborted", undefined, aborted.signal), /Git operation failed/);
      assert.deepEqual((await readdir(cache)).filter((name) => name.includes(".tmp-")), []);
      fail = false;
      await first.open("octo/project");
      await first.close();

      now += 2000;
      const second = new RepositoryStore({ rootDir: cache, cacheTtlMs: 1000, now: () => now, cloneUrl });
      await second.open("octo/project");
      await second.close();
      assert.equal(clones, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects repositories and files above configured limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-codebase-limits-"));
    const { source } = await createSourceRepository(root, "0123456789\n");
    try {
      const tinyCache = new RepositoryStore({ rootDir: path.join(root, "tiny-cache"), maxCacheBytes: 1, cloneUrl: () => source });
      await assert.rejects(tinyCache.open("octo/project"), /cache exceeds 1 byte limit/);
      assert.deepEqual((await readdir(path.join(root, "tiny-cache"))).filter((name) => name.endsWith(".git")), []);

      const store = new RepositoryStore({ rootDir: path.join(root, "normal-cache"), maxFileBytes: 5, cloneUrl: () => source });
      const handle = await store.open("octo/project");
      await assert.rejects(store.read(handle.handle, "loop.ts"), /File exceeds 5 byte limit/);
      await store.close();

      const utf8Root = path.join(root, "utf8-source");
      await mkdir(utf8Root);
      await writeFile(path.join(utf8Root, "text.txt"), "你你\n", "utf8");
      await runGit(utf8Root, ["init", "-q"]);
      await runGit(utf8Root, ["config", "user.email", "test@example.com"]);
      await runGit(utf8Root, ["config", "user.name", "Test"]);
      await runGit(utf8Root, ["add", "."]);
      await runGit(utf8Root, ["commit", "-qm", "utf8"]);
      const utf8Store = new RepositoryStore({ rootDir: path.join(root, "utf8-cache"), maxResultBytes: 2, cloneUrl: () => utf8Root });
      const utf8Handle = await utf8Store.open("octo/utf8");
      const truncated = await utf8Store.read(utf8Handle.handle, "text.txt");
      assert.match(truncated.content, /\[truncated\]/);
      assert.doesNotMatch(truncated.content, /\uFFFD/);
      await utf8Store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

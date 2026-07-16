import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createCopyTool,
  createDeleteTool,
  createListTool,
  createMkdirTool,
  createMoveTool,
  createPatchTool,
  createSearchTool,
} from "../src/tools/workspace-tools.ts";
import { contentAsString } from "../src/content.ts";

async function withWorkspace(run: (workspace: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-workspace-tools-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try {
    await run(workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace tools", () => {
  it("lists entries and searches text with line numbers", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "app.ts"), "const answer = 42;\n", "utf8");
      const listed = await createListTool(workspace).execute({ path: "src" });
      assert.match(contentAsString(listed.content), /file\tapp\.ts/);
      const found = await createSearchTool(workspace).execute({ query: "answer" });
      assert.match(contentAsString(found.content), /src\/app\.ts:1: const answer/);
    });
  });

  it("creates nested directories and patches one exact match", async () => {
    await withWorkspace(async (workspace) => {
      const made = await createMkdirTool(workspace).execute({ path: "a/b/c" });
      assert.equal(made.isError, undefined);
      await writeFile(path.join(workspace, "a", "b", "c", "file.txt"), "one\ntwo\n", "utf8");
      const patched = await createPatchTool(workspace).execute({
        path: "a/b/c/file.txt",
        oldText: "two",
        newText: "three",
      });
      assert.equal(patched.isError, undefined);
      assert.equal(await readFile(path.join(workspace, "a", "b", "c", "file.txt"), "utf8"), "one\nthree\n");
      const ambiguous = await createPatchTool(workspace).execute({
        path: "a/b/c/file.txt",
        oldText: "one",
        newText: "one",
        expectedReplacements: 2,
      });
      assert.equal(ambiguous.isError, true);
    });
  });

  it("copies, moves, and deletes workspace entries", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "source.txt"), "data", "utf8");
      const copied = await createCopyTool(workspace).execute({ source: "source.txt", destination: "copy.txt" });
      assert.equal(copied.isError, undefined);
      const moved = await createMoveTool(workspace).execute({ source: "copy.txt", destination: "nested/moved.txt" });
      assert.equal(moved.isError, undefined);
      assert.equal(await readFile(path.join(workspace, "nested", "moved.txt"), "utf8"), "data");
      const deleted = await createDeleteTool(workspace).execute({ path: "source.txt" });
      assert.equal(deleted.isError, undefined);
      await assert.rejects(() => stat(path.join(workspace, "source.txt")));
    });
  });

  it("rejects protected and symlink-escaped paths", async () => {
    await withWorkspace(async (workspace, root) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(workspace, "link"));
      const made = await createMkdirTool(workspace).execute({ path: "link/new" });
      assert.equal(made.isError, true);
      const deleted = await createDeleteTool(workspace).execute({ path: ".git" });
      assert.equal(deleted.isError, true);
      const searched = await createSearchTool(workspace).execute({ query: "secret", path: "../" });
      assert.equal(searched.isError, true);
    });
  });
});

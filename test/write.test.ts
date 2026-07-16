import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { resolveWorkspaceWritePath } from "../src/workspace.ts";

describe("createWriteTool", () => {
  it("creates a new text file and nested parents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    try {
      const tool = createWriteTool(workspace);
      const result = await tool.execute({
        path: "notes/hello.txt",
        content: "hello world\n",
      });
      assert.notEqual(result.isError, true);
      assert.match(contentAsString(result.content), /Created notes\/hello\.txt/);
      assert.equal(
        await readFile(path.join(workspace, "notes", "hello.txt"), "utf8"),
        "hello world\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites an existing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "old", "utf8");

    try {
      const result = await createWriteTool(workspace).execute({
        path: "a.txt",
        content: "new content",
      });
      assert.notEqual(result.isError, true);
      assert.match(contentAsString(result.content), /Updated a\.txt/);
      assert.equal(await readFile(path.join(workspace, "a.txt"), "utf8"), "new content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path escape outside cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    try {
      const result = await createWriteTool(workspace).execute({
        path: "../escape.txt",
        content: "nope",
      });
      assert.equal(result.isError, true);
      assert.match(contentAsString(result.content), /escapes workspace cwd/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape outside cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, path.join(workspace, "linked.txt"));

    try {
      const result = await createWriteTool(workspace).execute({
        path: "linked.txt",
        content: "pwned",
      });
      assert.equal(result.isError, true);
      assert.match(contentAsString(result.content), /outside workspace cwd/);
      assert.equal(await readFile(outside, "utf8"), "secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects writing under .git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    try {
      const result = await createWriteTool(workspace).execute({
        path: ".git/config",
        content: "bad",
      });
      assert.equal(result.isError, true);
      assert.match(contentAsString(result.content), /protected path/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    try {
      const result = await createWriteTool(workspace).execute({
        path: "big.txt",
        content: "x".repeat(512 * 1024 + 1),
      });
      assert.equal(result.isError, true);
      assert.match(contentAsString(result.content), /content too large/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkspaceWritePath", () => {
  it("allows a new relative file path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-write-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    try {
      const resolved = await resolveWorkspaceWritePath(workspace, "src/app.ts");
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      assert.equal(resolved.exists, false);
      assert.equal(resolved.relative, "src/app.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

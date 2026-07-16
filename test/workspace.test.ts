import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  listWorkspaceDirectory,
  resolveWorkspacePath,
  validateReferencedPaths,
} from "../src/workspace.ts";

async function withWorkspace(
  callback: (workspace: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-workspace-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try {
    await callback(workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace path sandbox", () => {
  it("lists root entries and ignores node_modules/.git", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "package.json"), "{}", "utf8");
      await mkdir(path.join(workspace, "src"));
      await mkdir(path.join(workspace, "node_modules"));
      await mkdir(path.join(workspace, ".git"));
      await writeFile(path.join(workspace, "node_modules", "x.js"), "1", "utf8");
      await writeFile(path.join(workspace, ".DS_Store"), "", "utf8");

      const result = await listWorkspaceDirectory(workspace, "");
      assert.equal(result.path, "");
      assert.deepEqual(
        result.entries.map((entry) => [entry.name, entry.type]),
        [
          ["src", "dir"],
          ["package.json", "file"],
        ],
      );
      assert.equal(result.truncated, false);
    });
  });

  it("lists a subdirectory with relative paths", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "loop.ts"), "export {}", "utf8");
      const result = await listWorkspaceDirectory(workspace, "src");
      assert.equal(result.path, "src");
      assert.deepEqual(result.entries, [
        { name: "loop.ts", path: "src/loop.ts", type: "file" },
      ]);
    });
  });

  it("rejects path escape and missing paths", async () => {
    await withWorkspace(async (workspace) => {
      await assert.rejects(
        () => listWorkspaceDirectory(workspace, "../outside"),
        /escapes workspace/,
      );
      await assert.rejects(
        () => listWorkspaceDirectory(workspace, "missing-dir"),
        /not found/i,
      );
    });
  });

  it("rejects symlink escape from listing", async () => {
    await withWorkspace(async (workspace, root) => {
      const outside = path.join(root, "secret.txt");
      await writeFile(outside, "nope", "utf8");
      await symlink(outside, path.join(workspace, "leak.txt"));
      const result = await listWorkspaceDirectory(workspace, "");
      assert.equal(
        result.entries.find((entry) => entry.name === "leak.txt"),
        undefined,
      );
    });
  });

  it("validates referenced files and rejects directories/escapes", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "a.ts"), "1", "utf8");
      const paths = await validateReferencedPaths(workspace, ["src/a.ts", "src/a.ts"]);
      assert.deepEqual(paths, ["src/a.ts"]);

      await assert.rejects(
        () => validateReferencedPaths(workspace, ["src"]),
        /not a file/,
      );
      await assert.rejects(
        () => validateReferencedPaths(workspace, ["../x"]),
        /escapes workspace|not found|outside/i,
      );
    });
  });

  it("resolveWorkspacePath normalizes relative posix paths", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "a.ts"), "1", "utf8");
      const resolved = await resolveWorkspacePath(workspace, "src/a.ts");
      assert.equal(resolved.ok, true);
      if (resolved.ok) assert.equal(resolved.relative, "src/a.ts");
    });
  });
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveSessionWorkspaceCwd } from "../src/tui/session-workspace.ts";

// macOS resolves /var to /private/var, and the helper returns realpaths, so
// compare against the realpath of the temp root.
async function makeTempProject(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "mini-agent-workspace-")));
}

describe("resolveSessionWorkspaceCwd", () => {
  it("returns the project root when no candidate is recorded", async () => {
    const root = await makeTempProject();
    try {
      assert.equal(await resolveSessionWorkspaceCwd(root), root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a directory nested inside the project", async () => {
    const root = await makeTempProject();
    try {
      const nested = path.join(root, "packages", "app");
      await mkdir(nested, { recursive: true });
      assert.equal(await resolveSessionWorkspaceCwd(root, nested), await realpath(nested));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the root for paths outside the project", async () => {
    const root = await makeTempProject();
    const outside = await makeTempProject();
    try {
      assert.equal(await resolveSessionWorkspaceCwd(root, outside), root);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("falls back to the root for missing paths and plain files", async () => {
    const root = await makeTempProject();
    try {
      assert.equal(await resolveSessionWorkspaceCwd(root, path.join(root, "missing")), root);
      const file = path.join(root, "file.txt");
      await writeFile(file, "x");
      assert.equal(await resolveSessionWorkspaceCwd(root, file), root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a symlink escape the project", async () => {
    const root = await makeTempProject();
    const outside = await makeTempProject();
    try {
      const link = path.join(root, "escape");
      await symlink(outside, link, "dir");
      assert.equal(await resolveSessionWorkspaceCwd(root, link), root);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

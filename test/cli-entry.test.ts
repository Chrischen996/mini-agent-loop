import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isCliEntryPoint } from "../src/cli.ts";

describe("isCliEntryPoint", () => {
  let root = "";

  async function setup(): Promise<{ selfUrl: string; realPath: string; linkPath: string }> {
    root = await mkdtemp(path.join(tmpdir(), "cli-entry-"));
    const realPath = path.join(root, "cli.js");
    await writeFile(realPath, "// entry\n");
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const linkPath = path.join(binDir, "cli-bin.js");
    await symlink(realPath, linkPath);
    const selfUrl = `file://${realPath}`;
    return { selfUrl, realPath, linkPath };
  }

  it("accepts the real path as the entry point", async () => {
    const { selfUrl, realPath } = await setup();
    try {
      assert.equal(isCliEntryPoint(path.resolve(realPath), selfUrl), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the npm bin symlink as the entry point (global install)", async () => {
    const { selfUrl, linkPath } = await setup();
    try {
      // argv[1] is the symlink the user ran; the file must still count as
      // the entry point.
      assert.equal(isCliEntryPoint(linkPath, selfUrl), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated files and missing argv[1]", async () => {
    const { selfUrl, realPath } = await setup();
    try {
      const other = path.join(root, "other.js");
      await writeFile(other, "// not the entry\n");
      assert.equal(isCliEntryPoint(other, selfUrl), false);
      assert.equal(isCliEntryPoint(undefined, selfUrl), false);
      assert.equal(isCliEntryPoint("", selfUrl), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    void realPath;
  });

  it("does not throw when argv[1] cannot be resolved", async () => {
    const { selfUrl } = await setup();
    try {
      // A path that does not exist falls back to the resolved (non-real)
      // comparison instead of throwing.
      const result = isCliEntryPoint(path.join(root, "does-not-exist.js"), selfUrl);
      assert.equal(result, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

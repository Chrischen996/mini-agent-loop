import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { createReadTool } from "../src/tools/read.ts";

async function withWorkspace(
  callback: (workspace: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-read-bounds-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try {
    await callback(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("read text bounds", () => {
  it("applies 1-based offset and limit windows", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        path.join(workspace, "notes.txt"),
        "one\ntwo\nthree\nfour\n",
        "utf8",
      );

      const result = await createReadTool(workspace).execute({
        path: "notes.txt",
        offset: 2,
        limit: 2,
      });
      assert.equal(result.isError, undefined);
      assert.equal(contentAsString(result.content), "two\nthree");
    });
  });

  it("reports an offset beyond the end of the file", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "notes.txt"), "one\ntwo", "utf8");
      const result = await createReadTool(workspace).execute({
        path: "notes.txt",
        offset: 3,
      });
      assert.equal(result.isError, undefined);
      assert.match(contentAsString(result.content), /offset 3 is beyond end/);
    });
  });

  it("limits large line windows and reports the truncation", async () => {
    await withWorkspace(async (workspace) => {
      const text = Array.from({ length: 2_005 }, (_, index) => `line-${index + 1}`).join("\n");
      await writeFile(path.join(workspace, "large.txt"), text, "utf8");
      const result = await createReadTool(workspace).execute({ path: "large.txt" });
      const output = contentAsString(result.content);
      assert.match(output, /truncated to 2000 lines/);
      assert.match(output, /line-2000/);
      assert.doesNotMatch(output, /line-2001/);
    });
  });

  it("truncates UTF-8 on a character boundary without replacement chars", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "utf8.txt"), "你".repeat(40_000), "utf8");
      const result = await createReadTool(workspace).execute({ path: "utf8.txt" });
      const output = contentAsString(result.content);
      assert.match(output, /truncated to 102400 bytes/);
      assert.doesNotMatch(output, /\uFFFD/);
    });
  });
});

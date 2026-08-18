import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatPlanDiff,
  formatPlanDocumentPreview,
} from "../src/plan/format.ts";
import { createPlanDocument } from "../src/plan/document.ts";

describe("formatPlanDiff", () => {
  it("detects added and removed steps", () => {
    const before = "1. Read file.ts\n2. Edit file.ts\n3. Run tests";
    const after = "1. Read file.ts\n2. Write new.ts\n3. Run tests";
    const diff = formatPlanDiff(before, after, "task");

    assert.match(diff, /Removed steps/);
    assert.match(diff, /Edit file\.ts/);
    assert.match(diff, /Added steps/);
    assert.match(diff, /Write new\.ts/);
  });

  it("detects file set changes", () => {
    const before = "1. Read a.ts\n2. Edit a.ts";
    const after = "1. Read b.ts\n2. Edit b.ts";
    const diff = formatPlanDiff(before, after, "files");
    assert.match(diff, /File set changes/);
    assert.match(diff, /- a\.ts/);
    assert.match(diff, /\+ b\.ts/);
  });

  it("reports no changes when steps are identical", () => {
    const md = "1. Do the thing\n2. Finish";
    const diff = formatPlanDiff(md, md, "same");
    assert.match(diff, /no step or file changes/);
  });
});

describe("formatPlanDocumentPreview", () => {
  it("includes id, status, and step preview", () => {
    const doc = createPlanDocument({
      prompt: "build feature",
      rawMarkdown: "1. Read src/cli.ts\n2. Edit src/cli.ts",
      cwd: "/tmp",
      status: "approved",
      approvedBy: "user",
    });
    const preview = formatPlanDocumentPreview(doc);
    assert.match(preview, new RegExp(doc.id));
    assert.match(preview, /status:\s+approved/);
    assert.match(preview, /approvedBy:\s+user/);
    assert.match(preview, /Read src\/cli\.ts/);
  });
});

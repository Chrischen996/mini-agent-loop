import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DocumentStore } from "../src/documents.ts";

describe("document output", () => {
  it("exports an edited PDF artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-doc-store-"));
    const store = new DocumentStore(root);
    const sessionId = "test-pdf-session";
    await store.createSession(sessionId);
    try {
      const source = await readFile(path.resolve("node_modules/pdf-parse/test/data/01-valid.pdf"));
      const attachment = await store.addUpload(sessionId, "source.pdf", source, "application/pdf");
      const artifact = await store.edit(sessionId, {
        attachmentId: attachment.id,
        replacements: [{ oldText: attachment.text.split(/\s+/)[0]!, newText: "Edited" }],
        outputFormat: "pdf",
      });
      assert.equal(artifact.mimeType, "application/pdf");
      assert.ok(artifact.size > 0);
      const output = store.getOutput(sessionId, artifact.id);
      assert.equal((await readFile(output.path)).subarray(0, 5).toString("ascii"), "%PDF-");
      const duplicate = await store.edit(sessionId, {
        attachmentId: attachment.id,
        replacements: [{ oldText: attachment.text.split(/\s+/)[0]!, newText: "Edited" }],
        outputFormat: "pdf",
      });
      assert.equal(duplicate.id, artifact.id);
      assert.equal(duplicate.reused, true);

      const restored = new DocumentStore(root);
      await restored.restoreSession(sessionId);
      assert.equal(restored.getAttachment(sessionId, attachment.id).text, attachment.text);
      assert.equal(restored.getOutput(sessionId, artifact.id).artifact.name, artifact.name);
    } finally {
      await store.removeSession(sessionId);
      await rm(root, { recursive: true, force: true });
    }
  });
});

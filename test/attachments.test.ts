import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createPdfFixture } from "./pdf-fixture.ts";
import { documentTextPart, parseDocumentUpload } from "../src/attachments.ts";

const moduleRoot = path.resolve("node_modules");

describe("document attachments", () => {
  it("extracts text from a PDF", async () => {
    const parsed = await parseDocumentUpload("sample.pdf", await createPdfFixture(), "application/pdf");
    assert.equal(parsed.mimeType, "application/pdf");
    assert.ok(parsed.text.length > 0);
    assert.match(documentTextPart(parsed), /Attached document: sample\.pdf/);
  });

  it("extracts text from a DOCX", async () => {
    const file = path.join(moduleRoot, "mammoth/test/test-data/single-paragraph.docx");
    const parsed = await parseDocumentUpload(
      "sample.docx",
      await readFile(file),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(parsed.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.ok(parsed.text.length > 0);
  });

  it("rejects unsupported or invalid documents", async () => {
    await assert.rejects(
      () => parseDocumentUpload("notes.txt", Buffer.from("hello"), "text/plain"),
      /Unsupported document type/,
    );
    await assert.rejects(
      () => parseDocumentUpload("fake.pdf", Buffer.from("not pdf"), "application/pdf"),
      /not a valid PDF/,
    );
  });
});

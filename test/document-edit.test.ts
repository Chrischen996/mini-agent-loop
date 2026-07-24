import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentEditTool } from "../src/tools/document-edit.ts";
import { contentAsString } from "../src/content.ts";
import type { DocumentEditArgs, DocumentStore } from "../src/documents.ts";
import type { FileArtifact } from "../src/tools/types.ts";

function createMockStore(options?: {
  editResult?: FileArtifact;
  editError?: Error;
}): DocumentStore {
  return {
    edit: async (_sessionId: string, _args: DocumentEditArgs) => {
      if (options?.editError) throw options.editError;
      return (
        options?.editResult ?? {
          id: "file-default",
          name: "output.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 1234,
          reused: false,
        }
      );
    },
  } as unknown as DocumentStore;
}

describe("createDocumentEditTool", () => {
  it("has the expected tool metadata", () => {
    const tool = createDocumentEditTool(createMockStore(), "session-1");
    assert.equal(tool.name, "document_edit");
    assert.ok(tool.description.includes("PDF"));
    assert.ok(tool.description.includes("DOCX"));
    const required = tool.parameters.required as string[];
    assert.ok(required.includes("attachmentId"));
    assert.ok(required.includes("replacements"));
  });

  it("returns isError when attachmentId is missing", async () => {
    const tool = createDocumentEditTool(createMockStore(), "s1");
    const result = await tool.execute({
      attachmentId: "",
      replacements: [{ oldText: "a", newText: "b" }],
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /attachmentId/);
  });

  it("returns isError when replacements is empty", async () => {
    const tool = createDocumentEditTool(createMockStore(), "s1");
    const result = await tool.execute({
      attachmentId: "att-1",
      replacements: [],
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /non-empty/);
  });

  it("returns success with file name on successful edit", async () => {
    const store = createMockStore({
      editResult: {
        id: "file-1",
        name: "edited.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 5678,
        reused: false,
      },
    });
    const tool = createDocumentEditTool(store, "s1");
    const result = await tool.execute({
      attachmentId: "att-1",
      replacements: [{ oldText: "hello", newText: "world" }],
    });
    assert.notEqual(result.isError, true);
    assert.match(contentAsString(result.content), /Created downloadable file edited\.docx/);
    assert.ok(result.files?.length === 1);
    assert.equal(result.files![0]!.name, "edited.docx");
  });

  it("returns 'Reusing' message when file is reused", async () => {
    const store = createMockStore({
      editResult: {
        id: "file-2",
        name: "cached.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 5678,
        reused: true,
      },
    });
    const tool = createDocumentEditTool(store, "s1");
    const result = await tool.execute({
      attachmentId: "att-1",
      replacements: [{ oldText: "a", newText: "b" }],
    });
    assert.notEqual(result.isError, true);
    assert.match(contentAsString(result.content), /Reusing existing downloadable file cached\.docx/);
  });

  it("returns isError when store.edit throws", async () => {
    const store = createMockStore({
      editError: new Error("Attachment not found: att-999"),
    });
    const tool = createDocumentEditTool(store, "s1");
    const result = await tool.execute({
      attachmentId: "att-999",
      replacements: [{ oldText: "a", newText: "b" }],
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /Attachment not found/);
  });

  it("passes operationScope to the store", async () => {
    let capturedScope: string | undefined;
    const store = {
      edit: async (_sid: string, _args: DocumentEditArgs, scope?: string) => {
        capturedScope = scope;
        return { id: "file-scope", name: "out.docx", mimeType: "x", size: 0, reused: false };
      },
    } as unknown as DocumentStore;

    const tool = createDocumentEditTool(store, "s1", "test-scope");
    await tool.execute({
      attachmentId: "att-1",
      replacements: [{ oldText: "x", newText: "y" }],
    });
    assert.equal(capturedScope, "test-scope");
  });
});

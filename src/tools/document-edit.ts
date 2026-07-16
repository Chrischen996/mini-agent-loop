import type { DocumentEditArgs, DocumentStore } from "../documents.ts";
import type { Tool, ToolResult } from "./types.ts";

export function createDocumentEditTool(store: DocumentStore, sessionId: string, operationScope?: string): Tool<DocumentEditArgs> {
  return {
    name: "document_edit",
    description: "Edit an uploaded PDF or DOCX by exact text replacement and prepare a downloadable DOCX or PDF file.",
    parameters: {
      type: "object",
      properties: {
        attachmentId: { type: "string", description: "The attachment id shown in the document context" },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
        outputFormat: { type: "string", enum: ["docx", "pdf"], description: "Output format, default docx" },
        fileName: { type: "string", description: "Optional output file name" },
      },
      required: ["attachmentId", "replacements"],
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      if (!args.attachmentId || !Array.isArray(args.replacements) || args.replacements.length === 0) {
        return { content: "attachmentId and a non-empty replacements array are required", isError: true };
      }
      try {
        const file = await store.edit(sessionId, args, operationScope);
        if (file.reused) {
          return { content: `Reusing existing downloadable file ${file.name}` };
        }
        return { content: `Created downloadable file ${file.name}`, files: [file] };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}

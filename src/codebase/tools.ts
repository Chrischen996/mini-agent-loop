import type { RepositoryStore } from "./repository-store.ts";
import type { CodebaseExplainOperation, CodebaseSemanticProvider } from "./deepwiki-provider.ts";
import type { Tool, ToolResult } from "../tools/types.ts";

const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value, null, 2) });

export function createCodebaseTools(
  store: RepositoryStore,
  options: { semanticProvider?: CodebaseSemanticProvider } = {},
): Tool[] {
  return [
    { name: "codebase_open", description: "Open a public GitHub repository as a read-only source evidence handle.", parameters: { type: "object", properties: { repository: { type: "string" }, ref: { type: "string" } }, required: ["repository"], additionalProperties: false }, execute: async (args, signal) => json(await store.open(String(args.repository), args.ref === undefined ? undefined : String(args.ref), signal)) },
    { name: "codebase_search", description: "Search source text in an opened external repository. Results include commit, file and line evidence.", parameters: { type: "object", properties: { handle: { type: "string" }, pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }, required: ["handle", "pattern"], additionalProperties: false }, execute: async (args, signal) => { if (signal?.aborted) throw new Error("Operation aborted"); return json(await store.search(String(args.handle), String(args.pattern), args.path === undefined ? undefined : String(args.path), Number(args.limit ?? 50), signal)); } },
    { name: "codebase_read", description: "Read numbered source lines from an opened external repository.", parameters: { type: "object", properties: { handle: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["handle", "path"], additionalProperties: false }, execute: async (args, signal) => json(await store.read(String(args.handle), String(args.path), Number(args.offset ?? 1), Number(args.limit ?? 200), signal)) },
    {
      name: "codebase_explain",
      description: "Explain an opened external repository with optional DeepWiki semantic documentation.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string" },
          operation: { type: "string", enum: ["structure", "contents", "question"] },
          question: { type: "string" },
        },
        required: ["handle", "operation"],
        additionalProperties: false,
      },
      execute: async (args, signal) => {
        if (!options.semanticProvider) {
          return { content: "DeepWiki is disabled. Set DEEPWIKI_ENABLED=1 to enable semantic repository analysis.", isError: true };
        }
        const operation = String(args.operation) as CodebaseExplainOperation;
        try {
          return json(await options.semanticProvider.explain(
            String(args.handle),
            operation,
            args.question === undefined ? undefined : String(args.question),
            signal,
          ));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: `DeepWiki unavailable: ${message.slice(0, 500)}`, isError: true };
        }
      },
    },
  ];
}

import type { RepositoryStore } from "./repository-store.ts";
import type { Tool, ToolResult } from "../tools/types.ts";

const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value, null, 2) });

export function createCodebaseTools(store: RepositoryStore): Tool[] {
  return [
    { name: "codebase_open", description: "Open a public GitHub repository as a read-only source evidence handle.", parameters: { type: "object", properties: { repository: { type: "string" }, ref: { type: "string" } }, required: ["repository"], additionalProperties: false }, execute: async (args, signal) => json(await store.open(String(args.repository), args.ref === undefined ? undefined : String(args.ref), signal)) },
    { name: "codebase_search", description: "Search source text in an opened external repository. Results include commit, file and line evidence.", parameters: { type: "object", properties: { handle: { type: "string" }, pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }, required: ["handle", "pattern"], additionalProperties: false }, execute: async (args, signal) => { if (signal?.aborted) throw new Error("Operation aborted"); return json(await store.search(String(args.handle), String(args.pattern), args.path === undefined ? undefined : String(args.path), Number(args.limit ?? 50), signal)); } },
    { name: "codebase_read", description: "Read numbered source lines from an opened external repository.", parameters: { type: "object", properties: { handle: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["handle", "path"], additionalProperties: false }, execute: async (args, signal) => json(await store.read(String(args.handle), String(args.path), Number(args.offset ?? 1), Number(args.limit ?? 200), signal)) },
    { name: "codebase_explain", description: "Explain an external repository using semantic documentation when a DeepWiki provider is configured.", parameters: { type: "object", properties: { handle: { type: "string" }, operation: { type: "string", enum: ["structure", "contents", "question"] }, question: { type: "string" }, path: { type: "string" } }, required: ["handle", "operation"], additionalProperties: false }, execute: async () => ({ content: "DeepWiki semantic provider is not enabled yet.", isError: true }) },
  ];
}

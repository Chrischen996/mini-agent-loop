import { createBashTool } from "./bash.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import {
  createCopyTool,
  createDeleteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createLsTool,
  createMkdirTool,
  createMoveTool,
  createPatchTool,
  createSearchTool,
} from "./workspace-tools.ts";
import type { Tool } from "./types.ts";
import { createRepositoryStoreFromEnv, RepositoryStore } from "../codebase/repository-store.ts";
import { createCodebaseTools } from "../codebase/tools.ts";

export type { JsonSchema, Tool, ToolResult } from "./types.ts";
export type { ReadArgs } from "./read.ts";
export type { WriteArgs } from "./write.ts";
export type { BashArgs } from "./bash.ts";
export { createBashTool } from "./bash.ts";
export { createReadTool } from "./read.ts";
export { createWriteTool } from "./write.ts";
export { createDocumentEditTool } from "./document-edit.ts";
export {
  createCopyTool,
  createDeleteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createLsTool,
  createMkdirTool,
  createMoveTool,
  createPatchTool,
  createSearchTool,
} from "./workspace-tools.ts";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls" | "codebase_open" | "codebase_search" | "codebase_read" | "codebase_explain";

export type ToolSelection = {
  tools?: ToolName[];
  excludeTools?: ToolName[];
};

/** Pi-compatible default: only the four primary tools are active. */
export function createDefaultTools(cwd: string, selection: ToolSelection = {}): Tool[] {
  const all = createAllTools(cwd);
  const selected = selection.tools ?? ["read", "bash", "edit", "write"];
  const excluded = new Set(selection.excludeTools ?? []);
  return all.filter((tool) => selected.includes(tool.name as ToolName) && !excluded.has(tool.name as ToolName));
}

/** All seven Pi coding-agent tools, before active-tool filtering. */
export function createAllTools(cwd: string): Tool[] {
  // Concrete tool arg types are assignable at runtime; widen for the registry list.
  return [
    createReadTool(cwd) as Tool,
    createBashTool(cwd) as Tool,
    createEditTool(cwd) as Tool,
    createWriteTool(cwd) as Tool,
    createGrepTool(cwd) as Tool,
    createFindTool(cwd) as Tool,
    createLsTool(cwd) as Tool,
  ];
}

export function createTools(cwd: string, options: ToolSelection & { codebase?: boolean; codebaseStore?: RepositoryStore } = {}): Tool[] {
  const tools = createDefaultTools(cwd, options);
  const explicitSelection = options.tools;
  const codebaseNames = new Set(["codebase_open", "codebase_search", "codebase_read", "codebase_explain"]);
  const selectedCodebase = explicitSelection ? explicitSelection.filter((name) => codebaseNames.has(name)) : [...codebaseNames];
  if (options.codebase !== false) {
    tools.push(...createCodebaseTools(options.codebaseStore ?? createRepositoryStoreFromEnv()).filter((tool) => selectedCodebase.includes(tool.name as ToolName) && !options.excludeTools?.includes(tool.name as ToolName)));
  }
  return tools;
}

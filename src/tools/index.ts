import { createReadTool } from "./read.ts";
import type { Tool } from "./types.ts";

export type { JsonSchema, Tool, ToolResult } from "./types.ts";
export type { ReadArgs } from "./read.ts";
export { createReadTool } from "./read.ts";

export function createDefaultTools(cwd: string): Tool[] {
  // Tool<ReadArgs> is assignable at runtime; widen for the registry list.
  return [createReadTool(cwd) as Tool];
}

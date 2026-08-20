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
import type { CodebaseSemanticProvider } from "../codebase/deepwiki-provider.ts";
import { createWebAccessTools } from "../web-access/index.ts";
import { createGitTools } from "./git.ts";
import { createValidationTool } from "./validation.ts";
import { createSandboxRunner, type SandboxConfig } from "../sandbox/index.ts";

export type { JsonSchema, Tool, ToolResult } from "./types.ts";
export type { ReadArgs } from "./read.ts";
export type { WriteArgs } from "./write.ts";
export type { BashArgs } from "./bash.ts";
export { createBashTool } from "./bash.ts";
export { createReadTool } from "./read.ts";
export { createWriteTool } from "./write.ts";
export { createDocumentEditTool } from "./document-edit.ts";
export { createWebAccessTools } from "../web-access/index.ts";
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

export type ToolName =
  | "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls"
  | "codebase_open" | "codebase_search" | "codebase_read" | "codebase_explain"
  | "web_search" | "fetch_content" | "get_search_content" | "source_check"
  | "subagent" | "git_status" | "git_diff" | "git_checkpoint" | "git_undo" | "git_branch_isolate"
  | "validate_workspace";

const WEB_ACCESS_TOOL_NAMES = new Set<ToolName>([
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
]);

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
    ...createGitTools(cwd),
    createValidationTool(cwd),
  ];
}

export function createTools(cwd: string, options: ToolSelection & {
  codebase?: boolean;
  codebaseStore?: RepositoryStore;
  codebaseProvider?: CodebaseSemanticProvider;
  webAccess?: boolean;
  sandbox?: SandboxConfig;
} = {}): Tool[] {
  const tools = createDefaultTools(cwd, options);
  const selectedGit = options.tools
    ? options.tools.filter((name) => name.startsWith("git_") || name === "validate_workspace")
    : ["git_status", "git_diff", "git_checkpoint", "git_undo", "git_branch_isolate", "validate_workspace"] as ToolName[];
  const existingNames = new Set(tools.map((tool) => tool.name));
  tools.push(...[...createGitTools(cwd), createValidationTool(cwd)].filter((tool) =>
    !existingNames.has(tool.name)
      && selectedGit.includes(tool.name as ToolName)
      && !options.excludeTools?.includes(tool.name as ToolName)));
  const explicitSelection = options.tools;
  const codebaseNames = new Set(["codebase_open", "codebase_search", "codebase_read", "codebase_explain"]);
  const selectedCodebase = explicitSelection ? explicitSelection.filter((name) => codebaseNames.has(name)) : [...codebaseNames];
  if (options.codebase !== false) {
    tools.push(...createCodebaseTools(
      options.codebaseStore ?? createRepositoryStoreFromEnv(),
      { semanticProvider: options.codebaseProvider },
    ).filter((tool) => selectedCodebase.includes(tool.name as ToolName) && !options.excludeTools?.includes(tool.name as ToolName)));
  }
  if (options.webAccess !== false) {
    const selectedWeb = explicitSelection
      ? explicitSelection.filter((name) => WEB_ACCESS_TOOL_NAMES.has(name))
      : [...WEB_ACCESS_TOOL_NAMES];
    tools.push(...createWebAccessTools(cwd).filter((tool) =>
      selectedWeb.includes(tool.name as ToolName) && !options.excludeTools?.includes(tool.name as ToolName)));
  }
  return tools;
}

/** Async variant that initializes a sandbox runner before building tools. */
export async function createToolsWithSandbox(
  cwd: string,
  options: ToolSelection & {
    codebase?: boolean;
    codebaseStore?: RepositoryStore;
    codebaseProvider?: CodebaseSemanticProvider;
    webAccess?: boolean;
    sandbox?: SandboxConfig;
  } = {},
): Promise<{ tools: Tool[]; cleanup: () => Promise<void> }> {
  let sandboxRunner: Awaited<ReturnType<typeof createSandboxRunner>> | undefined;
  if (options.sandbox) {
    sandboxRunner = await createSandboxRunner(options.sandbox);
  }
  const sandbox = sandboxRunner
    ? { runner: sandboxRunner, config: options.sandbox ?? { enabled: true, type: "none" } }
    : undefined;

  const tools = createAllTools(cwd);
  // Replace the bash tool with the sandbox-aware version
  const bashTool = createBashTool(cwd, sandbox);
  const filtered = tools.filter((t) => t.name !== "bash");
  filtered.unshift(bashTool as Tool);

  const selectedGit = options.tools
    ? options.tools.filter((name) => name.startsWith("git_") || name === "validate_workspace")
    : ["git_status", "git_diff", "git_checkpoint", "git_undo", "git_branch_isolate", "validate_workspace"] as ToolName[];
  const existingNames = new Set(filtered.map((tool) => tool.name));
  filtered.push(...[...createGitTools(cwd), createValidationTool(cwd)].filter((tool) =>
    !existingNames.has(tool.name)
      && selectedGit.includes(tool.name as ToolName)
      && !options.excludeTools?.includes(tool.name as ToolName)));
  const explicitSelection = options.tools;
  const codebaseNames = new Set(["codebase_open", "codebase_search", "codebase_read", "codebase_explain"]);
  const selectedCodebase = explicitSelection ? explicitSelection.filter((name) => codebaseNames.has(name)) : [...codebaseNames];
  if (options.codebase !== false) {
    filtered.push(...createCodebaseTools(
      options.codebaseStore ?? createRepositoryStoreFromEnv(),
      { semanticProvider: options.codebaseProvider },
    ).filter((tool) => selectedCodebase.includes(tool.name as ToolName) && !options.excludeTools?.includes(tool.name as ToolName)));
  }
  if (options.webAccess !== false) {
    const selectedWeb = explicitSelection
      ? explicitSelection.filter((name) => WEB_ACCESS_TOOL_NAMES.has(name))
      : [...WEB_ACCESS_TOOL_NAMES];
    filtered.push(...createWebAccessTools(cwd).filter((tool) =>
      selectedWeb.includes(tool.name as ToolName) && !options.excludeTools?.includes(tool.name as ToolName)));
  }

  const cleanup = async () => {
    if (sandboxRunner) await sandboxRunner.cleanup();
  };
  return { tools: filtered, cleanup };
}

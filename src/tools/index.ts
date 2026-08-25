import { createBashTool } from "./bash.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool, createFindTool, createGrepTool, createLsTool } from "./workspace-tools.ts";
import type { Tool } from "./types.ts";
import { createRepositoryStoreFromEnv, RepositoryStore } from "../codebase/repository-store.ts";
import { createCodebaseTools } from "../codebase/tools.ts";
import type { CodebaseSemanticProvider } from "../codebase/deepwiki-provider.ts";
import { createWebAccessTools } from "../web-access/index.ts";
import { createGitTools } from "./git.ts";
import { createValidationTool } from "./validation.ts";
import { createTodoWriteTool } from "./todo-write.ts";
import { createSandboxRunner, DEFAULT_SANDBOX_CONFIG, type SandboxConfig, type SandboxRunner } from "../sandbox/index.ts";

export type { JsonSchema, Tool, ToolCapabilities, ToolResult } from "./types.ts";
export type { ReadArgs } from "./read.ts";
export type { WriteArgs } from "./write.ts";
export type { SandboxConfig } from "../sandbox/index.ts";
export type { BashArgs } from "./bash.ts";
export type { TodoWriteArgs } from "./todo-write.ts";
export { createTodoWriteTool } from "./todo-write.ts";
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
  | "validate_workspace" | "TodoWrite";

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

const DEFAULT_TOOL_NAMES: ToolName[] = ["read", "bash", "edit", "write", "TodoWrite"];

function selectTools(all: Tool[], selection: ToolSelection): Tool[] {
  const selected = selection.tools ?? DEFAULT_TOOL_NAMES;
  const excluded = new Set(selection.excludeTools ?? []);
  return all.filter((tool) => selected.includes(tool.name as ToolName) && !excluded.has(tool.name as ToolName));
}

/** Pi-compatible default: core coding tools plus the session-only TodoWrite tool. */
export function createDefaultTools(cwd: string, selection: ToolSelection = {}): Tool[] {
  return selectTools(createAllTools(cwd), selection);
}

type CoreToolOptions = { sandboxRunner?: SandboxRunner; sandboxConfig?: SandboxConfig };

function createCoreTools(cwd: string, options: CoreToolOptions = {}): Tool[] {
  const bashTool = createBashTool(cwd, options.sandboxRunner
    ? { runner: options.sandboxRunner, config: { ...DEFAULT_SANDBOX_CONFIG, ...options.sandboxConfig } }
    : undefined);
  return [
    createReadTool(cwd) as Tool,
    bashTool as Tool,
    createEditTool(cwd) as Tool,
    createWriteTool(cwd) as Tool,
    createTodoWriteTool() as Tool,
    createGrepTool(cwd) as Tool,
    createFindTool(cwd) as Tool,
    createLsTool(cwd) as Tool,
  ];
}

function createGitAndValidationTools(cwd: string): Tool[] {
  return [...createGitTools(cwd), createValidationTool(cwd)];
}

/** All local coding-agent tools, before active-tool filtering. */
export function createAllTools(
  cwd: string,
  options: CoreToolOptions = {},
): Tool[] {
  return [...createCoreTools(cwd, options), ...createGitAndValidationTools(cwd)];
}

export function createTools(
  cwd: string,
  options: ToolSelection & {
    codebase?: boolean;
    codebaseStore?: RepositoryStore;
    codebaseProvider?: CodebaseSemanticProvider;
    webAccess?: boolean;
    /** Pre-created sandbox runner. Pass `undefined` for no sandbox. */
    sandboxRunner?: SandboxRunner;
    /** Original sandbox config (for reference in error messages). */
    sandboxConfig?: SandboxConfig;
    /** Inline sandbox config — creates a noop runner if provided (sync path). */
    sandbox?: SandboxConfig;
  } = {},
): Tool[] {
  const baseTools = createCoreTools(cwd, {
    sandboxRunner: options.sandboxRunner,
    sandboxConfig: options.sandboxConfig ?? options.sandbox,
  });

  const tools = selectTools(baseTools, options);

  const selectedGit = options.tools
    ? options.tools.filter((name) => name.startsWith("git_") || name === "validate_workspace")
    : ["git_status", "git_diff", "git_checkpoint", "git_undo", "git_branch_isolate", "validate_workspace"] as ToolName[];
  const existingNames = new Set(tools.map((tool) => tool.name));
  tools.push(...createGitAndValidationTools(cwd).filter((tool) =>
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

/**
 * Async variant that initializes a sandbox runner (Docker/Node) and returns
 * tools with the bash command routed through it.
 *
 * Use this from `server.ts` and other async bootstrap contexts. The returned
 * `cleanup` function must be called on shutdown to remove lingering containers.
 */
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
  let sandboxRunner: SandboxRunner | undefined;
  if (options.sandbox) {
    sandboxRunner = await createSandboxRunner(options.sandbox);
  }

  const tools = createTools(cwd, {
    ...options,
    sandboxRunner,
    sandboxConfig: options.sandbox,
  });

  const cleanup = async () => {
    if (sandboxRunner) await sandboxRunner.cleanup();
  };
  return { tools, cleanup };
}

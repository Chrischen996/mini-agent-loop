/**
 * Web UI Tool Suite & Provider Assembly
 *
 * Dedicated tool encapsulation for Web UI and HTTP Server execution.
 * Decoupled from CLI options to maintain independent configuration,
 * session-scoped document editing, and permission sandboxing.
 */

import path from "node:path";
import { DocumentStore } from "../documents.ts";
import { createDocumentEditTool } from "../tools/document-edit.ts";
import { createTodoTool, validateTodoSnapshot, type TodoItem } from "../tools/todo.ts";
import {
  createTools,
  createBgTaskTools,
  type ToolName,
  type ToolSelection,
} from "../tools/index.ts";
import type { Tool, ToolProvider } from "../tools/types.ts";
import { resolveToolProvider } from "../tools/types.ts";
import { mergeToolSets } from "../mcp/runtime.ts";
import type { RepositoryStore } from "../codebase/repository-store.ts";
import type { CodebaseSemanticProvider } from "../codebase/deepwiki-provider.ts";
import type { SandboxConfig, SandboxRunner } from "../sandbox/types.ts";
import { BgTaskManager, stableBgTaskInstanceId } from "../bg-tasks/manager.js";
import {
  createSubagentTool,
  createSubagentBatchTool,
  type SubagentProfile,
  type SubagentEvent,
  type SubagentToolOptions,
} from "../subagent/index.ts";
import type { LlmConfig, ChatFn } from "../llm/index.ts";
import type { AgentRuntimeRef } from "../loop.ts";
import type { ThinkingMode } from "../thinking-policy.ts";
import { loadThinkingModeFromEnv } from "../thinking-policy.ts";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import type { ToolExecutionBroker, ToolExecutionAuditEvent } from "../runtime/tool-execution-broker.ts";
import type { PermissionTurnContext } from "../permissions.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";

export type WebWorkspaceToolsConfig = {
  workspace: string;
  codebaseEnabled?: boolean;
  codebaseStore?: RepositoryStore;
  codebaseProvider?: CodebaseSemanticProvider;
  sandbox?: SandboxConfig;
  sandboxRunner?: SandboxRunner;
  mcpTools?: ToolProvider;
  mcpApproval?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
  backgroundTaskTools?: Tool[];
  toolSelection?: ToolSelection;
};

export type WebSessionToolsConfig = {
  sessionId: string;
  workspace: string;
  operationScope: string;
  documentStore: DocumentStore;
  updateTodos: (todos: unknown) => Promise<void>;
  baseTools: ToolProvider;
};

export type WebSubagentConfig = {
  sessionId: string;
  parentLlm: LlmConfig;
  parentTools: ToolProvider;
  profiles?: SubagentProfile[];
  preprocessors?: MessagePreprocessor[];
  signal?: AbortSignal;
  chat?: ChatFn;
  permissionTurn?: PermissionTurnContext;
  parentRuntime: AgentRuntimeRef;
  runtimeContext?: RuntimeExecutionContext;
  thinkingMode?: ThinkingMode;
  maxThinkingEscalations?: number;
  toolExecutionBroker?: ToolExecutionBroker;
  onToolExecutionAudit?: (event: ToolExecutionAuditEvent) => void;
  globalTokenBudget?: number;
  globalConcurrencyLimit?: number;
  onSubagentEvent?: (event: SubagentEvent) => void;
  subagentEnabled?: boolean;
};

/**
 * Creates the base workspace tool provider for Web UI sessions.
 * Manages MCP gating, codebase tools, and workspace sandboxing specifically for Web/HTTP.
 */
export function createWebWorkspaceToolProvider(config: WebWorkspaceToolsConfig): ToolProvider {
  const localTools = createTools(config.workspace, {
    codebase: config.codebaseEnabled,
    codebaseStore: config.codebaseStore,
    codebaseProvider: config.codebaseProvider,
    sandbox: config.sandbox,
    sandboxRunner: config.sandboxRunner,
    tools: config.toolSelection?.tools,
    excludeTools: config.toolSelection?.excludeTools,
  });

  const gateMcp = (tool: Tool): Tool => {
    if (tool.source?.kind !== "mcp" && tool.name !== "mcp_prompts" && tool.name !== "mcp_resource") {
      return tool;
    }
    return {
      ...tool,
      execute: async (args, signal, execution) => {
        if (config.mcpApproval) {
          await config.mcpApproval(tool, args, signal);
        }
        return tool.execute(args, signal, execution);
      },
    };
  };

  return () => {
    const bgTools = config.backgroundTaskTools ?? [];
    const mcpTools = resolveToolProvider(config.mcpTools ?? []);
    return mergeToolSets([...localTools, ...bgTools], mcpTools).map(gateMcp);
  };
}

/**
 * Creates session-bound todo tools that mutate the specific Web session's todo checklist.
 * Returns both `todo_write` and `TodoWrite` representations so agent models and
 * test suites can use either convention safely.
 */
export function createWebSessionTodoTools(
  onUpdate: (todos: unknown) => Promise<void>,
): { todoTool: Tool; todoWriteTool: Tool } {
  const todoTool = createTodoTool((todos) => onUpdate(todos));
  const todoWriteTool: Tool = {
    ...todoTool,
    name: "TodoWrite",
    displayName: "TodoWrite",
  };
  return { todoTool, todoWriteTool };
}

/**
 * Assembles the full tool suite for an active Web UI session turn, including:
 * 1. Base workspace tools (filtering out unbound generic task list tools)
 * 2. Web session-scoped document editing (document_edit)
 * 3. Web session todo manager (todo_write & TodoWrite)
 */
export function createWebSessionToolProvider(config: WebSessionToolsConfig): ToolProvider {
  const documentTool = createDocumentEditTool(
    config.documentStore,
    config.sessionId,
    config.operationScope,
  ) as Tool;

  const { todoTool, todoWriteTool } = createWebSessionTodoTools(config.updateTodos);

  return () => {
    const base = resolveToolProvider(config.baseTools).filter(
      (tool) => tool.name !== "TodoWrite" && tool.name !== "todo_write",
    );
    return [...base, documentTool, todoTool, todoWriteTool];
  };
}

/**
 * Assembles subagent and subagent_batch tools for Web UI streaming.
 */
export function createWebSubagentToolSet(input: WebSubagentConfig): {
  subagent: Tool;
  tools: ToolProvider;
} {
  const createOptions = (parentTools: ToolProvider): SubagentToolOptions => ({
    parentLlm: input.parentLlm,
    parentTools,
    profiles: input.profiles,
    preprocessors: input.preprocessors ?? [],
    signal: input.signal,
    chat: input.chat,
    onSubagentEvent: input.onSubagentEvent,
    permissionTurn: input.permissionTurn,
    thinkingMode:
      input.thinkingMode ??
      input.parentRuntime.thinkingMode ??
      loadThinkingModeFromEnv(),
    maxThinkingEscalations: input.maxThinkingEscalations,
    parentRuntime: input.parentRuntime,
    runtimeContext: input.runtimeContext,
    toolExecutionBroker: input.toolExecutionBroker,
    onToolExecutionAudit: input.onToolExecutionAudit,
    globalTokenBudget: input.globalTokenBudget,
    globalConcurrencyLimit: input.globalConcurrencyLimit,
  });

  const baseTools = resolveToolProvider(input.parentTools);
  const subagent = createSubagentTool(createOptions(baseTools)) as Tool;

  const tools: ToolProvider = input.subagentEnabled !== false
    ? () => {
        const currentBase = resolveToolProvider(input.parentTools);
        const subagentOptions = createOptions(currentBase);
        return [
          ...currentBase,
          createSubagentTool(subagentOptions) as Tool,
          createSubagentBatchTool(subagentOptions) as Tool,
        ];
      }
    : input.parentTools;

  return { subagent, tools };
}

export type WebToolSuiteOptions = {
  codebaseEnabled?: boolean;
  codebaseStore?: RepositoryStore;
  codebaseProvider?: CodebaseSemanticProvider;
  sandbox?: SandboxConfig;
  sandboxRunner?: SandboxRunner;
  mcpTools?: ToolProvider;
  mcpApproval?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
  backgroundTasksEnabled?: boolean;
  subagentProfiles?: SubagentProfile[];
  subagentEnabled?: boolean;
  preprocessors?: MessagePreprocessor[];
  chat?: ChatFn;
  thinkingMode?: ThinkingMode;
  maxThinkingEscalations?: number;
  toolExecutionBroker?: ToolExecutionBroker;
  onToolExecutionAudit?: (event: ToolExecutionAuditEvent) => void;
  globalTokenBudget?: number;
  globalConcurrencyLimit?: number;
};

/**
 * Encapsulated Tool Suite Manager for Web UI / Server.
 * Coordinates workspace tool caching, background task lifecycles,
 * session-scoped document editing, and Web streaming subagents.
 */
export class WebToolSuite {
  private readonly sharedToolProviders = new Map<string, ToolProvider>();
  private readonly bgTaskRuntimes = new Map<
    string,
    {
      manager: BgTaskManager;
      tools: Tool[];
      initialize: () => Promise<void>;
    }
  >();

  constructor(private readonly options: WebToolSuiteOptions = {}) {}

  getBackgroundTaskRuntime(root: string): {
    manager: BgTaskManager;
    tools: Tool[];
    initialize: () => Promise<void>;
  } | undefined {
    if (this.options.backgroundTasksEnabled === false) return undefined;
    let runtime = this.bgTaskRuntimes.get(root);
    if (!runtime) {
      const manager = new BgTaskManager(root, stableBgTaskInstanceId(root));
      let initialization: Promise<void> | undefined;
      const initialize = (): Promise<void> => {
        initialization ??= manager.initialize();
        return initialization;
      };
      const tools = createBgTaskTools(manager).map((tool) => ({
        ...tool,
        execute: async (
          args: Record<string, unknown>,
          signal?: AbortSignal,
          execution?: { cwd?: string },
        ) => {
          await initialize();
          return tool.execute(args, signal, execution);
        },
      }));
      runtime = { manager, tools, initialize };
      this.bgTaskRuntimes.set(root, runtime);
    }
    return runtime;
  }

  getWorkspaceTools(root: string): ToolProvider {
    const existing = this.sharedToolProviders.get(root);
    if (existing) return existing;

    const bgTools = this.getBackgroundTaskRuntime(root)?.tools ?? [];
    const provider = createWebWorkspaceToolProvider({
      workspace: root,
      codebaseEnabled: this.options.codebaseEnabled,
      codebaseStore: this.options.codebaseStore,
      codebaseProvider: this.options.codebaseProvider,
      sandbox: this.options.sandbox,
      sandboxRunner: this.options.sandboxRunner,
      mcpTools: this.options.mcpTools,
      mcpApproval: this.options.mcpApproval,
      backgroundTaskTools: bgTools,
    });

    this.sharedToolProviders.set(root, provider);
    return provider;
  }

  createSessionTools(config: {
    session: { id: string; thinkingMode?: ThinkingMode };
    workspaceRoot: string;
    operationScope: string;
    documentStore: DocumentStore;
    updateTodos: (todos: unknown) => Promise<void>;
    llm: LlmConfig;
    signal?: AbortSignal;
    permissionTurn?: PermissionTurnContext;
    parentRuntime: AgentRuntimeRef;
    runtimeContext?: RuntimeExecutionContext;
    onSubagentEvent?: (event: SubagentEvent) => void;
  }): { subagent: Tool; tools: ToolProvider } {
    const baseTools = createWebSessionToolProvider({
      sessionId: config.session.id,
      workspace: config.workspaceRoot,
      operationScope: config.operationScope,
      documentStore: config.documentStore,
      updateTodos: config.updateTodos,
      baseTools: this.getWorkspaceTools(config.workspaceRoot),
    });

    return createWebSubagentToolSet({
      sessionId: config.session.id,
      parentLlm: config.llm,
      parentTools: baseTools,
      profiles: this.options.subagentProfiles,
      preprocessors: this.options.preprocessors,
      signal: config.signal,
      chat: this.options.chat,
      permissionTurn: config.permissionTurn,
      parentRuntime: config.parentRuntime,
      runtimeContext: config.runtimeContext,
      thinkingMode: config.session.thinkingMode ?? this.options.thinkingMode,
      maxThinkingEscalations: this.options.maxThinkingEscalations,
      toolExecutionBroker: this.options.toolExecutionBroker,
      onToolExecutionAudit: this.options.onToolExecutionAudit,
      globalTokenBudget: this.options.globalTokenBudget,
      globalConcurrencyLimit: this.options.globalConcurrencyLimit,
      onSubagentEvent: config.onSubagentEvent,
      subagentEnabled: this.options.subagentEnabled,
    });
  }

  dispose(): void {
    for (const runtime of this.bgTaskRuntimes.values()) {
      try {
        runtime.manager.dispose();
      } catch {
        // ignore error during cleanup
      }
    }
    this.bgTaskRuntimes.clear();
    this.sharedToolProviders.clear();
  }
}

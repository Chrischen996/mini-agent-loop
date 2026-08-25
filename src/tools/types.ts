import type { MessageContent } from "../types.ts";
import type { TodoItem } from "../todo.ts";

export type JsonSchema = Record<string, unknown>;

export type ToolResult = {
  /** Text and/or image parts (string still allowed). */
  content: MessageContent;
  isError?: boolean;
  files?: FileArtifact[];
  /** Structured session-state update consumed by the agent loop. */
  todoUpdate?: TodoItem[];
};

export type FileArtifact = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  reused?: boolean;
};

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * Execution capabilities are policy input, not user-facing tool hints.
 * Undefined fields are resolved conservatively from the tool name/source.
 */
export type ToolCapabilities = {
  readWorkspace?: boolean;
  writeWorkspace?: boolean;
  executeProcess?: boolean;
  network?: boolean;
  externalData?: boolean;
  destructive?: boolean;
  requiresApproval?: boolean;
  idempotent?: boolean;
};

export type ToolSource =
  | { kind: "local" }
  | { kind: "web"; package: "pi-web-access" }
  | { kind: "mcp"; serverId: string; toolName: string };

export type Tool<TArgs = Record<string, unknown>> = {
  name: string;
  description: string;
  displayName?: string;
  source?: ToolSource;
  /** Advisory metadata only. Never use remote hints as an authorization decision. */
  annotations?: ToolAnnotations;
  capabilities?: ToolCapabilities;
  /** OpenAI function parameters object (JSON Schema). */
  parameters: JsonSchema;
  execute: (args: TArgs, signal?: AbortSignal) => Promise<ToolResult>;
};

export type ToolProvider = Tool[] | (() => Tool[]);

export function resolveToolProvider(provider: ToolProvider): Tool[] {
  return typeof provider === "function" ? provider() : provider;
}

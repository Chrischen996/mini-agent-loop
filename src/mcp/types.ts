import type { JsonSchema, ToolAnnotations } from "../tools/types.ts";

export type McpStdioServerConfig = {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  enabled: boolean;
  required: boolean;
  includeTools?: string[];
  excludeTools: string[];
  timeoutMs: number;
  maxTools: number;
  maxSchemaBytes: number;
  maxResultBytes: number;
};

export type LoadedMcpConfig = {
  path: string;
  servers: McpStdioServerConfig[];
};

export type McpServerState = "disabled" | "connecting" | "ready" | "error" | "closed";

export type McpServerStatus = {
  id: string;
  transport: "stdio";
  required: boolean;
  state: McpServerState;
  toolCount: number;
  error?: string;
  warning?: string;
};

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  execution?: { taskSupport?: "optional" | "required" | "forbidden" };
};

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name: string; title?: string; description?: string; mimeType?: string };

export type McpCallResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpClientConnection = {
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
};

export type McpClientFactory = (
  config: McpStdioServerConfig,
  signal?: AbortSignal,
) => Promise<McpClientConnection>;

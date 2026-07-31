import type { JsonSchema, ToolAnnotations } from "../tools/types.ts";

export type McpTransport = "stdio" | "http";

/** Fields shared by every MCP server regardless of transport. */
export type McpServerCommon = {
  id: string;
  enabled: boolean;
  required: boolean;
  includeTools?: string[];
  excludeTools: string[];
  timeoutMs: number;
  reconnect: boolean;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  maxTools: number;
  maxSchemaBytes: number;
  maxResultBytes: number;
};

export type McpStdioServerConfig = McpServerCommon & {
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
};

export type McpHttpServerConfig = McpServerCommon & {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type LoadedMcpConfig = {
  path: string;
  servers: McpServerConfig[];
};

export type McpServerState = "disabled" | "connecting" | "reconnecting" | "ready" | "error" | "closed";

export type McpServerStatus = {
  id: string;
  transport: McpTransport;
  required: boolean;
  state: McpServerState;
  toolCount: number;
  reconnectAttempt?: number;
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
  onToolsChanged?(listener: () => void): () => void;
  onClose?(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
};

export type McpClientFactory = (
  config: McpServerConfig,
  signal?: AbortSignal,
) => Promise<McpClientConnection>;

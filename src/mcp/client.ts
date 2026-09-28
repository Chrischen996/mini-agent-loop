import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpCallResult,
  McpClientConnection,
  McpContentBlock,
  McpPromptDefinition,
  McpResourceDefinition,
  McpStdioServerConfig,
  McpToolDefinition,
} from "./types.ts";

const MAX_DISCOVERED_TOOLS = 4_096;
const MAX_TOOL_PAGES = 100;

class SdkMcpClientConnection implements McpClientConnection {
  private closed = false;
  private closeError: Error | undefined;
  private lastError: Error | undefined;
  private pendingToolsChanged = false;
  private readonly toolsChangedListeners = new Set<() => void>();
  private readonly catalogChangedListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly client: Client;
  private readonly timeoutMs: number;

  constructor(
    client: Client,
    timeoutMs: number,
  ) {
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.client.listTools(
        cursor ? { cursor } : undefined,
        { signal, timeout: this.timeoutMs },
      );
      tools.push(...result.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execution: tool.execution,
      })));
      if (tools.length > MAX_DISCOVERED_TOOLS) {
        throw new Error(`MCP server returned more than ${MAX_DISCOVERED_TOOLS} tools`);
      }
      cursor = result.nextCursor;
      if (!cursor) return tools;
      if (cursors.has(cursor)) throw new Error("MCP tools/list returned a repeated cursor");
      cursors.add(cursor);
    }
    throw new Error(`MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
    );
    if ("toolResult" in result) {
      return {
        content: [{ type: "text", text: JSON.stringify(result.toolResult, null, 2) }],
      };
    }
    return result as McpCallResult;
  }

  async listPrompts(signal?: AbortSignal): Promise<Omit<McpPromptDefinition, "serverId">[]> {
    const prompts: Omit<McpPromptDefinition, "serverId">[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.client.listPrompts(
        cursor ? { cursor } : undefined,
        { signal, timeout: this.timeoutMs },
      );
      prompts.push(...result.prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments,
      })));
      cursor = result.nextCursor;
      if (!cursor) return prompts;
      if (cursors.has(cursor)) throw new Error("MCP prompts/list returned a repeated cursor");
      cursors.add(cursor);
    }
    throw new Error(`MCP prompts/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = await this.client.getPrompt(
      { name, arguments: args },
      { signal, timeout: this.timeoutMs },
    );
    const content: McpContentBlock[] = [];
    for (const message of result.messages) {
      const block = message.content;
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else if (block.type === "audio") content.push({ type: "audio", data: block.data, mimeType: block.mimeType });
      else if (block.type === "resource") {
        content.push({
          type: "resource",
          resource: "text" in block.resource
            ? { uri: block.resource.uri, text: block.resource.text, mimeType: block.resource.mimeType }
            : { uri: block.resource.uri, blob: block.resource.blob, mimeType: block.resource.mimeType },
        });
      } else if (block.type === "resource_link") {
        content.push({
          type: "resource_link",
          uri: block.uri,
          name: block.name,
          title: block.title,
          description: block.description,
          mimeType: block.mimeType,
        });
      } else {
        content.push({ type: "text", text: `[MCP prompt ${message.role}] unsupported content` });
      }
    }
    return { content, isError: false };
  }

  async listResources(signal?: AbortSignal): Promise<Omit<McpResourceDefinition, "serverId">[]> {
    const resources: Omit<McpResourceDefinition, "serverId">[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.client.listResources(
        cursor ? { cursor } : undefined,
        { signal, timeout: this.timeoutMs },
      );
      resources.push(...result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      })));
      cursor = result.nextCursor;
      if (!cursor) return resources;
      if (cursors.has(cursor)) throw new Error("MCP resources/list returned a repeated cursor");
      cursors.add(cursor);
    }
    throw new Error(`MCP resources/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.client.readResource(
      { uri },
      { signal, timeout: this.timeoutMs },
    );
    return {
      content: result.contents.map((item) => (
        "text" in item
          ? { type: "resource" as const, resource: { uri: item.uri, text: item.text, mimeType: item.mimeType } }
          : { type: "resource" as const, resource: { uri: item.uri, blob: item.blob, mimeType: item.mimeType } }
      )),
    };
  }

  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    if (this.pendingToolsChanged) {
      this.pendingToolsChanged = false;
      queueMicrotask(() => {
        if (this.toolsChangedListeners.has(listener)) listener();
      });
    }
    return () => this.toolsChangedListeners.delete(listener);
  }

  onCatalogChanged(listener: () => void): () => void {
    this.catalogChangedListeners.add(listener);
    return () => this.catalogChangedListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    if (this.closeError) {
      const closeError = this.closeError;
      queueMicrotask(() => {
        if (this.closeListeners.has(listener)) listener(closeError);
      });
    }
    return () => this.closeListeners.delete(listener);
  }

  handleToolsChanged(): void {
    if (this.closed) return;
    if (this.toolsChangedListeners.size === 0) {
      this.pendingToolsChanged = true;
      return;
    }
    for (const listener of this.toolsChangedListeners) listener();
  }

  handleCatalogChanged(): void {
    if (this.closed) return;
    for (const listener of this.catalogChangedListeners) listener();
  }

  handleError(error: Error): void {
    this.lastError = error;
  }

  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const closeError = this.lastError ?? new Error("MCP connection closed");
    this.closeError = closeError;
    for (const listener of this.closeListeners) listener(closeError);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}

async function connectMcpClient(
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<McpClientConnection> {
  let connection: SdkMcpClientConnection;
  // `tools` is a server capability in the current MCP SDK; advertising it
  // from the client is rejected by the SDK's strict capabilities type.
  const client = new Client({ name: "mini-agent", version: "0.1.0" }, {});
  connection = new SdkMcpClientConnection(client, timeoutMs);
  client.onerror = (error) => connection.handleError(error);
  client.onclose = () => connection.handleClose();
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => connection.handleToolsChanged());
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => connection.handleCatalogChanged());
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => connection.handleCatalogChanged());
    return connection;
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

export async function createStdioMcpClient(
  config: McpStdioServerConfig,
  signal?: AbortSignal,
): Promise<McpClientConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "pipe",
  });
  // Always drain stderr so a noisy server cannot block on a full pipe.
  transport.stderr?.on("data", () => undefined);
  return connectMcpClient(transport, config.timeoutMs, signal);
}

export async function createStreamableHttpMcpClient(
  options: {
    url: URL;
    timeoutMs: number;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  },
  signal?: AbortSignal,
): Promise<McpClientConnection> {
  const transport = new StreamableHTTPClientTransport(options.url, {
    requestInit: options.headers ? { headers: options.headers } : undefined,
    fetch: options.fetch,
  });
  return connectMcpClient(transport, options.timeoutMs, signal);
}

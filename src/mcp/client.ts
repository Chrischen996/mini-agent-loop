import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpCallResult,
  McpClientConnection,
  McpStdioServerConfig,
  McpToolDefinition,
} from "./types.ts";

const MAX_DISCOVERED_TOOLS = 4_096;
const MAX_TOOL_PAGES = 100;

class SdkMcpClientConnection implements McpClientConnection {
  private closed = false;
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
  const client = new Client(
    { name: "mini-agent", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    return new SdkMcpClientConnection(client, timeoutMs);
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
    fetch?: typeof globalThis.fetch;
  },
  signal?: AbortSignal,
): Promise<McpClientConnection> {
  const transport = new StreamableHTTPClientTransport(options.url, {
    fetch: options.fetch,
  });
  return connectMcpClient(transport, options.timeoutMs, signal);
}

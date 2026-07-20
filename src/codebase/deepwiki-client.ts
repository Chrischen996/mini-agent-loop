import { contentAsString } from "../content.ts";
import { createStreamableHttpMcpClient } from "../mcp/client.ts";
import { mcpResultToToolResult } from "../mcp/tool-adapter.ts";
import type { McpClientConnection } from "../mcp/types.ts";

export const DEEPWIKI_ENDPOINT = "https://mcp.deepwiki.com/mcp";
export const DEEPWIKI_TOOL_NAMES = [
  "ask_question",
  "read_wiki_contents",
  "read_wiki_structure",
] as const;

export type DeepWikiToolName = typeof DEEPWIKI_TOOL_NAMES[number];

export type DeepWikiConfig = {
  enabled: boolean;
  timeoutMs: number;
  maxResultBytes: number;
};

export type DeepWikiConnectionFactory = (
  signal?: AbortSignal,
) => Promise<McpClientConnection>;

function positiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function loadDeepWikiConfigFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): DeepWikiConfig {
  return {
    enabled: environment.DEEPWIKI_ENABLED === "1",
    timeoutMs: positiveInteger(
      "DEEPWIKI_TIMEOUT_MS",
      environment.DEEPWIKI_TIMEOUT_MS,
      30_000,
      300_000,
    ),
    maxResultBytes: positiveInteger(
      "DEEPWIKI_MAX_RESULT_BYTES",
      environment.DEEPWIKI_MAX_RESULT_BYTES,
      102_400,
      16 * 1024 * 1024,
    ),
  };
}

export class DeepWikiClient {
  private connection: McpClientConnection | undefined;
  private connectionPromise: Promise<McpClientConnection> | undefined;
  private closed = false;

  constructor(
    private readonly config: Pick<DeepWikiConfig, "timeoutMs" | "maxResultBytes">,
    private readonly connectionFactory: DeepWikiConnectionFactory = (signal) =>
      createStreamableHttpMcpClient({
        url: new URL(DEEPWIKI_ENDPOINT),
        timeoutMs: config.timeoutMs,
      }, signal),
  ) {}

  private async connect(signal?: AbortSignal): Promise<McpClientConnection> {
    if (this.closed) throw new Error("DeepWiki client is closed");
    if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    if (this.connection) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;

    const pending = this.connectionFactory(signal).then(async (connection) => {
      try {
        const definitions = await connection.listTools(signal);
        const available = new Set(definitions.map((tool) => tool.name));
        const missing = DEEPWIKI_TOOL_NAMES.filter((name) => !available.has(name));
        if (missing.length > 0) {
          throw new Error(`DeepWiki server is missing required tools: ${missing.join(", ")}`);
        }
        if (this.closed) {
          await connection.close();
          throw new Error("DeepWiki client is closed");
        }
        this.connection = connection;
        return connection;
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
      }
    });
    this.connectionPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.connectionPromise === pending) this.connectionPromise = undefined;
    }
  }

  private async invalidate(connection: McpClientConnection): Promise<void> {
    if (this.connection === connection) this.connection = undefined;
    await connection.close().catch(() => undefined);
  }

  async call(
    tool: DeepWikiToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = await this.connect(signal);
    try {
      const result = await connection.callTool(tool, args, signal);
      const converted = mcpResultToToolResult(result, this.config.maxResultBytes);
      const content = contentAsString(converted.content).trim();
      if (converted.isError) throw new Error(content || `DeepWiki tool ${tool} failed`);
      if (!content) throw new Error(`DeepWiki tool ${tool} returned empty content`);
      return content;
    } catch (error) {
      await this.invalidate(connection);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await connection.close().catch(() => undefined);
    const pending = this.connectionPromise;
    this.connectionPromise = undefined;
    if (pending) {
      const pendingConnection = await pending.catch(() => undefined);
      if (pendingConnection && pendingConnection !== connection) {
        await pendingConnection.close().catch(() => undefined);
      }
    }
  }
}

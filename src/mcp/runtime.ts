import type { Tool } from "../tools/types.ts";
import { loadMcpConfigFromEnv } from "./config.ts";
import { createStdioMcpClient } from "./client.ts";
import { createMcpTools } from "./tool-adapter.ts";
import type {
  LoadedMcpConfig,
  McpClientConnection,
  McpClientFactory,
  McpServerStatus,
} from "./types.ts";

function safeError(error: unknown, secrets: string[] = []): string {
  let message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
  const values = [...new Set(secrets.filter(Boolean))].sort((left, right) => right.length - left.length);
  for (const secret of values) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.slice(0, 500);
}

export function mergeToolSets(...sets: Tool[][]): Tool[] {
  const names = new Set<string>();
  const merged: Tool[] = [];
  for (const tools of sets) {
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}

export class McpRuntime {
  private readonly clients: McpClientConnection[] = [];
  private readonly runtimeTools: Tool[] = [];
  private readonly runtimeStatuses: McpServerStatus[] = [];
  private closed = false;
  readonly configPath: string | undefined;

  private constructor(configPath?: string) {
    this.configPath = configPath;
  }

  static async create(
    loaded: LoadedMcpConfig | undefined,
    options: { signal?: AbortSignal; clientFactory?: McpClientFactory } = {},
  ): Promise<McpRuntime> {
    const runtime = new McpRuntime(loaded?.path);
    if (!loaded) return runtime;
    const factory = options.clientFactory ?? createStdioMcpClient;
    const usedNames = new Set<string>();
    for (const config of loaded.servers) {
      const status: McpServerStatus = {
        id: config.id,
        transport: "stdio",
        required: config.required,
        state: config.enabled ? "connecting" : "disabled",
        toolCount: 0,
      };
      runtime.runtimeStatuses.push(status);
      if (!config.enabled) continue;
      let client: McpClientConnection | undefined;
      try {
        client = await factory(config, options.signal);
        const definitions = await client.listTools(options.signal);
        const candidateNames = new Set(usedNames);
        const adapted = createMcpTools(config, client, definitions, candidateNames);
        runtime.clients.push(client);
        runtime.runtimeTools.push(...adapted.tools);
        for (const name of candidateNames) usedNames.add(name);
        status.state = "ready";
        status.toolCount = adapted.tools.length;
        if (adapted.skippedTaskTools.length > 0) {
          status.warning = `Skipped task-required tools: ${adapted.skippedTaskTools.join(", ")}`;
        }
      } catch (error) {
        await client?.close().catch(() => undefined);
        status.state = "error";
        status.error = safeError(error, [
          config.command,
          config.cwd,
          ...config.args,
          ...Object.values(config.env ?? {}),
        ]);
        if (config.required) {
          await runtime.close();
          throw new Error(`Required MCP server ${config.id} failed: ${status.error}`);
        }
      }
    }
    return runtime;
  }

  snapshot(): Tool[] {
    return [...this.runtimeTools];
  }

  statuses(): McpServerStatus[] {
    return this.runtimeStatuses.map((status) => ({ ...status }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.clients.map((client) => client.close()));
    for (const status of this.runtimeStatuses) {
      if (status.state === "ready" || status.state === "connecting") status.state = "closed";
    }
  }
}

export async function createMcpRuntimeFromEnv(
  workspace: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    clientFactory?: McpClientFactory;
  } = {},
): Promise<McpRuntime> {
  const loaded = await loadMcpConfigFromEnv(workspace, options.environment);
  return McpRuntime.create(loaded, options);
}

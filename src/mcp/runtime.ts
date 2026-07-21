import type { Tool } from "../tools/types.ts";
import { loadMcpConfigFromEnv } from "./config.ts";
import { createStdioMcpClient } from "./client.ts";
import { createMcpTools } from "./tool-adapter.ts";
import type {
  LoadedMcpConfig,
  McpClientConnection,
  McpClientFactory,
  McpServerStatus,
  McpStdioServerConfig,
  McpToolDefinition,
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

type ServerRuntime = {
  config: McpStdioServerConfig;
  status: McpServerStatus;
  client?: McpClientConnection;
  definitions: McpToolDefinition[];
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  stableTimer?: NodeJS.Timeout;
  connectAbort?: AbortController;
  connectPromise?: Promise<void>;
  refreshPromise?: Promise<void>;
  refreshAgain?: boolean;
  unsubscribeToolsChanged?: () => void;
  unsubscribeClose?: () => void;
};

type CatalogOverride = {
  server: ServerRuntime;
  client?: McpClientConnection;
  definitions: McpToolDefinition[];
};

type BuiltCatalog = {
  tools: Tool[];
  counts: Map<ServerRuntime, number>;
  warnings: Map<ServerRuntime, string | undefined>;
  assignedNames: Map<string, string>;
};

export class McpRuntime {
  private readonly servers: ServerRuntime[] = [];
  private readonly runtimeTools: Tool[] = [];
  private readonly assignedToolNames = new Map<string, string>();
  private readonly clientFactory: McpClientFactory;
  private closed = false;
  readonly configPath: string | undefined;

  private constructor(configPath: string | undefined, clientFactory: McpClientFactory) {
    this.configPath = configPath;
    this.clientFactory = clientFactory;
  }

  static async create(
    loaded: LoadedMcpConfig | undefined,
    options: { signal?: AbortSignal; clientFactory?: McpClientFactory } = {},
  ): Promise<McpRuntime> {
    const runtime = new McpRuntime(loaded?.path, options.clientFactory ?? createStdioMcpClient);
    if (!loaded) return runtime;

    for (const config of loaded.servers) {
      const server: ServerRuntime = {
        config,
        definitions: [],
        reconnectAttempt: 0,
        status: {
          id: config.id,
          transport: "stdio",
          required: config.required,
          state: config.enabled ? "connecting" : "disabled",
          toolCount: 0,
        },
      };
      runtime.servers.push(server);
      if (!config.enabled) continue;
      try {
        await runtime.startConnect(server, true, options.signal);
      } catch (error) {
        await runtime.close();
        throw error;
      }
    }
    return runtime;
  }

  private secrets(config: McpStdioServerConfig): string[] {
    return [config.command, config.cwd, ...config.args, ...Object.values(config.env ?? {})];
  }

  private buildCatalog(override?: CatalogOverride): BuiltCatalog {
    const usedNames = new Set<string>();
    const tools: Tool[] = [];
    const counts = new Map<ServerRuntime, number>();
    const warnings = new Map<ServerRuntime, string | undefined>();
    const assignedNames = new Map(this.assignedToolNames);

    for (const server of this.servers) {
      const client = override?.server === server ? override.client : server.client;
      const definitions = override?.server === server ? override.definitions : server.definitions;
      if (!client) {
        counts.set(server, 0);
        warnings.set(server, undefined);
        continue;
      }
      const adapted = createMcpTools(
        server.config,
        client,
        definitions,
        usedNames,
        assignedNames,
      );
      tools.push(...adapted.tools);
      counts.set(server, adapted.tools.length);
      warnings.set(
        server,
        adapted.skippedTaskTools.length > 0
          ? `Skipped task-required tools: ${adapted.skippedTaskTools.join(", ")}`
          : undefined,
      );
    }
    return { tools, counts, warnings, assignedNames };
  }

  private commitCatalog(
    server: ServerRuntime,
    client: McpClientConnection | undefined,
    definitions: McpToolDefinition[],
  ): void {
    const catalog = this.buildCatalog({ server, client, definitions });
    server.client = client;
    server.definitions = definitions;
    this.assignedToolNames.clear();
    for (const [identity, name] of catalog.assignedNames) {
      this.assignedToolNames.set(identity, name);
    }
    this.runtimeTools.splice(0, this.runtimeTools.length, ...catalog.tools);
    for (const entry of this.servers) {
      entry.status.toolCount = catalog.counts.get(entry) ?? 0;
    }
    const warning = catalog.warnings.get(server);
    if (warning) server.status.warning = warning;
    else delete server.status.warning;
  }

  private startConnect(
    server: ServerRuntime,
    initial: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending = this.connectServer(server, initial, signal);
    server.connectPromise = pending;
    const clear = () => {
      if (server.connectPromise === pending) server.connectPromise = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private clearStableTimer(server: ServerRuntime): void {
    if (server.stableTimer) clearTimeout(server.stableTimer);
    server.stableTimer = undefined;
  }

  private scheduleStableReconnectReset(server: ServerRuntime): void {
    this.clearStableTimer(server);
    if (server.reconnectAttempt === 0) return;
    const stableWindow = Math.max(1_000, Math.min(server.config.maxReconnectDelayMs, 10_000));
    server.stableTimer = setTimeout(() => {
      server.stableTimer = undefined;
      if (server.client && server.status.state === "ready") {
        server.reconnectAttempt = 0;
        delete server.status.reconnectAttempt;
      }
    }, stableWindow);
  }

  private abortServerConnect(server: ServerRuntime): void {
    server.connectAbort?.abort();
    server.connectAbort = undefined;
  }

  private attachConnectionListeners(server: ServerRuntime, client: McpClientConnection): void {
    server.unsubscribeToolsChanged = client.onToolsChanged?.(() => this.queueToolRefresh(server, client));
    server.unsubscribeClose = client.onClose?.((error) => this.handleDisconnect(server, client, error));
  }

  private detachConnectionListeners(server: ServerRuntime): void {
    server.unsubscribeToolsChanged?.();
    server.unsubscribeClose?.();
    server.unsubscribeToolsChanged = undefined;
    server.unsubscribeClose = undefined;
  }

  private async connectServer(
    server: ServerRuntime,
    initial: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) return;
    if (signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    }
    if (server.reconnectTimer) {
      clearTimeout(server.reconnectTimer);
      server.reconnectTimer = undefined;
    }
    server.status.state = initial ? "connecting" : "reconnecting";
    const connectAbort = new AbortController();
    server.connectAbort = connectAbort;
    const abortConnect = () => connectAbort.abort();
    signal?.addEventListener("abort", abortConnect, { once: true });

    let client: McpClientConnection | undefined;
    try {
      client = await this.clientFactory(server.config, connectAbort.signal);
      const definitions = await client.listTools(connectAbort.signal);
      if (this.closed) {
        await client.close().catch(() => undefined);
        return;
      }
      if (connectAbort.signal.aborted) {
        await client.close().catch(() => undefined);
        throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
      }
      this.commitCatalog(server, client, definitions);
      this.attachConnectionListeners(server, client);
      server.status.state = "ready";
      delete server.status.error;
      this.scheduleStableReconnectReset(server);
    } catch (error) {
      await client?.close().catch(() => undefined);
      if (this.closed) return;
      server.status.state = "error";
      server.status.error = safeError(error, this.secrets(server.config));
      if (signal?.aborted) throw error;
      if (initial && server.config.required) {
        throw new Error(`Required MCP server ${server.config.id} failed: ${server.status.error}`);
      }
      this.scheduleReconnect(server);
    } finally {
      signal?.removeEventListener("abort", abortConnect);
      if (server.connectAbort === connectAbort) server.connectAbort = undefined;
    }
  }

  private reconnectDelay(server: ServerRuntime): number {
    const exponent = Math.min(Math.max(0, server.reconnectAttempt - 1), 20);
    return Math.min(
      server.config.maxReconnectDelayMs,
      server.config.reconnectDelayMs * (2 ** exponent),
    );
  }

  private scheduleReconnect(server: ServerRuntime): void {
    if (this.closed || !server.config.reconnect || server.reconnectTimer) return;
    server.reconnectAttempt += 1;
    const delay = this.reconnectDelay(server);
    server.status.state = "reconnecting";
    server.status.reconnectAttempt = server.reconnectAttempt;
    server.reconnectTimer = setTimeout(() => {
      server.reconnectTimer = undefined;
      void this.startConnect(server, false);
    }, delay);
  }

  private handleDisconnect(
    server: ServerRuntime,
    client: McpClientConnection,
    error?: Error,
  ): void {
    if (this.closed || server.client !== client) return;
    this.detachConnectionListeners(server);
    this.clearStableTimer(server);
    this.commitCatalog(server, undefined, []);
    server.status.error = safeError(error ?? new Error("MCP connection closed"), this.secrets(server.config));
    server.status.state = "error";
    this.scheduleReconnect(server);
  }

  private queueToolRefresh(server: ServerRuntime, client: McpClientConnection): void {
    if (this.closed || server.client !== client) return;
    if (server.refreshPromise) {
      server.refreshAgain = true;
      return;
    }
    const refresh = this.refreshTools(server, client).finally(() => {
      if (server.refreshPromise === refresh) server.refreshPromise = undefined;
      if (server.refreshAgain) {
        server.refreshAgain = false;
        this.queueToolRefresh(server, client);
      }
    });
    server.refreshPromise = refresh;
  }

  private async refreshTools(server: ServerRuntime, client: McpClientConnection): Promise<void> {
    try {
      const definitions = await client.listTools();
      if (this.closed || server.client !== client) return;
      this.commitCatalog(server, client, definitions);
      server.status.state = "ready";
      delete server.status.error;
    } catch (error) {
      if (this.closed || server.client !== client) return;
      server.status.warning = `Tool refresh failed: ${safeError(error, this.secrets(server.config))}`;
    }
  }

  snapshot(): Tool[] {
    return [...this.runtimeTools];
  }

  toolProvider(baseTools: Tool[] = []): () => Tool[] {
    return () => mergeToolSets(baseTools, this.snapshot());
  }

  statuses(): McpServerStatus[] {
    return this.servers.map(({ status }) => ({ ...status }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients: McpClientConnection[] = [];
    const pendingConnections = this.servers
      .map((server) => server.connectPromise)
      .filter((promise): promise is Promise<void> => Boolean(promise));
    for (const server of this.servers) {
      if (server.reconnectTimer) clearTimeout(server.reconnectTimer);
      server.reconnectTimer = undefined;
      this.clearStableTimer(server);
      this.abortServerConnect(server);
      this.detachConnectionListeners(server);
      if (server.client) clients.push(server.client);
      server.client = undefined;
      server.definitions = [];
      if (server.status.state !== "disabled") server.status.state = "closed";
      server.status.toolCount = 0;
      delete server.status.reconnectAttempt;
    }
    this.runtimeTools.splice(0, this.runtimeTools.length);
    await Promise.allSettled([
      ...clients.map((client) => client.close()),
      ...pendingConnections,
    ]);
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

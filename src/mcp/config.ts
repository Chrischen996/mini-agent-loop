import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedMcpConfig, McpStdioServerConfig } from "./types.ts";

const MAX_SERVERS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOLS = 64;
const DEFAULT_MAX_SCHEMA_BYTES = 262_144;
const DEFAULT_MAX_RESULT_BYTES = 1_048_576;
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(
  value: unknown,
  label: string,
  fallback: string[] = [],
  trim = true,
): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => trim ? item.trim() : item);
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

function resolveEnvironment(
  value: unknown,
  serverId: string,
  environment: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, `MCP server ${serverId}.env`);
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`MCP server ${serverId}.env contains invalid variable name: ${key}`);
    }
    if (typeof raw !== "string") {
      throw new Error(`MCP server ${serverId}.env.${key} must be a string`);
    }
    const reference = raw.match(ENV_REFERENCE);
    if (!reference) {
      output[key] = raw;
      continue;
    }
    const resolved = environment[reference[1]!];
    if (resolved === undefined) {
      throw new Error(`MCP server ${serverId} requires environment variable ${reference[1]}`);
    }
    output[key] = resolved;
  }
  return output;
}

function parseServer(
  id: string,
  value: unknown,
  configDirectory: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): McpStdioServerConfig {
  if (!id.trim()) throw new Error("MCP server ids must not be empty");
  const input = record(value, `MCP server ${id}`);
  const transport = input.transport ?? "stdio";
  if (transport !== "stdio") {
    throw new Error(`MCP server ${id} uses unsupported transport: ${String(transport)}`);
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new Error(`MCP server ${id}.command must be a non-empty string`);
  }
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) {
    throw new Error(`MCP server ${id}.cwd must be a non-empty string`);
  }
  const cwd = input.cwd
    ? path.resolve(configDirectory, input.cwd as string)
    : workspace;
  return {
    id,
    transport: "stdio",
    command: input.command.trim(),
    args: stringArray(input.args, `MCP server ${id}.args`, [], false),
    cwd,
    env: resolveEnvironment(input.env, id, environment),
    enabled: boolean(input.enabled, true, `MCP server ${id}.enabled`),
    required: boolean(input.required, false, `MCP server ${id}.required`),
    includeTools: input.includeTools === undefined
      ? undefined
      : stringArray(input.includeTools, `MCP server ${id}.includeTools`),
    excludeTools: stringArray(input.excludeTools, `MCP server ${id}.excludeTools`),
    timeoutMs: positiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, `MCP server ${id}.timeoutMs`, 300_000),
    maxTools: positiveInteger(input.maxTools, DEFAULT_MAX_TOOLS, `MCP server ${id}.maxTools`, 256),
    maxSchemaBytes: positiveInteger(
      input.maxSchemaBytes,
      DEFAULT_MAX_SCHEMA_BYTES,
      `MCP server ${id}.maxSchemaBytes`,
      4 * 1024 * 1024,
    ),
    maxResultBytes: positiveInteger(
      input.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      `MCP server ${id}.maxResultBytes`,
      16 * 1024 * 1024,
    ),
  };
}

export async function loadMcpConfig(
  configPath: string,
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedMcpConfig> {
  const resolvedPath = path.resolve(workspace, configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load MCP config ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(parsed, "MCP config");
  const serversRecord = record(root.mcpServers, "MCP config.mcpServers");
  const entries = Object.entries(serversRecord);
  if (entries.length > MAX_SERVERS) {
    throw new Error(`MCP config has ${entries.length} servers; maximum is ${MAX_SERVERS}`);
  }
  const configDirectory = path.dirname(resolvedPath);
  return {
    path: resolvedPath,
    servers: entries.map(([id, server]) => parseServer(id, server, configDirectory, workspace, environment)),
  };
}

export async function loadMcpConfigFromEnv(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedMcpConfig | undefined> {
  const configPath = environment.MINI_AGENT_MCP_CONFIG?.trim();
  if (!configPath) return undefined;
  return loadMcpConfig(configPath, workspace, environment);
}

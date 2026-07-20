import { createHash } from "node:crypto";
import type { ContentPart, MessageContent } from "../types.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import type {
  McpCallResult,
  McpClientConnection,
  McpContentBlock,
  McpStdioServerConfig,
  McpToolDefinition,
} from "./types.ts";

const MAX_TOOL_NAME_LENGTH = 64;
const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function segment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized || "tool";
}

function suffix(serverId: string, toolName: string): string {
  return createHash("sha256").update(serverId).update("\0").update(toolName).digest("hex").slice(0, 10);
}

export function createMcpToolName(
  serverId: string,
  toolName: string,
  usedNames: Set<string>,
): string {
  const readable = `mcp__${segment(serverId)}__${segment(toolName)}`;
  let candidate = readable;
  if (candidate.length > MAX_TOOL_NAME_LENGTH || usedNames.has(candidate)) {
    const hash = suffix(serverId, toolName);
    candidate = `${readable.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 2)}__${hash}`;
  }
  if (usedNames.has(candidate)) {
    throw new Error(`Duplicate MCP tool identity: ${serverId}/${toolName}`);
  }
  usedNames.add(candidate);
  return candidate;
}

function resourceText(block: Extract<McpContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if (typeof resource.text === "string") {
    return `[MCP resource ${resource.uri}]\n${resource.text}`;
  }
  return `[MCP binary resource omitted: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`;
}

function blockToPart(block: McpContentBlock): ContentPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      if (SUPPORTED_IMAGE_MIME.has(block.mimeType)) {
        return { type: "image", data: block.data, mimeType: block.mimeType, source: "mcp" };
      }
      return { type: "text", text: `[Unsupported MCP image omitted: ${block.mimeType}]` };
    case "audio":
      return { type: "text", text: `[MCP audio omitted: ${block.mimeType}]` };
    case "resource":
      return { type: "text", text: resourceText(block) };
    case "resource_link":
      return {
        type: "text",
        text: `[MCP resource link] ${block.title ?? block.name}: ${block.uri}`,
      };
  }
}

export function mcpResultToToolResult(
  result: McpCallResult,
  maxResultBytes: number,
): ToolResult {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > maxResultBytes) {
    return {
      content: `MCP result exceeded the ${maxResultBytes}-byte limit`,
      isError: true,
    };
  }
  const parts = result.content.map(blockToPart);
  if (result.structuredContent) {
    parts.push({
      type: "text",
      text: `[MCP structured content]\n${JSON.stringify(result.structuredContent, null, 2)}`,
    });
  }
  const content: MessageContent = parts.length === 0
    ? ""
    : parts.length === 1 && parts[0]?.type === "text"
      ? parts[0].text
      : parts;
  return { content, isError: result.isError };
}

export function createMcpTools(
  config: McpStdioServerConfig,
  client: McpClientConnection,
  definitions: McpToolDefinition[],
  usedNames: Set<string>,
): { tools: Tool[]; skippedTaskTools: string[] } {
  const include = config.includeTools ? new Set(config.includeTools) : undefined;
  const exclude = new Set(config.excludeTools);
  const selected = definitions.filter((tool) =>
    (!include || include.has(tool.name)) && !exclude.has(tool.name));
  const skippedTaskTools = selected
    .filter((tool) => tool.execution?.taskSupport === "required")
    .map((tool) => tool.name);
  const callable = selected.filter((tool) => tool.execution?.taskSupport !== "required");
  if (callable.length > config.maxTools) {
    throw new Error(`MCP server ${config.id} exposes ${callable.length} tools; configured maximum is ${config.maxTools}`);
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(callable), "utf8");
  if (schemaBytes > config.maxSchemaBytes) {
    throw new Error(
      `MCP server ${config.id} tool catalog is ${schemaBytes} bytes; configured maximum is ${config.maxSchemaBytes}`,
    );
  }
  const remoteNames = new Set<string>();
  const tools = callable.map((definition): Tool => {
    if (remoteNames.has(definition.name)) {
      throw new Error(`MCP server ${config.id} returned duplicate tool ${definition.name}`);
    }
    remoteNames.add(definition.name);
    const name = createMcpToolName(config.id, definition.name, usedNames);
    return {
      name,
      displayName: definition.title ?? definition.annotations?.title ?? definition.name,
      description: `[MCP ${config.id}/${definition.name}] ${definition.description ?? "Remote MCP tool"}`,
      parameters: definition.inputSchema,
      source: { kind: "mcp", serverId: config.id, toolName: definition.name },
      annotations: definition.annotations,
      execute: async (args, signal) => {
        const result = await client.callTool(definition.name, args, signal);
        return mcpResultToToolResult(result, config.maxResultBytes);
      },
    };
  });
  return { tools, skippedTaskTools };
}

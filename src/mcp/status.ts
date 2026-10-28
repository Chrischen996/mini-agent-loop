import type { McpServerStatus } from "./types.ts";
import type { Tool } from "../tools/types.ts";

/** Compact footer label such as `MCP 2 ready` or `MCP 1 error`. */
export function formatMcpStatus(statuses: readonly McpServerStatus[]): string | undefined {
  const active = statuses.filter((status) => status.state !== "disabled" && status.state !== "closed");
  if (active.length === 0) return undefined;
  const ready = active.filter((status) => status.state === "ready").length;
  const failed = active.filter((status) => status.state === "error").length;
  const pending = active.length - ready - failed;
  if (failed > 0 && ready === 0 && pending === 0) return `MCP ${failed} error`;
  if (failed > 0) return `MCP ${ready} ready, ${failed} error`;
  if (pending > 0 && ready === 0) return `MCP ${pending} connecting`;
  if (pending > 0) return `MCP ${ready} ready, ${pending} connecting`;
  return ready === 1 ? "MCP 1 ready" : `MCP ${ready} ready`;
}

function statusText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Detailed, credential-free MCP status for the TUI `/mcp` command. */
export function formatMcpStatusDetails(
  statuses: readonly McpServerStatus[] | undefined,
  tools: readonly Tool[] = [],
  serverId?: string,
): string {
  if (!statuses) return "MCP status is unavailable in this session.";
  if (statuses.length === 0) return "No MCP servers configured for this session.";

  const selected = serverId
    ? statuses.filter((status) => status.id === serverId)
    : statuses;
  if (selected.length === 0) return `No MCP server found: ${statusText(serverId ?? "")}`;

  const lines = [serverId ? `MCP server: ${statusText(serverId)}` : `MCP servers (${selected.length})`];
  for (const status of selected) {
    lines.push(
      "",
      `${statusText(status.id)}  ${status.state}`,
      `  Transport: ${status.transport}`,
      `  Required: ${status.required ? "yes" : "no"}`,
      `  Tools: ${status.toolCount}`,
    );
    if (status.reconnectAttempt !== undefined) {
      lines.push(`  Reconnect attempt: ${status.reconnectAttempt}`);
    }
    if (status.error) lines.push(`  Error: ${statusText(status.error)}`);
    if (status.warning) lines.push(`  Warning: ${statusText(status.warning)}`);

    if (serverId) {
      const serverTools = tools
        .filter((tool) => tool.source?.kind === "mcp" && tool.source.serverId === status.id)
        .map((tool) => statusText(tool.source?.kind === "mcp" ? tool.source.toolName : tool.name))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      if (serverTools.length > 0) {
        lines.push("  Tool names:", ...serverTools.map((name) => `    ${name}`));
      } else if (status.toolCount > 0) {
        lines.push("  Tool names: unavailable");
      }
    }
  }
  return lines.join("\n");
}

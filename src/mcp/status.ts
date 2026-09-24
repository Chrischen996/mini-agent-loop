import type { McpServerStatus } from "./types.ts";

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

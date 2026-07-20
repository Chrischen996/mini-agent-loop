import type { Tool } from "../tools/types.ts";

export function mcpAutoApproveFromEnv(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.MINI_AGENT_MCP_AUTO_APPROVE === "1";
}

export function createMcpApprovalGate(options: {
  allow: boolean;
  approvalHint: string;
}): (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void> {
  return async (tool, _args, signal) => {
    if (signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    }
    if (tool.source?.kind !== "mcp" || options.allow) return;
    throw new Error(
      `MCP tool ${tool.source.serverId}/${tool.source.toolName} requires explicit approval. ${options.approvalHint}`,
    );
  };
}

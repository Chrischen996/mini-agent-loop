import type { Tool } from "../tools/types.ts";

/**
 * A whitelist entry is either a whole server (`serverId`) or one tool
 * (`serverId/toolName`). Matching is exact and case-sensitive; `*` is not a
 * wildcard so a typo cannot silently approve every remote call.
 */
export function parseMcpAllowlist(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.:-]+)?$/.test(entry)) {
      throw new Error(
        `Invalid MCP allowlist entry "${entry}". Use serverId or serverId/toolName.`,
      );
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

export function mcpAutoApproveFromEnv(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.MINI_AGENT_MCP_AUTO_APPROVE === "1";
}

export function mcpAllowlistFromEnv(environment: NodeJS.ProcessEnv = process.env): string[] {
  return parseMcpAllowlist(environment.MINI_AGENT_MCP_ALLOW);
}

export function isMcpCallAllowed(
  serverId: string,
  toolName: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(serverId) || allowlist.includes(`${serverId}/${toolName}`);
}

export function createMcpApprovalGate(options: {
  allow: boolean;
  allowlist?: readonly string[];
  approvalHint: string;
}): (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void> {
  const allowlist = options.allowlist ?? [];
  return async (tool, _args, signal) => {
    if (signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    }
    if (tool.source?.kind !== "mcp") return;
    if (options.allow || isMcpCallAllowed(tool.source.serverId, tool.source.toolName, allowlist)) return;
    throw new Error(
      `MCP tool ${tool.source.serverId}/${tool.source.toolName} requires explicit approval. ${options.approvalHint}`,
    );
  };
}

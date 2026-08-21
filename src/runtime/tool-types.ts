import type { Tool, ToolCapabilities } from "../tools/types.ts";

const READ_TOOLS = new Set([
  "read", "grep", "find", "ls", "list", "search", "git_status", "git_diff",
  "codebase_open", "codebase_search", "codebase_read", "codebase_explain",
]);
const WRITE_TOOLS = new Set([
  "write", "edit", "patch", "mkdir", "copy", "move", "delete", "document_edit",
  "git_checkpoint", "git_undo", "git_branch_isolate",
]);
const WEB_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check"]);
const DESTRUCTIVE_TOOLS = new Set(["delete", "move", "git_undo"]);

function commandCapabilities(command: string): ToolCapabilities {
  const destructive = /(?:^|[\s;&|])(?:rm|mv|chmod|chown|sudo|dd|mkfs|format)(?:\s|$)/i.test(command);
  const writes = destructive || /(?:^|[\s;&|])(?:cp|mkdir|touch|tee|install|ln)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:>>?|>|sed\s+-i|perl\s+-i)(?:\s|$)/i.test(command);
  const network = /(?:^|[\s;&|])(?:curl|wget|ssh|scp|nc|netcat)(?:\s|$)/i.test(command)
    || /\b(?:git\s+)?(?:clone|fetch|pull|push)\b/i.test(command);
  return {
    executeProcess: true,
    writeWorkspace: writes,
    network,
    destructive,
    requiresApproval: writes || network || destructive,
  };
}

/** Resolve declared capabilities without trusting remote annotation hints. */
export function resolveToolCapabilities(
  tool: Tool,
  args: Record<string, unknown> = {},
): Required<Pick<ToolCapabilities, "readWorkspace" | "writeWorkspace" | "executeProcess" | "network" | "externalData" | "destructive" | "requiresApproval" | "idempotent">> {
  const inferred: ToolCapabilities = {};

  if (READ_TOOLS.has(tool.name)) inferred.readWorkspace = true;
  if (WRITE_TOOLS.has(tool.name)) {
    inferred.writeWorkspace = true;
    inferred.requiresApproval = true;
  }
  if (DESTRUCTIVE_TOOLS.has(tool.name)) inferred.destructive = true;
  if (WEB_TOOLS.has(tool.name)) {
    inferred.network = true;
    inferred.externalData = true;
    inferred.requiresApproval = true;
  }
  if (tool.name === "bash") {
    Object.assign(inferred, commandCapabilities(typeof args.command === "string" ? args.command : ""));
  }
  if (tool.name === "validate_workspace") inferred.executeProcess = true;

  if (tool.source?.kind === "web") {
    inferred.network = true;
    inferred.externalData = true;
    inferred.requiresApproval = true;
  }
  if (tool.source?.kind === "mcp") {
    inferred.externalData = true;
    inferred.requiresApproval = true;
  }

  // An explicit capability is authoritative. An annotation remains advisory.
  const declared = tool.capabilities ?? {};
  const idempotent = declared.idempotent ?? tool.annotations?.idempotentHint ?? false;
  return {
    readWorkspace: declared.readWorkspace ?? inferred.readWorkspace ?? false,
    writeWorkspace: declared.writeWorkspace ?? inferred.writeWorkspace ?? false,
    executeProcess: declared.executeProcess ?? inferred.executeProcess ?? false,
    network: declared.network ?? inferred.network ?? false,
    externalData: declared.externalData ?? inferred.externalData ?? false,
    destructive: declared.destructive ?? inferred.destructive ?? false,
    requiresApproval: declared.requiresApproval ?? inferred.requiresApproval ?? false,
    idempotent,
  };
}

export function normalizeForFingerprint(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = normalizeForFingerprint(record[key]);
    return result;
  }, {});
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

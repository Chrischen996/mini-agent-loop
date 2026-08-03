import { randomUUID } from "node:crypto";
import type { Tool, ToolSource } from "./tools/types.ts";

export type PermissionDecision = "allow" | "deny";
export type PermissionRisk = "safe" | "medium" | "high";
export type PermissionRequest = {
  id: string;
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  risk: PermissionRisk;
  source?: ToolSource;
};

export type PermissionMode = "plan" | "auto" | "bypass";

type Pending = {
  request: PermissionRequest;
  key: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

const AUTO_ALLOWED = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "list",
  "search",
  "codebase_search",
  "codebase_read",
  "codebase_explain",
]);

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "delete",
  "mkdir",
  "copy",
  "move",
  "patch",
  "bash",
  "document_edit",
]);

const DANGEROUS_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "sudo",
  "dd",
  "mkfs",
  "format",
]);

export function getRiskLevel(
  tool: Tool,
  args: Record<string, unknown>,
  mode: PermissionMode,
): "safe" | "medium" | "high" {
  // Plan mode: all write operations are considered risky
  if (mode === "plan") {
    if (WRITE_TOOLS.has(tool.name)) return "high";
    if (tool.name === "bash") return "high";
    return "safe";
  }

  // Bypass mode: no risk assessment needed
  if (mode === "bypass") return "safe";

  // Auto mode: smart risk assessment
  if (tool.source?.kind === "mcp") return "high";
  if (tool.name === "bash") {
    const cmd = args.command as string;
    if (cmd && Array.from(DANGEROUS_COMMANDS).some((d: string) => cmd.split(/\s+/)[0] === d)) return "high";
    return "medium";
  }
  if (tool.name === "delete" || tool.name === "document_edit") return "high";
  if (WRITE_TOOLS.has(tool.name)) return "medium";
  if (AUTO_ALLOWED.has(tool.name)) return "safe";
  return "medium";
}

export class PermissionManager {
  private readonly pending = new Map<string, Pending>();
  private approved = new Set<string>();
  private mode: PermissionMode;

  /** Optional callback for permission audit logging. */
  onPermissionEvent?: (event: { type: "request" | "allow" | "deny"; request: PermissionRequest }) => void;

  constructor(mode: PermissionMode = "auto") {
    this.mode = mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Serialize state for persistence (mode + approved keys). */
  serialize(): string {
    return JSON.stringify({ mode: this.mode, approved: [...this.approved] });
  }

  /** Deserialize state from JSON string. */
  deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data) as { mode: PermissionMode; approved: string[] };
      this.mode = parsed.mode ?? "auto";
      this.approved = new Set(parsed.approved ?? []);
    } catch {
      // Ignore deserialization errors; fall back to defaults
    }
  }

  private key(sessionId: string, tool: Tool, args: Record<string, unknown>): string {
    return `${sessionId}:${tool.name}:${this.stableStringify(args)}`;
  }

  /** Serialize args with sorted keys for stable approval key generation. */
  private stableStringify(obj: Record<string, unknown>): string {
    const sorted = Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {} as Record<string, unknown>);
    return JSON.stringify(sorted);
  }

  async authorize(
    sessionId: string,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onRequest: (request: PermissionRequest) => void,
  ): Promise<void> {
    // Bypass mode: auto-allow everything
    if (this.mode === "bypass") {
      this.onPermissionEvent?.({ type: "allow", request: { id: `perm_${randomUUID()}`, sessionId, tool: tool.name, arguments: args, risk: "safe", source: tool.source } });
      return;
    }

    // Plan mode: only allow read-only tools
    if (this.mode === "plan") {
      if (WRITE_TOOLS.has(tool.name) || tool.name === "bash") {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const request: PermissionRequest = {
          id: `perm_${randomUUID()}`,
          sessionId,
          tool: tool.name,
          arguments: args,
          risk: "high",
          source: tool.source,
        };
        this.onPermissionEvent?.({ type: "request", request });
        return await new Promise<void>((resolve, reject) => {
          this.pending.set(request.id, { request, key: this.key(sessionId, tool, args), resolve, reject });
          const abort = () => {
            this.pending.delete(request.id);
            reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
          };
          signal?.addEventListener("abort", abort, { once: true });
          onRequest(request);
        });
      }
      return;
    }

    // Auto mode: check risk level
    const risk = getRiskLevel(tool, args, this.mode);
    if (risk === "safe" && AUTO_ALLOWED.has(tool.name)) {
      this.onPermissionEvent?.({ type: "allow", request: { id: `perm_${randomUUID()}`, sessionId, tool: tool.name, arguments: args, risk: "safe", source: tool.source } });
      return;
    }
    if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    const key = this.key(sessionId, tool, args);
    if (this.approved.has(key)) return;
    const request: PermissionRequest = {
      id: `perm_${randomUUID()}`,
      sessionId,
      tool: tool.name,
      arguments: args,
      risk: risk === "safe" ? "medium" : risk,
      source: tool.source,
    };
    this.onPermissionEvent?.({ type: "request", request });
    return await new Promise<void>((resolve, reject) => {
      this.pending.set(request.id, { request, key, resolve, reject });
      const abort = () => {
        this.pending.delete(request.id);
        reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", abort, { once: true });
      onRequest(request);
    });
  }

  resolve(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.sessionId !== sessionId) return false;
    this.pending.delete(requestId);
    if (decision === "allow") {
      this.approved.add(pending.key);
      this.onPermissionEvent?.({ type: "allow", request: pending.request });
      pending.resolve();
    } else {
      this.onPermissionEvent?.({ type: "deny", request: pending.request });
      pending.reject(new Error(`Permission denied for tool: ${pending.request.tool}`));
    }
    return true;
  }

  rejectSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.reject(new Error("Session closed"));
    }
    for (const key of this.approved) {
      if (key.startsWith(`${sessionId}:`)) this.approved.delete(key);
    }
  }
}

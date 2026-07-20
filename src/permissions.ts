import { randomUUID } from "node:crypto";
import type { Tool, ToolSource } from "./tools/types.ts";

export type PermissionDecision = "allow" | "deny";
export type PermissionRisk = "medium" | "high";
export type PermissionRequest = {
  id: string;
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  risk: PermissionRisk;
  source?: ToolSource;
};

type Pending = {
  request: PermissionRequest;
  key: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

const AUTO_ALLOWED = new Set(["read", "grep", "find", "ls", "list", "search"]);

export class PermissionManager {
  private readonly pending = new Map<string, Pending>();
  private readonly approved = new Set<string>();

  private key(sessionId: string, tool: Tool, args: Record<string, unknown>): string {
    return `${sessionId}:${tool.name}:${JSON.stringify(args)}`;
  }

  async authorize(
    sessionId: string,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onRequest: (request: PermissionRequest) => void,
  ): Promise<void> {
    if (tool.source?.kind !== "mcp" && AUTO_ALLOWED.has(tool.name)) return;
    if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    const key = this.key(sessionId, tool, args);
    if (this.approved.has(key)) return;
    const request: PermissionRequest = {
      id: `perm_${randomUUID()}`,
      sessionId,
      tool: tool.name,
      arguments: args,
      risk: tool.source?.kind === "mcp" || tool.name === "bash" || tool.name === "delete" ? "high" : "medium",
      source: tool.source,
    };
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
      pending.resolve();
    } else pending.reject(new Error(`Permission denied for tool: ${pending.request.tool}`));
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

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ToolSource } from "./tools/types.ts";

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

export type PermissionMode = "plan" | "manual" | "auto" | "bypass";

export const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "manual", "auto", "bypass"] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export class PermissionModeChangedError extends Error {
  readonly previousMode: PermissionMode;
  readonly mode: PermissionMode;
  readonly previousRevision: number;
  readonly revision: number;

  constructor(previousMode: PermissionMode, mode: PermissionMode, previousRevision: number, revision: number) {
    super(`Permission mode changed from ${previousMode} to ${mode}`);
    this.name = "AbortError";
    this.previousMode = previousMode;
    this.mode = mode;
    this.previousRevision = previousRevision;
    this.revision = revision;
  }
}

export type PermissionModeChange = {
  changed: boolean;
  previousMode: PermissionMode;
  mode: PermissionMode;
  previousRevision: number;
  revision: number;
  interrupted: boolean;
};

export type PermissionTurnContext = {
  readonly mode: PermissionMode;
  readonly revision: number;
  readonly signal: AbortSignal;
  authorize(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  execute(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  assertCurrent(): void;
  close(): void;
};

type Pending = {
  request: PermissionRequest;
  key: string;
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

type ActiveTurn = {
  revision: number;
  controller: AbortController;
};

function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return { signal: new AbortController().signal, cleanup: () => {} };
  if (active.length === 1) return { signal: active[0]!, cleanup: () => {} };

  const controller = new AbortController();
  const listeners = active.map((signal) => {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  });
  return { signal: controller.signal, cleanup: () => listeners.forEach((remove) => remove()) };
}

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
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
]);

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "delete",
  "mkdir",
  "copy",
  "move",
  "patch",
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
  "tee",
  "touch",
  "install",
  "ln",
]);

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const ENV_WRAPPERS = new Set(["env"]);
const COMMAND_SEPARATOR_TOKENS = new Set([";", "&&", "||", "|", "|&", "&"]);
const OUTPUT_REDIRECTION_TOKENS = new Set([">", ">>", ">|", ">&", "&>"]);

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let mode: "plain" | "single" | "double" = "plain";

  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;

    if (mode === "single") {
      if (char === "'") {
        mode = "plain";
      } else {
        current += char;
      }
      continue;
    }

    if (mode === "double") {
      if (char === '"') {
        mode = "plain";
        continue;
      }
      if (char === "\\" && index + 1 < command.length) {
        current += command[++index]!;
        continue;
      }
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "'") {
      mode = "single";
      continue;
    }

    if (char === '"') {
      mode = "double";
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      current += command[++index]!;
      continue;
    }

    if (char === ";") {
      pushCurrent();
      tokens.push(";");
      continue;
    }

    if (char === "&") {
      pushCurrent();
      if (command[index + 1] === "&") {
        tokens.push("&&");
        index++;
      } else if (command[index + 1] === ">") {
        tokens.push("&>");
        index++;
      } else {
        tokens.push("&");
      }
      continue;
    }

    if (char === "|") {
      pushCurrent();
      if (command[index + 1] === "|") {
        tokens.push("||");
        index++;
      } else if (command[index + 1] === "&") {
        tokens.push("|&");
        index++;
      } else {
        tokens.push("|");
      }
      continue;
    }

    if (char === ">") {
      pushCurrent();
      if (command[index + 1] === ">") {
        tokens.push(">>");
        index++;
      } else if (command[index + 1] === "|") {
        tokens.push(">|");
        index++;
      } else if (command[index + 1] === "&") {
        tokens.push(">&");
        index++;
      } else {
        tokens.push(">");
      }
      continue;
    }

    if (char === "<") {
      pushCurrent();
      if (command[index + 1] === "<") {
        tokens.push("<<");
        index++;
      } else {
        tokens.push("<");
      }
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function analyzeShellCommand(command: string, depth = 0): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (depth > 4) return true;

  const tokens = tokenizeShellCommand(trimmed);
  if (tokens.length === 0) return true;

  const segments: string[][] = [];
  let segment: string[] = [];
  for (const token of tokens) {
    if (COMMAND_SEPARATOR_TOKENS.has(token)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(token);
  }
  if (segment.length > 0) segments.push(segment);

  for (const segmentTokens of segments) {
    if (segmentTokens.some((token) => OUTPUT_REDIRECTION_TOKENS.has(token))) return true;

    const [firstToken, ...rest] = segmentTokens;
    if (!firstToken) continue;
    const commandName = firstToken.toLowerCase();

    if (DANGEROUS_COMMANDS.has(commandName)) return true;

    if (SHELL_WRAPPERS.has(commandName)) {
      const cIndex = rest.findIndex((token) =>
        token === "-c" ||
        token === "--command" ||
        token === "--exec" ||
        /^-[^-]*c[^-]*$/.test(token),
      );
      if (cIndex < 0) return true;
      const nested = rest[cIndex + 1];
      if (!nested || analyzeShellCommand(nested, depth + 1)) return true;
      continue;
    }

    if (ENV_WRAPPERS.has(commandName)) {
      const commandIndex = rest.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token));
      if (commandIndex >= 0) {
        const nested = rest.slice(commandIndex).join(" ");
        if (analyzeShellCommand(nested, depth + 1)) return true;
      }
      continue;
    }
  }

  return false;
}

function isDangerousBashCommand(command: string): boolean {
  return analyzeShellCommand(command);
}

export function getRiskLevel(
  tool: Tool,
  args: Record<string, unknown>,
  mode: PermissionMode,
): "safe" | "medium" | "high" {
  // Plan mode: analysis only. Writes and dangerous shell stay high risk.
  if (mode === "plan") {
    if (tool.name === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      return isDangerousBashCommand(command) ? "high" : "safe";
    }
    if (WRITE_TOOLS.has(tool.name)) return "high";
    return "safe";
  }

  // Bypass mode: skip user approval but still respect path sandbox.
  // The actual path validation happens in tool implementations (read.ts, write.ts, etc.)
  // This function only determines if user approval is needed.
  if (mode === "bypass") return "safe";

  // Manual mode: every tool call requires an explicit decision.
  if (mode === "manual") {
    if (tool.source?.kind === "mcp") return "high";
    if (tool.name === "bash") {
      const cmd = typeof args.command === "string" ? args.command : "";
      return isDangerousBashCommand(cmd) ? "high" : "medium";
    }
    if (tool.name === "delete" || tool.name === "document_edit") return "high";
    if (WRITE_TOOLS.has(tool.name)) return "medium";
    if (AUTO_ALLOWED.has(tool.name)) return "medium";
    return "medium";
  }

  // Auto mode: smart risk assessment.
  // MCP tools are marked high by default, but can be configured as trusted.
  if (tool.source?.kind === "mcp") {
    // Check if this MCP tool has a trusted designation via annotations
    const isTrusted = (tool.annotations as any)?.["x-trusted"] === true;
    return isTrusted ? "medium" : "high";
  }
  if (tool.name === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    if (isDangerousBashCommand(cmd)) return "high";
    return "medium";
  }
  if (tool.name === "delete" || tool.name === "document_edit") return "high";
  if (WRITE_TOOLS.has(tool.name)) return "medium";
  if (AUTO_ALLOWED.has(tool.name)) return "safe";
  return "medium";
}

export class PermissionManager {
  private readonly pending = new Map<string, Pending>();
  private readonly activeTurns = new Set<ActiveTurn>();
  private approved = new Set<string>();
  private mode: PermissionMode;
  private revision = 0;

  /** Optional callback for permission audit logging. */
  onPermissionEvent?: (event: { type: "request" | "allow" | "deny"; request: PermissionRequest }) => void;

  constructor(mode: PermissionMode = "auto") {
    this.mode = mode;
  }

  setMode(mode: PermissionMode): PermissionModeChange {
    const previousMode = this.mode;
    const previousRevision = this.revision;
    if (this.mode === mode) {
      return {
        changed: false,
        previousMode,
        mode,
        previousRevision,
        revision: this.revision,
        interrupted: false,
      };
    }
    this.mode = mode;
    this.revision += 1;
    // A decision made under one policy must never silently carry into another.
    this.approved.clear();
    const reason = new PermissionModeChangedError(previousMode, mode, previousRevision, this.revision);
    let interrupted = false;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.cleanup?.();
      pending.reject(reason);
      interrupted = true;
    }
    for (const active of this.activeTurns) {
      interrupted = true;
      if (!active.controller.signal.aborted) active.controller.abort(reason);
    }
    return {
      changed: true,
      previousMode,
      mode,
      previousRevision,
      revision: this.revision,
      interrupted,
    };
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  getRevision(): number {
    return this.revision;
  }

  beginTurn(
    sessionId: string,
    onRequest: (request: PermissionRequest) => void,
    externalSignal?: AbortSignal,
  ): PermissionTurnContext {
    const mode = this.mode;
    const revision = this.revision;
    const controller = new AbortController();
    const merged = mergeAbortSignals(controller.signal, externalSignal);
    const active: ActiveTurn = { revision, controller };
    this.activeTurns.add(active);
    let closed = false;

    const assertCurrent = () => {
      if (this.revision !== revision || this.mode !== mode) {
        throw new PermissionModeChangedError(mode, this.mode, revision, this.revision);
      }
      if (merged.signal.aborted) {
        const reason = merged.signal.reason;
        if (reason instanceof Error) throw reason;
        throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
      }
    };

    const authorize = async (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => {
      assertCurrent();
      const combined = mergeAbortSignals(merged.signal, signal);
      try {
        await this.authorizeAtRevision(sessionId, mode, revision, tool, args, combined.signal, onRequest);
        assertCurrent();
      } finally {
        combined.cleanup();
      }
    };

    return {
      mode,
      revision,
      signal: merged.signal,
      authorize,
      execute: async (tool, args, signal) => {
        await authorize(tool, args, signal);
        assertCurrent();
        const combined = mergeAbortSignals(merged.signal, signal);
        try {
          assertCurrent();
          const result = await tool.execute(args, combined.signal);
          // A tool may ignore AbortSignal and finish after a mode switch. Do
          // not let that stale result advance the old turn.
          assertCurrent();
          return result;
        } finally {
          combined.cleanup();
        }
      },
      assertCurrent,
      close: () => {
        if (closed) return;
        closed = true;
        this.activeTurns.delete(active);
        merged.cleanup();
      },
    };
  }

  /** Serialize state for persistence (mode + approved keys). */
  serialize(): string {
    return JSON.stringify({ mode: this.mode, approved: [...this.approved] });
  }

  /** Deserialize state from JSON string. */
  deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data) as { mode: unknown; approved: unknown };
      const nextMode = isPermissionMode(parsed.mode) ? parsed.mode : "auto";
      if (nextMode !== this.mode) this.setMode(nextMode);
      this.approved = new Set(
        Array.isArray(parsed.approved)
          ? parsed.approved.filter((value): value is string => typeof value === "string")
          : [],
      );
    } catch {
      // Ignore deserialization errors; fall back to defaults
    }
  }

  private key(sessionId: string, tool: Tool, args: Record<string, unknown>): string {
    const source = tool.source ? this.stableStringify(tool.source as Record<string, unknown>) : "local";
    return `${sessionId}:${source}:${tool.name}:${this.stableStringify(args)}`;
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
    const mode = this.mode;
    const revision = this.revision;
    await this.authorizeAtRevision(sessionId, mode, revision, tool, args, signal, onRequest);
  }

  private assertRevision(mode: PermissionMode, revision: number): void {
    if (this.mode !== mode || this.revision !== revision) {
      throw new PermissionModeChangedError(mode, this.mode, revision, this.revision);
    }
  }

  private async authorizeAtRevision(
    sessionId: string,
    mode: PermissionMode,
    revision: number,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onRequest: (request: PermissionRequest) => void,
  ): Promise<void> {
    this.assertRevision(mode, revision);
    // Bypass mode: auto-allow everything.
    if (mode === "bypass") {
      this.onPermissionEvent?.({
        type: "allow",
        request: {
          id: `perm_${randomUUID()}`,
          sessionId,
          tool: tool.name,
          arguments: args,
          risk: "safe",
          source: tool.source,
        },
      });
      return;
    }

    // Plan mode: analysis only. Never execute writes or dangerous shell.
    if (mode === "plan") {
      if (tool.source?.kind === "mcp") {
        // MCP is always remote/untrusted, even when its advertised name is a
        // local-looking tool such as `read` or `bash`.
      } else if (tool.name === "bash") {
        const command = typeof args.command === "string" ? args.command : "";
        if (!isDangerousBashCommand(command)) return;
      } else if (!WRITE_TOOLS.has(tool.name)) {
        return;
      }

      const request: PermissionRequest = {
        id: `perm_${randomUUID()}`,
        sessionId,
        tool: tool.name,
        arguments: args,
        risk: "high",
        source: tool.source,
      };
      // Plan is analysis-only: audit the blocked call, but never open an
      // interactive approval prompt that could be "allowed" into execution.
      this.onPermissionEvent?.({ type: "request", request });
      this.onPermissionEvent?.({ type: "deny", request });
      throw new Error(
        `Permission denied for tool: ${tool.name} (plan mode is analysis-only; switch to manual/auto/bypass to execute)`,
      );
    }

    // Manual and auto both use risk assessment, but manual never auto-allows.
    const risk = getRiskLevel(tool, args, mode);
    if (mode === "auto" && risk === "safe" && AUTO_ALLOWED.has(tool.name) && tool.source?.kind !== "mcp") {
      this.onPermissionEvent?.({
        type: "allow",
        request: {
          id: `perm_${randomUUID()}`,
          sessionId,
          tool: tool.name,
          arguments: args,
          risk: "safe",
          source: tool.source,
        },
      });
      return;
    }
    if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    const key = this.key(sessionId, tool, args);
    if (mode === "auto" && this.approved.has(key)) return;
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
      const abort = () => {
        this.pending.delete(request.id);
        cleanup();
        const reason = signal?.reason;
        reject(reason instanceof Error ? reason : Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(request.id, { request, key, revision, resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      onRequest(request);
    });
  }

  resolve(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.sessionId !== sessionId) return false;
    if (pending.revision !== this.revision) return false;
    this.pending.delete(requestId);
    pending.cleanup?.();
    if (decision === "allow") {
      if (this.mode === "auto") this.approved.add(pending.key);
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

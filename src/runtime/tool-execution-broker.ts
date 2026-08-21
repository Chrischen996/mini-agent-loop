import { createHash } from "node:crypto";
import type { PermissionTurnContext } from "../permissions.ts";
import type { Tool, ToolResult, ToolSource } from "../tools/types.ts";
import { createExecutionId } from "./ids.ts";
import {
  NetworkPolicyError,
  PolicyRevisionChangedError,
  ToolPolicyError,
  type RuntimeExecutionContext,
  SandboxPolicyError,
} from "./policy-types.ts";
import { resolveToolCapabilities, stableStringify } from "./tool-types.ts";

export type ToolExecutionAuditEvent = {
  type: "requested" | "started" | "completed" | "failed";
  executionId: string;
  fingerprint: string;
  toolName: string;
  source?: ToolSource;
  capabilities: ReturnType<typeof resolveToolCapabilities>;
  taskId?: string;
  jobId?: string;
  sessionId?: string;
  workspaceId?: string;
  policyRevision?: number;
  timestamp: string;
  durationMs?: number;
  error?: string;
  isErrorResult?: boolean;
};

export type ToolExecutionContext = RuntimeExecutionContext & {
  signal?: AbortSignal;
  permissionTurn?: PermissionTurnContext;
  authorizeTool?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
  beforeExecute?: () => void | Promise<void>;
  onAudit?: (event: ToolExecutionAuditEvent) => void;
};

export type ToolExecutionBrokerOptions = Partial<ToolExecutionContext> & {
  onAudit?: (event: ToolExecutionAuditEvent) => void;
};

export async function executeToolWithBroker(input: {
  broker: ToolExecutionBroker;
  tool: Tool;
  args: Record<string, unknown>;
  runtimeContext?: RuntimeExecutionContext;
  signal?: AbortSignal;
  permissionTurn?: PermissionTurnContext;
  authorizeTool?: ToolExecutionContext["authorizeTool"];
  policyRevision?: number;
  beforeExecute?: ToolExecutionContext["beforeExecute"];
  onAudit?: (event: ToolExecutionAuditEvent) => void;
}): Promise<ToolResult> {
  return input.broker.execute(input.tool, input.args, {
    ...input.runtimeContext,
    signal: input.signal,
    permissionTurn: input.permissionTurn,
    authorizeTool: input.authorizeTool,
    policyRevision: input.policyRevision
      ?? input.permissionTurn?.revision
      ?? input.runtimeContext?.policyRevision,
    beforeExecute: input.beforeExecute,
    ...(input.onAudit ? { onAudit: input.onAudit } : {}),
  });
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "Operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

function sourceForFingerprint(source: ToolSource | undefined): ToolSource {
  return source ?? { kind: "local" };
}

export function createToolExecutionFingerprint(
  tool: Tool,
  args: Record<string, unknown>,
  context: RuntimeExecutionContext = {},
): string {
  const material = stableStringify({
    taskId: context.taskId ?? null,
    workspaceId: context.workspaceId ?? null,
    toolName: tool.name,
    normalizedArguments: args,
    source: sourceForFingerprint(tool.source),
    sandboxMode: context.sandboxMode ?? "preferred",
    networkPolicy: context.network ?? "none",
    policyRevision: context.policyRevision ?? null,
  });
  return `fp_${createHash("sha256").update(material).digest("hex")}`;
}

export class ToolExecutionBroker {
  constructor(private readonly defaults: ToolExecutionBrokerOptions = {}) {}

  async execute(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const execution = { ...this.defaults, ...context };
    const capabilities = resolveToolCapabilities(tool, args);
    const executionId = createExecutionId();
    const startedAt = Date.now();
    const policyRevision = execution.policyRevision ?? execution.permissionTurn?.revision;
    const fingerprint = createToolExecutionFingerprint(tool, args, {
      ...execution,
      policyRevision,
    });
    const audit = (event: Omit<ToolExecutionAuditEvent, "executionId" | "fingerprint" | "toolName" | "source" | "capabilities" | "timestamp">): void => {
      try {
        execution.onAudit?.({
          ...event,
          executionId,
          fingerprint,
          toolName: tool.name,
          source: tool.source,
          capabilities,
          taskId: execution.taskId,
          jobId: execution.jobId,
          sessionId: execution.sessionId,
          workspaceId: execution.workspaceId,
          policyRevision,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Audit sinks must not turn a successful tool call into a failed call.
      }
    };

    try {
      this.assertCurrent(execution, policyRevision, capabilities, tool.name);
      audit({ type: "requested" });

      let result: ToolResult;
      if (execution.permissionTurn) {
        const beforeExecute = async () => {
          audit({ type: "started" });
          await execution.beforeExecute?.();
        };
        result = await execution.permissionTurn.execute(
          tool,
          args,
          execution.signal,
          beforeExecute,
        );
      } else {
        await execution.authorizeTool?.(tool, args, execution.signal);
        this.assertCurrent(execution, policyRevision, capabilities, tool.name);
        await execution.beforeExecute?.();
        this.assertCurrent(execution, policyRevision, capabilities, tool.name);
        audit({ type: "started" });
        result = await tool.execute(args, execution.signal);
      }

      this.assertCurrent(execution, policyRevision, capabilities, tool.name);
      audit({
        type: "completed",
        durationMs: Date.now() - startedAt,
        isErrorResult: result.isError === true,
      });
      return result;
    } catch (error) {
      audit({
        type: "failed",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private assertCurrent(
    context: ToolExecutionContext & ToolExecutionBrokerOptions,
    expectedRevision: number | undefined,
    capabilities: ReturnType<typeof resolveToolCapabilities>,
    toolName: string,
  ): void {
    if (context.signal?.aborted) throw abortError(context.signal.reason);
    context.permissionTurn?.assertCurrent();

    if (context.allowedTools && !context.allowedTools.includes("*")) {
      const allowed = context.allowedTools.some((name) => name === toolName);
      if (!allowed) throw new ToolPolicyError(toolName);
    }

    if (context.network === "none" && capabilities.network) {
      throw new NetworkPolicyError(context.network);
    }

    if (expectedRevision !== undefined && context.getPolicyRevision) {
      const currentRevision = context.getPolicyRevision();
      if (currentRevision !== expectedRevision) {
        throw new PolicyRevisionChangedError(expectedRevision, currentRevision);
      }
    }

    if (
      context.sandboxMode === "required" &&
      (capabilities.executeProcess || capabilities.writeWorkspace) &&
      context.sandboxIsolation !== "secure-sandbox"
    ) {
      throw new SandboxPolicyError(context.sandboxMode, context.sandboxIsolation);
    }
  }
}

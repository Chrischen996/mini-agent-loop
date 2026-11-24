import { createHash } from "node:crypto";
import type { AgentMessage, ToolCall, ToolResultMessage } from "../types.ts";

export type StopReason =
  | "completed"
  | "cancelled"
  | "budget_exhausted"
  | "iteration_limit_reached"
  | "safety_cap_reached"
  | "context_exhausted"
  | "stalled"
  | "waiting_user"
  | "failed";

export type AgentBudgetUsage = {
  tokensUsed: number;
  toolCallsUsed: number;
  writeCallsUsed: number;
  elapsedMs: number;
};

export type AgentRunPolicy = {
  deadlineMs?: number;
  tokenBudget?: number;
  toolCallBudget?: number;
  writeCallBudget?: number;
  maxCompactions?: number;
  stallPolicy?: {
    sameActionLimit?: number;
    noProgressLimit?: number;
  };
  emergencyIterationCap?: number;
};

export const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "delete",
  "mkdir",
  "copy",
  "move",
  "patch",
  "document_edit",
]);

/** Recover allocation usage from the final assistant message after a turn. */
export function budgetUsageFrom(
  messages: AgentMessage[],
  previous?: AgentBudgetUsage,
): AgentBudgetUsage | undefined {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  const usage = last && (last as { usage?: { totalTokens?: number } }).usage;
  const tokensUsed = (previous?.tokensUsed ?? 0) + Math.max(0, Math.floor(usage?.totalTokens ?? 0));
  if (!previous && !usage?.totalTokens) return undefined;
  return {
    tokensUsed,
    toolCallsUsed: previous?.toolCallsUsed ?? 0,
    writeCallsUsed: previous?.writeCallsUsed ?? 0,
    elapsedMs: previous?.elapsedMs ?? 0,
  };
}

export class BudgetTracker {
  tokensUsed: number;
  toolCallsUsed: number;
  writeCallsUsed: number;
  readonly startTime: number;

  constructor(initialUsage?: AgentBudgetUsage) {
    this.tokensUsed = initialUsage?.tokensUsed ?? 0;
    this.toolCallsUsed = initialUsage?.toolCallsUsed ?? 0;
    this.writeCallsUsed = initialUsage?.writeCallsUsed ?? 0;
    this.startTime = Date.now() - (initialUsage?.elapsedMs ?? 0);
  }

  recordToolCall(call: ToolCall): void {
    this.toolCallsUsed += 1;
    if (WRITE_TOOL_NAMES.has(call.name)) {
      this.writeCallsUsed += 1;
    }
  }

  addTokens(count: number): void {
    this.tokensUsed += count;
  }

  getUsage(): AgentBudgetUsage {
    return {
      tokensUsed: this.tokensUsed,
      toolCallsUsed: this.toolCallsUsed,
      writeCallsUsed: this.writeCallsUsed,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  checkBudgets(
    turnNumber: number,
    runPolicy?: AgentRunPolicy,
    activeSignal?: AbortSignal,
    maxEmergencyTurns?: number,
  ): StopReason | undefined {
    if (activeSignal?.aborted) return "cancelled";
    if (runPolicy?.deadlineMs && Date.now() - this.startTime >= runPolicy.deadlineMs) {
      return "budget_exhausted";
    }
    if (runPolicy?.tokenBudget && this.tokensUsed >= runPolicy.tokenBudget) {
      return "budget_exhausted";
    }
    if (runPolicy?.toolCallBudget && this.toolCallsUsed >= runPolicy.toolCallBudget) {
      return "budget_exhausted";
    }
    if (runPolicy?.writeCallBudget && this.writeCallsUsed >= runPolicy.writeCallBudget) {
      return "budget_exhausted";
    }
    // The cap is settled after a completed turn, not before the first model call.
    if (maxEmergencyTurns !== undefined && turnNumber > maxEmergencyTurns + 1) {
      return "safety_cap_reached";
    }
    return undefined;
  }
}

export class StallDetector {
  private readonly sameActionLimit: number;
  private readonly noProgressLimit: number;
  private sameActionCount = 0;
  private consecutiveNoProgressCount = 0;
  lastActionFingerprint = "";

  constructor(private readonly runPolicy?: AgentRunPolicy) {
    this.sameActionLimit = runPolicy?.stallPolicy?.sameActionLimit ?? 3;
    this.noProgressLimit = runPolicy?.stallPolicy?.noProgressLimit ?? 6;
  }

  recordActions(
    calls: ToolCall[],
    processedToolMessages: ToolResultMessage[],
  ): { stalled: boolean; details?: string } {
    // Store a digest so persisted stall fingerprints do not expose tool arguments or output.
    const currentFingerprint = createHash("sha256")
      .update(
        calls
          .map(
            (c, i) =>
              `${c.name}:${JSON.stringify(c.arguments)}:${String(processedToolMessages[i]?.content ?? "").slice(0, 80)}`,
          )
          .join("|"),
      )
      .digest("hex");

    if (currentFingerprint && currentFingerprint === this.lastActionFingerprint) {
      this.sameActionCount += 1;
    } else {
      this.sameActionCount = 0;
      this.lastActionFingerprint = currentFingerprint;
    }

    // Detect progress (e.g. non-error outputs or state updates)
    const hasProgress = processedToolMessages.some((msg) => !msg.isError);
    if (!hasProgress) {
      this.consecutiveNoProgressCount += 1;
    } else {
      this.consecutiveNoProgressCount = 0;
    }

    if (this.runPolicy && this.sameActionCount >= this.sameActionLimit) {
      const details = `Repeated action detected: the same tool, arguments and result occurred ${this.sameActionCount + 1} times; the run is paused to avoid a loop.`;
      return { stalled: true, details };
    }

    if (this.runPolicy && this.consecutiveNoProgressCount >= this.noProgressLimit) {
      const details = `No visible progress was made for ${this.consecutiveNoProgressCount} consecutive turns; the run is paused.`;
      return { stalled: true, details };
    }

    return { stalled: false };
  }
}

// Coordinator-mode state and tool-guarding for the agent loop.
//
// Split out of `loop.ts`: the six coordinator `let` variables plus the
// prompt-injection / exploration-budget-guard logic formed one cohesive block
// inside `runAgentTurnInternal`. The controller owns that state so the main
// turn function no longer carries it as closures.

import type { AgentMessage } from "../types.ts";
import type { LoopEvent } from "../loop.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import {
  buildCoordinatorPromptFragment,
  DEFAULT_MAX_DIRECT_EXPLORATION,
  DELEGATION_TOOL_NAMES,
  EXPLORATION_TOOL_NAMES,
  type AutoSubagentDecision,
} from "../subagent/auto.ts";

export class CoordinatorController {
  private coordinatorActive = false;
  private coordinatorProfile = "researcher";
  private coordinatorPreflightExecuted = false;
  private coordinatorReasons: string[] = [];
  private maxDirectExploration = DEFAULT_MAX_DIRECT_EXPLORATION;
  private directExplorationUsed = 0;

  get active(): boolean {
    return this.coordinatorActive;
  }
  get profile(): string {
    return this.coordinatorProfile;
  }
  get preflightExecuted(): boolean {
    return this.coordinatorPreflightExecuted;
  }

  /** Point the direct-exploration budget at the caller's configured value. */
  setMaxDirectExploration(value: number): void {
    this.maxDirectExploration = value;
  }

  markPreflightExecuted(): void {
    this.coordinatorPreflightExecuted = true;
  }

  /**
   * Activate coordinator mode from an auto-subagent decision: append the
   * guidance fragment to the system prompt and record the decision's profile
   * and reasons. No-op when the decision is not in coordinator mode.
   */
  injectPrompt(
    decision: AutoSubagentDecision,
    preflightExecuted: boolean,
    messages: AgentMessage[],
    onEvent: ((event: LoopEvent) => void) | undefined,
  ): void {
    if (!decision.coordinatorMode) return;
    const fragment = buildCoordinatorPromptFragment({
      profile: decision.profile,
      preflightExecuted,
      maxDirectExploration: this.maxDirectExploration,
    });
    const systemMsg = messages.find((message) => message.role === "system");
    if (systemMsg && typeof systemMsg.content === "string" && !systemMsg.content.includes("### Coordinator Mode")) {
      systemMsg.content = `${systemMsg.content}\n\n${fragment}`;
    }
    this.coordinatorActive = true;
    this.coordinatorProfile = decision.profile;
    this.coordinatorPreflightExecuted = preflightExecuted;
    this.coordinatorReasons = decision.reasons;
    this.emit(onEvent, preflightExecuted);
  }

  /** Refresh the coordinator system-prompt fragment after preflight has run. */
  refreshPrompt(
    decision: AutoSubagentDecision,
    messages: AgentMessage[],
    onEvent: ((event: LoopEvent) => void) | undefined,
  ): void {
    if (!decision.coordinatorMode) return;
    const systemMsg = messages.find((message) => message.role === "system");
    if (systemMsg && typeof systemMsg.content === "string") {
      const fragment = buildCoordinatorPromptFragment({
        profile: decision.profile,
        preflightExecuted: true,
        maxDirectExploration: this.maxDirectExploration,
      });
      systemMsg.content = systemMsg.content.includes("### Coordinator Mode")
        ? systemMsg.content.replace(/### Coordinator Mode[\s\S]*$/, fragment)
        : `${systemMsg.content}\n\n${fragment}`;
    }
    this.emit(onEvent, true);
  }

  /**
   * Guard a tool call under coordinator mode. Returns a `blocked` result when
   * the direct-exploration budget is exhausted (the exploration tool is
   * refused so the model delegates instead); otherwise records the budget /
   * delegation bookkeeping and returns an empty guard.
   */
  guardToolCall(
    tool: Tool,
    onEvent: ((event: LoopEvent) => void) | undefined,
  ): { blocked?: ToolResult } {
    if (!this.coordinatorActive) return {};
    if (EXPLORATION_TOOL_NAMES.has(tool.name)) {
      if (this.directExplorationUsed >= this.maxDirectExploration) {
        return {
          blocked: {
            content: [
              `Coordinator mode blocked direct exploration tool \`${tool.name}\`.`,
              `Budget exhausted (${this.directExplorationUsed}/${this.maxDirectExploration}).`,
              "Use `subagent` or `subagent_batch` for deeper exploration/implementation, then synthesize the results.",
              `Suggested profile: ${this.coordinatorProfile}.`,
            ].join(" "),
            isError: true,
          },
        };
      }
      this.directExplorationUsed += 1;
      this.emit(onEvent, this.coordinatorPreflightExecuted);
    } else if (DELEGATION_TOOL_NAMES.has(tool.name)) {
      // Successful delegation is the intended path; keep mode active for later turns.
      this.emit(onEvent, this.coordinatorPreflightExecuted, [
        ...this.coordinatorReasons,
        `delegated via ${tool.name}`,
      ]);
    }
    return {};
  }

  private emit(
    onEvent: ((event: LoopEvent) => void) | undefined,
    preflightExecuted: boolean,
    reasons: string[] = this.coordinatorReasons,
  ): void {
    onEvent?.({
      type: "coordinator_mode",
      active: true,
      profile: this.coordinatorProfile,
      preflightExecuted,
      maxDirectExploration: this.maxDirectExploration,
      directExplorationUsed: this.directExplorationUsed,
      reasons,
    });
  }
}

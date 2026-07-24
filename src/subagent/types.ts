/**
 * Subagent type definitions.
 *
 * A subagent is an independent, nested agent loop that the parent agent
 * can spawn as a tool call.  It has its own system prompt, tool set,
 * message history, and turn budget — completely isolated from the parent
 * context.
 */

import type { LoopEvent } from "../loop.ts";
import type { ChatFn, LlmConfig } from "../llm/index.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";

// ─── Subagent configuration ─────────────────────────────────────────────────

/**
 * Static configuration for a named subagent profile.
 *
 * Profiles let the orchestrating agent pick a pre-defined specialist
 * (e.g. "researcher", "coder", "reviewer") instead of configuring
 * everything from scratch in every tool call.
 */
export type SubagentProfile = {
  /** Unique name the parent agent uses to reference this profile. */
  name: string;
  /** Human-readable description shown to the parent LLM. */
  description: string;
  /** System prompt for the subagent. */
  systemPrompt: string;
  /**
   * Tool names the subagent is allowed to use.
   * Omit to inherit all tools from the parent (minus `subagent` itself to
   * prevent infinite recursion unless explicitly allowed).
   */
  allowedTools?: string[];
  /** Max turns before the subagent is force-stopped.  Default: 5. */
  maxTurns?: number;
  /**
   * Timeout in milliseconds for the subagent execution.
   * When exceeded, the subagent is aborted and an error is returned.
   * Omit for no timeout (only maxTurns applies).
   */
  timeout?: number;
  /**
   * Optional separate LLM config for the subagent.
   * When omitted, inherits the parent's current LLM config.
   */
  llm?: LlmConfig;
};

// ─── Runtime options passed when creating the subagent tool ──────────────────

export type SubagentToolOptions = {
  /** LLM config the subagent inherits when no profile overrides it. */
  parentLlm: LlmConfig;
  /** Full tool set available to the parent; subagent picks a subset. */
  parentTools: ToolProvider;
  /** Pre-defined subagent profiles. */
  profiles?: SubagentProfile[];
  /** Preprocessors inherited by the subagent. */
  preprocessors?: MessagePreprocessor[];
  /** Cancellation signal propagated to the subagent. */
  signal?: AbortSignal;
  /**
   * Maximum nesting depth (number of subagent levels).
   * Prevents infinite recursion.  Default: 3.
   */
  maxDepth?: number;
  /** Current nesting depth.  Managed internally; callers leave at 0. */
  currentDepth?: number;
  /** Callback to propagate subagent events to the parent. */
  onSubagentEvent?: (event: SubagentEvent) => void;
  /** Inject a faux chat function for offline tests. */
  chat?: ChatFn;
};

// ─── Tool call arguments (what the LLM sends) ───────────────────────────────

export type SubagentArgs = {
  /** The task / prompt to send to the subagent. */
  task: string;
  /**
   * Name of a pre-defined profile to use.
   * When omitted, `systemPrompt` / `tools` / `maxTurns` can be set ad-hoc.
   */
  profile?: string;
  /** Ad-hoc system prompt (ignored when a profile is selected). */
  systemPrompt?: string;
  /** Ad-hoc tool whitelist (ignored when a profile is selected). */
  tools?: string[];
  /** Ad-hoc max turns (overrides profile default). */
  maxTurns?: number;
};

// ─── Subagent-specific events ────────────────────────────────────────────────

export type SubagentEvent =
  | {
      type: "subagent_start";
      /** Unique id for this subagent invocation. */
      id: string;
      task: string;
      profile?: string;
      depth: number;
    }
  | {
      type: "subagent_event";
      /** Same id as the matching subagent_start. */
      id: string;
      /** The inner loop event. */
      inner: LoopEvent;
      depth: number;
    }
  | {
      type: "subagent_end";
      id: string;
      /** Final text answer from the subagent (empty on error / abort). */
      result: string;
      /** Whether the subagent finished normally. */
      success: boolean;
      depth: number;
      turns: number;
      /** Cumulative token usage across all turns (0 when unavailable). */
      totalTokens: number;
    };

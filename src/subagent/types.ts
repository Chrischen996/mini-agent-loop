/**
 * Subagent type definitions.
 *
 * A subagent is an independent, nested agent loop that the parent agent
 * can spawn as a tool call.  It has its own system prompt, tool set,
 * message history, and turn budget — completely isolated from the parent
 * context.
 */

import type { AgentRuntimeRef, LoopEvent } from "../loop.ts";
import type { ChatFn, LlmConfig } from "../llm/index.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";
import type { PermissionMode, PermissionTurnContext } from "../permissions.ts";
import type { Tool } from "../tools/types.ts";
import type { ThinkingMode } from "../thinking-policy.ts";
import type { AgentMessage } from "../types.ts";

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
  /**
   * Thinking mode for the subagent loop. Defaults to "fixed".
   * "adaptive" enables explainable effort escalation after tool failures.
   */
  thinkingMode?: ThinkingMode;
  /**
   * Maximum adaptive effort increases after tool or validation failures.
   * Default: 2. Only used when thinkingMode is "adaptive".
   */
  maxThinkingEscalations?: number;
  /** Optional token budget limit for this profile. */
  tokenBudget?: number;
};

// ─── Runtime options passed when creating the subagent tool ──────────────────

export type SubagentToolOptions = {
  /** LLM config the subagent inherits when no profile overrides it. */
  parentLlm: LlmConfig;
  /**
   * Timeout in milliseconds for subagent execution.
   * Profile-level timeout takes precedence when both are set.
   */
  timeout?: number;
  /**
   * Parent's thinking mode, inherited by child subagents that don't
   * explicitly override it via args or profile.
   */
  thinkingMode?: ThinkingMode;
  /**
   * Parent's max adaptive escalation count, inherited by child subagents
   * that don't explicitly override it via args or profile.
   */
  maxThinkingEscalations?: number;
  /**
   * Optional callback to retrieve the parent's current message history.
   * Used when the subagent args request `inheritContextHistory: true`.
   */
  getParentHistory?: () => import("../types.ts").AgentMessage[] | undefined;
  /**
   * Global token budget shared across all subagents (parent + children).
   * When set, each subagent checks against the budget before running.
   */
  globalTokenBudget?: number;
  /** Internal shared state used by nested subagents and batch siblings. */
  globalBudgetState?: { used: number; limit: number };
  /**
   * Callback to deduct tokens from the global budget and check limits.
   * Called with accumulated tokens after each assistant event.
   */
  checkGlobalBudget?: (tokens: number) => void;
  /**
   * Maximum concurrent subagents across all batches (global limit).
   * 0 or undefined means no global limit.
   */
  globalConcurrencyLimit?: number;
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
  /** Permission mode inherited from the parent execution path. */
  permissionMode?: PermissionMode;
  /** Shared immutable permission snapshot for the current parent turn. */
  permissionTurn?: PermissionTurnContext;
  /** Resolve the current parent turn while the tool is reused across turns. */
  getPermissionTurn?: () => PermissionTurnContext | undefined;
  /** Mutable parent runtime updated by the shared agent loop. */
  parentRuntime?: AgentRuntimeRef;
  /** @deprecated Use permissionTurn/getPermissionTurn. */
  getPermissionMode?: () => PermissionMode;
  /** @deprecated Use permissionTurn/getPermissionTurn. */
  authorizeTool?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
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
  /**
   * Model identifier for this subagent (e.g. "openai/gpt-4o-mini").
   * When set, overrides both profile.llm and parent LLM config.
   */
  model?: string;
  /**
   * Context string shared from the parent agent.
   * Prepended to the subagent's system prompt as background knowledge.
   */
  sharedContext?: string;
  /**
   * Thinking mode for the subagent loop. Overrides profile default.
   * "adaptive" enables explainable effort escalation after failures.
   */
  thinkingMode?: ThinkingMode;
  /**
   * Maximum adaptive effort increases after tool or validation failures.
   * Only meaningful when thinkingMode is "adaptive".
   */
  maxThinkingEscalations?: number;
  /**
   * Optional context compaction policy inherited from the parent.
   * Controls how messages are compressed for long-running sessions.
   */
  contextPolicy?: import("../context.ts").ContextManagerOptions;
  /**
   * Skill names to activate for this subagent loop.
   * Skills contribute system prompt fragments, tools, and preprocessors.
   */
  skillNames?: string[];
  /**
   * Whether to inherit the parent's message history (for session continuity).
   * Default: false — subagent starts with a fresh context.
   */
  inheritContextHistory?: boolean;
  /**
   * Optional parent message history to pass to the subagent when
   * `inheritContextHistory` is true. Used internally by the subagent tool.
   */
  _parentHistory?: AgentMessage[];
  /** Optional token budget limit for this specific subagent call. */
  tokenBudget?: number;
};

// ─── Parallel subagent batch arguments ───────────────────────────────────────

/**
 * A single task within a parallel batch.
 */
export type SubagentBatchTask = {
  /** Unique label for this task within the batch. */
  label: string;
  /** The task / prompt for this subagent. */
  task: string;
  /** Profile name to use. */
  profile?: string;
  /** Model override for this specific task. */
  model?: string;
  /** Max turns override. */
  maxTurns?: number;
  /** Shared context for this task. */
  sharedContext?: string;
  /** Thinking mode override. */
  thinkingMode?: ThinkingMode;
  /** Max adaptive escalation override. */
  maxThinkingEscalations?: number;
  /** Context compaction policy override. */
  contextPolicy?: import("../context.ts").ContextManagerOptions;
  /** Skill names override. */
  skillNames?: string[];
  /** Whether to inherit the parent's current message history. */
  inheritContextHistory?: boolean;
  /** Optional token budget limit for this specific batch task. */
  tokenBudget?: number;
};

/**
 * Arguments for the `subagent_batch` tool — runs multiple subagents in parallel.
 */
export type SubagentBatchArgs = {
  /** Array of tasks to run in parallel. */
  tasks: SubagentBatchTask[];
  /**
   * Maximum concurrent subagents. When undefined or 0, all tasks run
   * concurrently (original behavior). When set, batches are processed
   * with the specified concurrency limit.
   */
  maxConcurrency?: number;
};

// ─── Subagent-specific events ────────────────────────────────────────────────

/**
 * Metadata about the resolved LLM config for observability.
 */
export type SubagentRuntimeInfo = {
  /** The model identifier actually used (may differ from requested on fallback). */
  model: string;
  /** Provider name (e.g. "openai", "anthropic", "faux"). */
  provider: string;
  /** Base URL for API requests. */
  baseUrl: string;
  /** The thinking mode in effect ("fixed" | "adaptive"). */
  thinkingMode: ThinkingMode;
  /** The thinking level applied to the model (e.g. "off", "low", "medium", ...). */
  thinkingLevel?: import("../pi-ai/types.ts").ModelThinkingLevel;
  /** Whether the requested model was resolved successfully. */
  modelSwitchSucceeded: boolean;
  /** The originally requested model (empty if none was requested). */
  requestedModel?: string;
};

export type SubagentTokenBreakdown = {
  promptTokens: number;
  inputTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type SubagentCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SubagentEvent =
  | {
      type: "subagent_start";
      /** Unique id for this subagent invocation. */
      id: string;
      task: string;
      profile?: string;
      depth: number;
      /** Runtime info about the resolved LLM configuration. */
      runtime: SubagentRuntimeInfo;
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
      /** Detailed token breakdown across prompt, input, completion, cache. */
      tokenBreakdown?: SubagentTokenBreakdown;
      /** Estimated monetary cost in USD based on model rates. */
      estimatedCost?: SubagentCost;
      /** Runtime info recorded at subagent start (for observability). */
      runtime: SubagentRuntimeInfo;
      /** Any errors encountered during execution. */
      errors?: Array<{ message: string; kind: "timeout" | "api" | "compaction" | "max_turns" | "abort" }>;
      /** Whether auto-delegation was inherited from the parent (false = deliberate isolation). */
      autoDelegationInherited: boolean;
    };

import { randomUUID } from "node:crypto";
import { contentAsString } from "./content.ts";
import {
  compactHistory,
  estimateContextTokens,
  type ContextManagerOptions,
} from "./context.ts";
import {
  runAutocompact,
  applyToolResultBudget,
} from "./compaction/index.ts";
import {
  PermissionModeChangedError,
  type PermissionMode,
  type PermissionRequest,
  type PermissionTurnContext,
} from "./permissions.ts";
import {
  completeChat,
  LlmRetryCoordinator,
  waitForRetry,
  isAbortError,
  isContextOverflowError,
  streamChat,
  streamLlmEvents,
  type ChatFn,
  IncompleteLlmResponseError,
  type LlmConfig,
  type RetryableErrorType,
  type StreamChatUsage,
  LlmTimeoutError,
  StreamTruncatedError,
  ThinkingCapabilityError,
} from "./llm/index.ts";
import { resolveModel } from "./models.ts";
import {
  buildIntenseLlm,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  supportsThinkingOff,
  withThinkingLevel,
} from "./think-intensity.ts";
import {
  decideInitialThinkingLevel,
  decideNextThinkingLevel,
  type ThinkingMode,
  type ThinkingPolicyDecision,
} from "./thinking-policy.ts";
import type { MessagePreprocessor } from "./preprocessors/index.ts";
import {
  buildCoordinatorPromptFragment,
  decideAutoSubagent,
  DEFAULT_MAX_DIRECT_EXPLORATION,
  DELEGATION_TOOL_NAMES,
  EXPLORATION_TOOL_NAMES,
  type AutoSubagentDecision,
  type AutoSubagentOptions,
} from "./subagent/auto.ts";
import { resolveToolProvider, type Tool, type ToolProvider, type ToolResult } from "./tools/types.ts";
import { nextTodoRevision, type TodoItem } from "./todo.ts";
import type { SubagentEvent } from "./subagent/types.ts";
import type {
  AgentMessage,
  AssistantMessage,
  MessageContent,
  ToolCall,
  ToolResultMessage,
} from "./types.ts";
import { validateToolArgs } from "./validate.ts";
import type { Skill, SkillRegistry } from "./skills/types.ts";
import { defaultSkillRegistry } from "./skills/registry.ts";
import { resolveActiveSkills, applySkillPromptFragments, runSkillHooks } from "./loop/skill-resolution.ts";
import { executeTurnTools } from "./loop/tool-execution.ts";
import { loadAgentsMd } from "./agents-md.ts";
import { formatValidationReport, runValidation } from "./validation.ts";
import { GitWorkflow } from "./git/workflow.ts";
import type { SessionPhase, ExecutionPlan, PlanActEvent } from "./plan-act/types.ts";
import { planManager } from "./plan-act/plan-manager.ts";
import { planGenerator } from "./plan-act/plan-generator.ts";
import { validatePhaseTransition, isTerminalPhase } from "./plan-act/state-machine.ts";
import {
  ToolExecutionBroker,
  executeToolWithBroker,
  type ToolExecutionAuditEvent,
} from "./runtime/tool-execution-broker.ts";
import type { RuntimeExecutionContext } from "./runtime/policy-types.ts";
import type { PauseGate } from "./orchestration/pause-gate.ts";
import type { GoalRuntimeController } from "./goal/runtime.ts";

export type NextTurnUpdate = {
  llm?: LlmConfig;
  context?: ContextManagerOptions;
};

import {
  type StopReason,
  type AgentBudgetUsage,
  type AgentRunPolicy,
  budgetUsageFrom,
  BudgetTracker,
  StallDetector,
  WRITE_TOOL_NAMES,
} from "./loop/stall-policy.ts";

export {
  type StopReason,
  type AgentBudgetUsage,
  type AgentRunPolicy,
  budgetUsageFrom,
  BudgetTracker,
  StallDetector,
  WRITE_TOOL_NAMES,
};

import {
  PERMISSION_MODE_MARKER,
  MODE_SUFFIX,
  PHASE_SUFFIX,
  applyPermissionModePrompt,
  applyPhasePrompt,
  compactRepositoryInstructions,
  buildSystemPrompt,
  createAgentHistory,
  restoreAgentHistory,
  getDefaultSystemPrompt,
  inheritHistoryWithPrompt,
  MAX_REPOSITORY_INSTRUCTIONS_CHARS,
  MAX_MEMORY_SECTION_CHARS,
  MAX_HISTORY_MESSAGES,
  capHistory,
} from "./loop/prompt.ts";

export {
  PERMISSION_MODE_MARKER,
  MODE_SUFFIX,
  PHASE_SUFFIX,
  applyPermissionModePrompt,
  applyPhasePrompt,
  compactRepositoryInstructions,
  buildSystemPrompt,
  createAgentHistory,
  restoreAgentHistory,
  getDefaultSystemPrompt,
  inheritHistoryWithPrompt,
  MAX_REPOSITORY_INSTRUCTIONS_CHARS,
  MAX_MEMORY_SECTION_CHARS,
  MAX_HISTORY_MESSAGES,
  capHistory,
};

export class RunStoppedError extends Error {
  readonly messages: AgentMessage[];
  readonly stopReason: StopReason;
  readonly details?: string;
  readonly budgetUsage?: AgentBudgetUsage;

  constructor(messages: AgentMessage[], stopReason: StopReason, details?: string, budgetUsage?: AgentBudgetUsage) {
    super(details ?? `Run stopped: ${stopReason}`);
    this.name = "RunStoppedError";
    this.messages = messages;
    this.stopReason = stopReason;
    this.details = details;
    this.budgetUsage = budgetUsage;
  }
}

/** Compatibility error used by callers that translate bounded loop blocks. */
export class MaxTurnsExceededError extends Error {
  readonly messages: AgentMessage[];
  readonly maxTurns: number;

  constructor(messages: AgentMessage[], maxTurns: number) {
    super(`maxTurns exceeded (${maxTurns})`);
    this.name = "MaxTurnsExceededError";
    this.messages = messages;
    this.maxTurns = maxTurns;
  }
}

function formatLlmIdentity(config: Pick<LlmConfig, "provider" | "model">): string {
  const provider = config.provider.trim();
  const model = config.model.trim();
  if (!provider) return model;
  return model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? model
    : `${provider}/${model}`;
}

export type TurnContext = {
  turn: number;
  currentLlm: LlmConfig;
  assistantMessage: AssistantMessage;
  toolResults: ToolResultMessage[];
  messages: AgentMessage[];
};

export type CheckpointReason =
  | "user_input"
  | "before_tool"
  | "tool_result"
  | "context_compacted"
  | "completed"
  | "paused"
  | "interrupted"
  | "failed";

export type CheckpointContext = {
  reason: CheckpointReason;
  messages: AgentMessage[];
  turn?: number;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  stopReason?: StopReason;
  details?: string;
  budgetUsage?: AgentBudgetUsage;
  lastFingerprint?: string;
};

export type AgentLoopOptions = {
  llm: LlmConfig;
  tools: ToolProvider;
  /**
   * Optional code-level preflight delegation and parent coordinator policy.
   * Entrypoints enable this by default via env; programmatic callers may omit it
   * to keep pure LLM-only tool choice.
   */
  autoSubagent?: AutoSubagentOptions;
  systemPrompt?: string;
  /**
   * Optional safety-cap override when no policy or server block cap is set.
   * 0 disables the cap.
   * Stopping emits `run_stopped` / `safety_cap_reached`, not a separate turn counter.
   */
  maxTurns?: number;
  /** Optional total token budget shared by this loop and nested subagents. */
  globalTokenBudget?: number;
  /** Inject a faux model in tests. */
  chat?: ChatFn;
  onEvent?: (event: LoopEvent) => void;
  /** Provider-neutral message transforms, applied to new message batches. */
  preprocessors?: MessagePreprocessor[];
  /**
   * Optional rich user content (text + images).
   * When set, used instead of plain userText string for the user message.
   */
  userContent?: MessageContent;
  /** Optional cancellation signal for the whole turn. */
  signal?: AbortSignal;
  /** Messages sent to a running background task, consumed between turns. */
  getPendingUserMessages?: () => Promise<string[]>;
  /** Cooperative pause gate used by background orchestration jobs. */
  pauseGate?: PauseGate;
  /** Shared runtime identity and policy snapshot for tool execution. */
  runtimeContext?: RuntimeExecutionContext;
  /** Injectable execution boundary used by the loop and nested callers. */
  toolExecutionBroker?: ToolExecutionBroker;
  /** Optional audit sink for every tool execution attempt. */
  onToolExecutionAudit?: (event: ToolExecutionAuditEvent) => void;
  /** Context compaction settings for long-running sessions. */
  context?: ContextManagerOptions;
  authorizeTool?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
  /** Immutable permission snapshot shared by the whole turn. */
  permissionTurn?: PermissionTurnContext;
  prepareNextTurn?: (context: TurnContext) => NextTurnUpdate | void | Promise<NextTurnUpdate | void>;
  /**
   * When true, independent tool calls from a single assistant response
   * execute in parallel via Promise.all. Default: false (serial).
   */
  parallelToolExecution?: boolean;
  /** Automatically run test/typecheck/build after a write-like tool call. */
  autoValidate?: boolean;
  validationWorkspace?: string;
  autoCheckpoint?: boolean;
  /** Fixed respects explicit/default effort; adaptive applies an explainable task policy. */
  thinkingMode?: ThinkingMode;
  /** Maximum adaptive effort increases after tool or validation failures. Default: 2. */
  maxThinkingEscalations?: number;
  /**
   * Mutable runtime snapshot exposed to nested tools during this loop.
   * The loop updates it as model, thinking policy, and history change.
   */
  runtimeRef?: AgentRuntimeRef;
  /**
   * Permission mode for the session. When "plan", write tools are blocked
   * and the agent is informed to output a plan instead of executing directly.
   */
  permissionMode?: PermissionMode;
  /**
   * Skills to activate for this loop/turn.
   * Skills can contribute system prompt fragments, tools, and preprocessors.
   */
  skills?: Skill[];
  /**
   * Skill names to resolve from the registry.
   */
  skillNames?: string[];
  /**
   * Skill registry to use for name resolution.
   * Defaults to the global defaultSkillRegistry.
   */
  skillRegistry?: SkillRegistry;
  /**
   * Optional parent message history to pass when `inheritContextHistory`
   * is requested by the subagent caller. Used internally; not exposed
   * in the public tool args schema.
   */
  _parentHistory?: AgentMessage[];
  /**
   * Seed history for resumed sessions (Claude Code-style resume). When set,
   * the loop starts from these messages instead of an empty history; the
   * system prompt is (re)built and placed at position 0.
   */
  initialMessages?: AgentMessage[];
  /** Persistent memory section to inject into the system prompt. */
  memorySection?: string;
  /** Optional agents.md content to inject into system prompt. */
  agentsMd?: string;
  /** Current Plan-Act workflow phase. */
  sessionPhase?: import('./plan-act/types.js').SessionPhase;
  /** Callback for plan-related events. */
  onPlanEvent?: (event: import('./plan-act/types.js').PlanActEvent) => void;
  /** Awaitable checkpoint callback for reliable step-by-step persistence. */
  onCheckpoint?: (context: CheckpointContext) => Promise<void>;
  /** When true, runs in explicit continuation mode without appending a duplicate prompt. */
  isContinuation?: boolean;
  /** Optional policy-driven execution rules (replaces fixed maxTurns). */
  runPolicy?: AgentRunPolicy;
  /**
   * Server block bound. The loop returns after this many model turns
   * instead of emitting safety_cap_reached, so the caller can continue.
   */
  blockTurns?: number;
  /** Usage already charged to this allocation when resuming its remaining budget. */
  initialBudgetUsage?: AgentBudgetUsage;
  /**
   * Optional goal runtime. When provided, goal steering is injected before
   * each model call and per-response token usage is charged to the goal.
   */
  goalRuntime?: GoalRuntimeController;
};

/**
 * Shared budget state between a parent loop and all nested subagents.
 * A token budget and a subagent call budget can each be enabled
 * independently (Grok Build-style `agent_budget`: a cap on child-agent
 * invocations, checked per panel before launch).
 */
export type GlobalBudgetState = {
  /** Total tokens consumed by this loop and its nested subagents. */
  used: number;
  /** Token ceiling. Undefined when only a call budget is configured. */
  limit?: number;
  /** Subagent invocations consumed against the shared call budget. */
  callsUsed?: number;
  /** Hard cap on total subagent invocations (all depths, all batches). */
  callsLimit?: number;
  /** Optional cross-process usage ledger used by detached workers. */
  tokenLedger?: {
    readTokens(): Promise<number>;
    consumeTokens(delta: number): Promise<number>;
  };
  /** Namespace shared by cross-process budget and concurrency ledgers. */
  scopeId?: string;
  callLedger?: {
    readCalls(): Promise<number>;
    reserveCalls(count: number, limit: number): Promise<number | undefined>;
  };
};

export type AgentRuntimeRef = {
  llm?: LlmConfig;
  history?: AgentMessage[];
  thinkingMode?: ThinkingMode;
  maxThinkingEscalations?: number;
  context?: ContextManagerOptions;
  /** Currently resolved skill names for this loop, inherited by nested subagents. */
  skillNames?: string[];
  /** Execution policy and broker shared with nested tool boundaries. */
  executionContext?: RuntimeExecutionContext;
  toolExecutionBroker?: ToolExecutionBroker;
  onToolExecutionAudit?: (event: ToolExecutionAuditEvent) => void;
  /** Shared budget state, when the caller enables a global budget. */
  globalBudgetState?: GlobalBudgetState;
};

export type LoopEvent =
  | { type: "assistant_delta"; text: string; kind: "reasoning" | "answer" }
  /**
   * Coalesced streaming update emitted by TurnEventBuffer.flush(): at most
   * one reasoning chunk and one answer chunk per flush, so consumers apply
   * both in a single state update instead of one update per raw delta.
   */
  | { type: "assistant_deltas"; reasoning?: string; answer?: string }
  | { type: "context_compacted"; beforeTokens: number; afterTokens: number; reason: string }
  | { type: "assistant"; message: AssistantMessage; usage?: StreamChatUsage }
  | { type: "error"; message: string }
  | { type: "max_turns"; maxTurns: number; messages: AgentMessage[] }
  | {
      type: "run_stopped";
      stopReason: StopReason;
      details?: string;
      message?: string;
      budgetUsage?: AgentBudgetUsage;
      cumulativeBudgetUsage?: AgentBudgetUsage;
      budgetPolicy?: AgentRunPolicy;
      messages: AgentMessage[];
    }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "todo_updated"; todos: TodoItem[]; revision: number }
  | { type: "goal_updated"; goal: import("./goal/types.ts").GoalSnapshot | null; reason: string }
  | {
      type: "auto_subagent";
      shouldDelegate: boolean;
      executed: boolean;
      coordinatorMode: boolean;
      score: number;
      reasons: string[];
      profile: string;
    }
  | {
      type: "coordinator_mode";
      active: boolean;
      profile: string;
      preflightExecuted: boolean;
      maxDirectExploration: number;
      directExplorationUsed: number;
      reasons: string[];
    }
  | {
      type: "thinking_policy";
      mode: "adaptive";
      phase: "initial" | "escalation";
      previousLevel?: import("./pi-ai/types.ts").ModelThinkingLevel;
      level: import("./pi-ai/types.ts").ModelThinkingLevel;
      score: number;
      reasons: string[];
    }
  | {
      type: "aborted";
      messages: AgentMessage[];
      reason?: "permission_mode_changed";
      previousMode?: PermissionMode;
      permissionMode?: PermissionMode;
    }
  | { type: "permission_required"; request: PermissionRequest }
  | { type: "plan_act_event"; event: PlanActEvent }
  | { type: "done"; messages: AgentMessage[] }
  | { type: "attempt_reset"; reason: "reasoning_only" | "stream_truncated"; attempt: number }
  | {
      type: "model_switched";
      previousModel: string;
      nextModel: string;
      turn: number;
    }
  | {
      type: "retry_attempt";
      errorType: RetryableErrorType;
      attempt: number;
      maxRetries: number;
      delayMs: number;
      errorMessage: string;
    }
  | SubagentEvent;

function emitAborted(
  onEvent: ((event: LoopEvent) => void) | undefined,
  messages: AgentMessage[],
  permissionTurn?: PermissionTurnContext,
): void {
  const reason = permissionTurn?.signal.reason;
  if (reason instanceof PermissionModeChangedError) {
    onEvent?.({
      type: "aborted",
      messages,
      reason: "permission_mode_changed",
      previousMode: reason.previousMode,
      permissionMode: reason.mode,
    });
    return;
  }
  onEvent?.({ type: "aborted", messages });
}

function mergeLoopSignals(...signals: (AbortSignal | undefined)[]): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const active = [...new Set(
    signals.filter((value): value is AbortSignal => Boolean(value)),
  )];
  if (active.length === 0) return { cleanup: () => {} };
  if (active.length === 1) return { signal: active[0], cleanup: () => {} };
  return { signal: AbortSignal.any(active), cleanup: () => {} };
}

const MAX_EMPTY_ASSISTANT_RESPONSES = 2;

export type AgentTurnOptions = Omit<AgentLoopOptions, "systemPrompt">;

async function applyPreprocessors(
  batch: AgentMessage[],
  preprocessors: MessagePreprocessor[],
  context: Parameters<MessagePreprocessor["process"]>[1],
): Promise<AgentMessage[]> {
  let current = batch;
  for (const preprocessor of preprocessors) {
    current = await preprocessor.process(current, context);
  }
  return current;
}

function compactForModel(
  messages: AgentMessage[],
  llm: LlmConfig,
  tools: Tool[],
  context: ContextManagerOptions | undefined,
  autocompactState: { consecutiveFailures?: number },
  force = false,
): AgentMessage[] {
  const reserveTokens = Math.max(1, Math.min(context?.reserveTokens ?? llm.maxTokens, llm.contextWindow - 1));
  const budget = Math.max(1, llm.contextWindow - reserveTokens);

  // ── Layer 1: tool-result budget + token-threshold compaction ────────────
  const autocompact = runAutocompact(messages, tools, {
    contextWindow: llm.contextWindow,
    maxOutputTokens: llm.maxTokens,
    budgetTokens: budget,
    keepRecentMessages: context?.keepRecentMessages,
  }, autocompactState);
  autocompactState.consecutiveFailures = autocompact.consecutiveFailures;
  if (!force && autocompact.compacted && autocompact.messages !== messages) {
    return autocompact.messages;
  }

  const currentTokens = estimateContextTokens(autocompact.messages, tools);
  if (!force && currentTokens <= budget) return autocompact.messages;

  // ── Layer 2: destructive compaction (last resort / forced) ────────────────
  // `force` is set when the provider already rejected the request for overflow;
  // there is no choice but to summarize, regardless of budget headroom.
  const toolTokens = estimateContextTokens([], tools);
  const compacted = compactHistory(autocompact.messages, {
    ...context,
    force,
    maxTokens: Math.max(1, budget - toolTokens),
    keepRecentMessages: force ? 2 : context?.keepRecentMessages,
  });
  return compacted;
}


/** Maximum characters for a single tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 32_000;

/**
 * Truncate tool result content that exceeds MAX_TOOL_RESULT_CHARS.
 * Keeps the first 60% and last 40% of the content with a truncation notice
 * in between, so the LLM still sees the beginning and end of the output.
 */
function truncateToolResult(content: string): string;
function truncateToolResult(content: MessageContent): MessageContent;
function truncateToolResult(content: MessageContent): MessageContent {
  if (typeof content !== "string") return content;
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  const headSize = Math.floor(MAX_TOOL_RESULT_CHARS * 0.6);
  const tailSize = MAX_TOOL_RESULT_CHARS - headSize;
  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  const omitted = content.length - headSize - tailSize;

  return `${head}\n\n[... ${omitted.toLocaleString()} characters omitted ...]\n\n${tail}`;
}

export async function runAgentLoop(
  userText: string,
  options: AgentLoopOptions,
): Promise<AgentMessage[]> {
  const { systemPrompt, permissionMode, permissionTurn, initialMessages, memorySection, ...turnOptions } = options;
  const activePermissionMode = permissionTurn?.mode ?? permissionMode;
  const prompt =
    systemPrompt ??
    buildSystemPrompt(activePermissionMode, turnOptions.agentsMd, memorySection);
  let history: AgentMessage[];
  if (turnOptions._parentHistory) {
    history = inheritHistoryWithPrompt(turnOptions._parentHistory, prompt);
  } else if (initialMessages && initialMessages.length > 0) {
    // Resumed session: rebuild the base prompt while retaining transcript
    // system messages such as compacted conversation summaries.
    history = restoreAgentHistory(initialMessages, prompt);
  } else {
    history = createAgentHistory(prompt, activePermissionMode);
  }
  return runAgentTurn(
    history,
    userText,
    { ...turnOptions, permissionMode: activePermissionMode, permissionTurn },
  );
}

export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  options: AgentTurnOptions,
): Promise<AgentMessage[]> {
  const merged = mergeLoopSignals(options.permissionTurn?.signal, options.signal);
  try {
    const result = await runAgentTurnInternal(history, userText, {
      ...options,
      signal: merged.signal,
    });
    const runtime = options.goalRuntime;
    if (!runtime) return result;
    await runtime.finish();
    // Continuations keep the caller's allocation usage so policy budgets
    // (token/time/tool caps) stay authoritative across the whole submission.
    const initialBudgetUsage = options.initialBudgetUsage;
    let current = result;
    let continuationUsage = budgetUsageFrom(result, initialBudgetUsage);
    while (true) {
      const continuation = await runtime.shouldContinue();
      if (!continuation) return current;
      // Goal continuations reuse the same history and do not append a duplicate
      // user prompt; steering is injected by the runtime before the model call.
      current = await runAgentTurnInternal(current, userText, {
        ...options,
        signal: merged.signal,
        isContinuation: true,
        initialBudgetUsage: continuationUsage,
      });
      continuationUsage = budgetUsageFrom(current, continuationUsage);
      await runtime.finish();
    }
  } catch (error) {
    if (options.onCheckpoint && !(error instanceof MaxTurnsExceededError) && !(error instanceof RunStoppedError)) {
      try {
        const isAbort = isAbortError(error) || Boolean(merged.signal?.aborted);
        await options.onCheckpoint({
          reason: isAbort ? "interrupted" : "failed",
          messages: options.runtimeRef?.history ? [...options.runtimeRef.history] : [...history],
        });
      } catch {
        // preserve original error
      }
    }
    throw error;
  } finally {
    merged.cleanup();
  }
}

async function runAgentTurnInternal(
  history: AgentMessage[],
  userText: string,
  options: AgentTurnOptions,
): Promise<AgentMessage[]> {
  const envTurnsRaw = process.env.MINI_AGENT_MAX_TURNS;
  const envTurns = envTurnsRaw !== undefined && envTurnsRaw !== "" ? Number(envTurnsRaw) : undefined;
  // A caller-supplied limit is authoritative; the environment is the default
  // for entrypoints that do not pass an explicit compatibility limit.
  // An explicit caller or MINI_AGENT_MAX_TURNS value is a safety cap.
  // There is no default 80-turn stop; policy events decide when to pause.
  const configuredMaxTurns = options.maxTurns ?? envTurns;
  const maxTurns = configuredMaxTurns === 0 ? undefined : configuredMaxTurns;

  const {
    llm: configuredLlm,
    tools,
    globalTokenBudget,
    chat: completeChat,
    onEvent,
    userContent,
    preprocessors = [],
    signal,
    getPendingUserMessages,
    pauseGate,
    runtimeContext,
    toolExecutionBroker,
    onToolExecutionAudit,
    context,
    authorizeTool,
    parallelToolExecution = true,
    autoValidate = false,
    validationWorkspace = process.cwd(),
    autoCheckpoint = false,
    thinkingMode = "fixed",
    maxThinkingEscalations = 2,
    runtimeRef,
    permissionMode,
    permissionTurn,
    skills = [],
    skillNames = [],
    skillRegistry = defaultSkillRegistry,
    sessionPhase,
    onPlanEvent,
    onCheckpoint,
    isContinuation = false,
    runPolicy,
    goalRuntime,
  } = options;
  if (goalRuntime && onEvent) {
    goalRuntime.onGoalEvent = (event) => onEvent(event);
  }

  const activeRuntimeRef = runtimeRef ?? (globalTokenBudget !== undefined ? {} : undefined);
  if (activeRuntimeRef && globalTokenBudget !== undefined && !activeRuntimeRef.globalBudgetState) {
    activeRuntimeRef.globalBudgetState = { used: 0, limit: globalTokenBudget };
  }
  const effectiveRuntimeContext = runtimeContext ?? activeRuntimeRef?.executionContext ?? {};
  const effectiveAudit = onToolExecutionAudit ?? activeRuntimeRef?.onToolExecutionAudit;

  // ── Skill resolution and merging ─────────────────────────────────────────
  const { activeSkills, skillPromptFragments, skillTools, skillPreprocessors } = resolveActiveSkills(
    skills,
    skillRegistry,
    skillNames,
  );

  const finalPreprocessors = [...preprocessors, ...skillPreprocessors];

  const parsedThinking = parseThinkingIntensityPrompt(userText);
  const requestedThinkingMode = parsedThinking.intensity
    ? "fixed"
    : parseThinkingCommandMode(userText);
  const effectiveThinkingMode = requestedThinkingMode ?? thinkingMode;
  if (parsedThinking.intensity === "off" && !supportsThinkingOff(configuredLlm)) {
    throw new ThinkingCapabilityError(
      `Thinking cannot be disabled for ${formatLlmIdentity(configuredLlm)} through the configured API. ` +
      "Choose a non-reasoning model or configure a provider-supported thinking control.",
    );
  }
  const initialDecision = !parsedThinking.intensity && effectiveThinkingMode === "adaptive"
    ? decideInitialThinkingLevel({
      prompt: parsedThinking.prompt,
      llm: configuredLlm,
      hasAttachments: Array.isArray(userContent) && userContent.length > 1,
    })
    : undefined;
  const initialLlm = parsedThinking.intensity
    ? buildIntenseLlm(configuredLlm, parsedThinking.intensity)
    : initialDecision
      ? withThinkingLevel(configuredLlm, initialDecision.level)
      : configuredLlm;
  const effectiveUserText = parsedThinking.prompt;
  const useInjectedChat = options.chat !== undefined;
  const activePermissionMode = permissionTurn?.mode ?? permissionMode;
  const activeSignal = signal ?? permissionTurn?.signal;
  let checkpointPromise: Promise<unknown> | undefined;
  const executionBroker = toolExecutionBroker ?? activeRuntimeRef?.toolExecutionBroker ?? new ToolExecutionBroker();
  const checkpointBeforeWrite = async (tool: Tool): Promise<void> => {
    if (!autoCheckpoint || checkpointPromise || !["write", "edit", "delete", "mkdir", "copy", "move", "patch", "document_edit"].includes(tool.name)) return;
    checkpointPromise = new GitWorkflow(validationWorkspace).createCheckpoint(`before-turn-${Date.now()}`);
    await checkpointPromise;
  };
  let coordinatorActive = false;
  let coordinatorProfile = "researcher";
  let coordinatorPreflightExecuted = false;
  let coordinatorReasons: string[] = [];
  let maxDirectExploration = DEFAULT_MAX_DIRECT_EXPLORATION;
  let directExplorationUsed = 0;

  const injectCoordinatorPrompt = (decision: AutoSubagentDecision, preflightExecuted: boolean): void => {
    if (!decision.coordinatorMode) return;
    const fragment = buildCoordinatorPromptFragment({
      profile: decision.profile,
      preflightExecuted,
      maxDirectExploration,
    });
    const systemMsg = messages.find((message) => message.role === "system");
    if (systemMsg && typeof systemMsg.content === "string" && !systemMsg.content.includes("### Coordinator Mode")) {
      systemMsg.content = `${systemMsg.content}\n\n${fragment}`;
    }
    coordinatorActive = true;
    coordinatorProfile = decision.profile;
    coordinatorPreflightExecuted = preflightExecuted;
    coordinatorReasons = decision.reasons;
    onEvent?.({
      type: "coordinator_mode",
      active: true,
      profile: decision.profile,
      preflightExecuted,
      maxDirectExploration,
      directExplorationUsed,
      reasons: decision.reasons,
    });
  };

  const executeTool = async (tool: Tool, args: Record<string, unknown>): Promise<ToolResult> => {
    await pauseGate?.wait(activeSignal);
    if (coordinatorActive && EXPLORATION_TOOL_NAMES.has(tool.name)) {
      if (directExplorationUsed >= maxDirectExploration) {
        return {
          content: [
            `Coordinator mode blocked direct exploration tool \`${tool.name}\`.`,
            `Budget exhausted (${directExplorationUsed}/${maxDirectExploration}).`,
            "Use `subagent` or `subagent_batch` for deeper exploration/implementation, then synthesize the results.",
            `Suggested profile: ${coordinatorProfile}.`,
          ].join(" "),
          isError: true,
        };
      }
      directExplorationUsed += 1;
      onEvent?.({
        type: "coordinator_mode",
        active: true,
        profile: coordinatorProfile,
        preflightExecuted: coordinatorPreflightExecuted,
        maxDirectExploration,
        directExplorationUsed,
        reasons: coordinatorReasons,
      });
    } else if (coordinatorActive && DELEGATION_TOOL_NAMES.has(tool.name)) {
      // Successful delegation is the intended path; keep mode active for later turns.
      onEvent?.({
        type: "coordinator_mode",
        active: true,
        profile: coordinatorProfile,
        preflightExecuted: coordinatorPreflightExecuted,
        maxDirectExploration,
        directExplorationUsed,
        reasons: [...coordinatorReasons, "delegated via " + tool.name],
      });
    }

    return executeToolWithBroker({
      broker: executionBroker,
      tool,
      args,
      runtimeContext: effectiveRuntimeContext,
      signal: activeSignal,
      permissionTurn,
      authorizeTool,
      beforeExecute: () => checkpointBeforeWrite(tool),
      onAudit: effectiveAudit,
    });
  };
  let currentLlm = initialLlm;
  let currentContext = context;

  const preprocessContext = {
    userPrompt: effectiveUserText,
    targetModel: {
      ...resolveModel(currentLlm.model, currentLlm.baseUrl),
      capabilities: currentLlm.capabilities,
    },
  };
  const budgetTracker = new BudgetTracker(options.initialBudgetUsage);
  const stallDetector = new StallDetector(runPolicy);
  const triggerCheckpoint = async (
    reason: CheckpointReason,
    extra: { turn?: number; toolCall?: ToolCall; toolResult?: ToolResult; stopReason?: StopReason; details?: string } = {},
  ): Promise<void> => {
    if (!onCheckpoint) return;
    await onCheckpoint({
      reason,
      messages: [...messages],
      turn: extra.turn,
      toolCall: extra.toolCall,
      toolResult: extra.toolResult,
      stopReason: extra.stopReason,
      details: extra.details,
      budgetUsage: budgetTracker.getUsage(),
      lastFingerprint: stallDetector.lastActionFingerprint || undefined,
    });
  };

  const initialBatch = isContinuation
    ? []
    : await applyPreprocessors(
        [
          {
            role: "user",
            content: userContent ?? effectiveUserText ?? "",
          },
        ],
        finalPreprocessors,
        preprocessContext,
      );
  // Incoming history (e.g. a resumed session) starts bounded: clear any
  // oversized tool results so a restored session does not immediately overflow.
  const compactedHistory = compactHistory(history, currentContext);
  const boundedHistory = applyToolResultBudget(compactedHistory).messages;
  const cappedHistory = capHistory(boundedHistory);
  let messages: AgentMessage[] = [
    ...(runPolicy ? cappedHistory : boundedHistory),
    ...initialBatch,
  ];
  // Only policy mode mirrors the initial compaction to the TUI and counts it
  // against the run's compaction allowance; non-policy mode relies on
  // compactHistory's token-based compaction which already handles long runs.
  // `compactedHistory !== history` covers the keep-recent/char-budget
  // compaction, while `cappedHistory !== boundedHistory` covers the hard
  // 200-message cap — either one means the initial history was rewritten
  // before the first model call and must be reported as a compaction.
  let pendingHistoryCapEvent = Boolean(runPolicy) && (cappedHistory !== boundedHistory || compactedHistory !== history);
  const autocompactState: { consecutiveFailures?: number } = {};
  const appendPendingUserMessages = async (turn: number): Promise<boolean> => {
    const pending = await getPendingUserMessages?.();
    if (!pending?.length) return false;
    const injected = await applyPreprocessors(
      pending.map((content) => ({ role: "user" as const, content })),
      finalPreprocessors,
      preprocessContext,
    );
    messages.push(...injected);
    await triggerCheckpoint("user_input", { turn });
    return injected.length > 0;
  };

  // ── Stall & Action Policy Detector ───────────────────────────────────────
  let compactionsCount = 0;
  const maxEmergencyTurns = options.blockTurns ?? runPolicy?.emergencyIterationCap ?? maxTurns;
  const stopRun = async (stopReason: StopReason, details: string, turn: number): Promise<never> => {
    await triggerCheckpoint("paused", { turn, stopReason, details });
    const usage = budgetTracker.getUsage();
    onEvent?.({ type: "run_stopped", stopReason, details, message: details, budgetUsage: usage, messages });
    throw new RunStoppedError(messages, stopReason, details, usage);
  };

  const applyCompaction = async (compacted: AgentMessage[], turn: number, tools: Tool[], reason: string): Promise<void> => {
    if (runPolicy?.maxCompactions !== undefined && compactionsCount >= runPolicy.maxCompactions) {
      await stopRun("context_exhausted", `Context compaction limit reached (${compactionsCount}/${runPolicy.maxCompactions}); progress was saved.`, turn - 1);
    }
    const beforeTokens = estimateContextTokens(messages, tools);
    compactionsCount += 1;
    messages.splice(0, messages.length, ...compacted);
    await triggerCheckpoint("context_compacted", { turn: turn - 1 });
    onEvent?.({ type: "context_compacted", beforeTokens, afterTokens: estimateContextTokens(messages, tools), reason });
  };

  const emitHistoryCapCompaction = async (turn: number, tools: Tool[], capped: AgentMessage[]): Promise<void> => {
    compactionsCount += 1;
    const beforeMessages = messages;
    messages.splice(0, messages.length, ...capped);
    await triggerCheckpoint("context_compacted", { turn: turn - 1 });
    onEvent?.({
      type: "context_compacted",
      beforeTokens: estimateContextTokens(beforeMessages, tools),
      afterTokens: estimateContextTokens(messages, tools),
      reason: "history cap",
    });
  };

  const emitToolStart = (call: ToolCall): void => {
    budgetTracker.recordToolCall(call);
    onEvent?.({ type: "tool_start", call });
  };

  const checkPolicyBudgets = (turnNumber: number): StopReason | undefined =>
    budgetTracker.checkBudgets(turnNumber, runPolicy, activeSignal, maxEmergencyTurns);

  const syncRuntimeRef = (): void => {
    if (!activeRuntimeRef) return;
    activeRuntimeRef.llm = currentLlm;
    activeRuntimeRef.history = messages;
    activeRuntimeRef.thinkingMode = effectiveThinkingMode;
    activeRuntimeRef.maxThinkingEscalations = maxThinkingEscalations;
    activeRuntimeRef.context = currentContext;
    activeRuntimeRef.skillNames = activeSkills.map((skill) => skill.name);
    if (runtimeContext) activeRuntimeRef.executionContext = runtimeContext;
    if (executionBroker) activeRuntimeRef.toolExecutionBroker = executionBroker;
    if (effectiveAudit) activeRuntimeRef.onToolExecutionAudit = effectiveAudit;
  };
  syncRuntimeRef();

  const emitAbortedWithCheckpoint = async (): Promise<void> => {
    emitAborted(onEvent, messages, permissionTurn);
    await triggerCheckpoint("interrupted");
  };
  const emitAssistantEvent = async (message: AssistantMessage, usage?: StreamChatUsage): Promise<void> => {
    // Add message to history only once, here in emit
    messages.push(message);
    if (activeRuntimeRef) activeRuntimeRef.history = messages;
    
    const budget = activeRuntimeRef?.globalBudgetState;
    let exceeded = false;
    if (budget && usage?.totalTokens) {
      budget.used = budget.tokenLedger
        ? await budget.tokenLedger.consumeTokens(usage.totalTokens)
        : budget.used + usage.totalTokens;
      exceeded = budget.limit !== undefined && budget.used > budget.limit;
    }
    if (usage?.totalTokens) {
      budgetTracker.addTokens(usage.totalTokens);
    }
    onEvent?.({ type: "assistant", message, ...(usage ? { usage } : {}) });
    if (goalRuntime) {
      try {
        const budgetReached = await goalRuntime.chargeTokens(usage);
        if (budgetReached) {
          await goalRuntime.chargeElapsed();
        }
      } catch {
        // Goal accounting is best-effort: a disappearing data directory (for
        // example workspace teardown) must not fail the model turn itself.
      }
    }
    if (exceeded) throw new Error(`Global agent token budget exceeded (${budget?.limit}).`);
  };

  // Keep the model's active mode synchronized when a session changes modes.
  if (activePermissionMode !== undefined) applyPermissionModePrompt(messages, activePermissionMode);
  
  // Apply phase-specific prompt for Plan-Act workflow
  if (sessionPhase) {
    applyPhasePrompt(messages, sessionPhase);
    if (sessionPhase === "planning") {
      onPlanEvent?.({ type: "planning_started", sessionId: "temp" });
    }
  }

  // ── Apply skill system prompt fragments ──────────────────────────────────
  applySkillPromptFragments(messages, skillPromptFragments);

  let overflowRetries = 0;
  let emptyAssistantResponses = 0;
  let autoSubagentAttempted = false;
  let thinkingEscalations = 0;
  maxDirectExploration =
    options.autoSubagent?.maxDirectExploration ?? DEFAULT_MAX_DIRECT_EXPLORATION;
  let reasoningOnlyRetries = 0;
  const retryCoordinator = new LlmRetryCoordinator();
  let timeoutRetries = 0;
  let truncatedStreamRetries = 0;
  // Consecutive-truncation budget. Reset on any successful turn so a flaky
  // provider can be retried indefinitely across the session, but a hard
  // outage fails fast instead of spinning.
  const MAX_TRUNCATED_STREAM_RETRIES = 2;

  if (initialDecision) {
    onEvent?.({
      type: "thinking_policy",
      mode: "adaptive",
      phase: "initial",
      level: initialLlm.thinkingLevel ?? "off",
      score: initialDecision.score,
      reasons: initialDecision.reasons,
    });
  }

  const prepareNextTurn = async (
    turn: number,
    assistantMessage: AssistantMessage,
    toolResults: ToolResultMessage[],
  ): Promise<void> => {
    const update = await options.prepareNextTurn?.({
      turn,
      currentLlm,
      assistantMessage,
      toolResults,
      messages: [...messages],
    });
    if (update?.llm) {
      const previousModel = currentLlm.model;
      currentLlm = update.llm;
      if (previousModel !== currentLlm.model) {
        onEvent?.({ type: "model_switched", previousModel, nextModel: currentLlm.model, turn });
      }
      preprocessContext.targetModel = {
        ...resolveModel(currentLlm.model, currentLlm.baseUrl),
        capabilities: currentLlm.capabilities,
      };
    }
    if (update?.context) currentContext = update.context;
    syncRuntimeRef();

    if (effectiveThinkingMode !== "adaptive") return;
    const decision = decideNextThinkingLevel({
      llm: currentLlm,
      currentLevel: currentLlm.thinkingLevel ?? "off",
      toolResults,
      escalationCount: thinkingEscalations,
      maxEscalations: maxThinkingEscalations,
    });
    if (!decision) return;
    const previousLevel = currentLlm.thinkingLevel ?? "off";
    currentLlm = withThinkingLevel(currentLlm, decision.level);
    thinkingEscalations += 1;
    syncRuntimeRef();
    onEvent?.({
      type: "thinking_policy",
      mode: "adaptive",
      phase: "escalation",
      previousLevel,
      level: currentLlm.thinkingLevel ?? "off",
      score: decision.score,
      reasons: decision.reasons,
    });
  };

  /**
   * Shared post-processing for both streaming and injected-chat paths.
   * Handles empty-response detection, assistant message emission, tool
   * execution loop (with abort / error handling), preprocessing of tool
   * results, and the prepareNextTurn callback.
   *
   * Returns `"done"` when the assistant gave a final text answer,
   * `"continue"` when tool results were produced and the loop should
   * keep going, or `"aborted"` when cancellation was detected during
   * tool execution.
   */
  async function handleAssistantResponse(
    assistant: AssistantMessage,
    turnTools: Tool[],
    turn: number,
    usage?: StreamChatUsage,
  ): Promise<"done" | "continue" | "aborted"> {
    try {
      permissionTurn?.assertCurrent();
    } catch (err) {
      if (isAbortError(err)) {
        emitAborted(onEvent, messages, permissionTurn);
        return "aborted";
      }
      throw err;
    }
    const calls = assistant.toolCalls ?? [];

    // ── No tool calls ──────────────────────────────────────────────
    if (calls.length === 0) {
      if (assistant.content.trim().length === 0) {
        await emitAssistantEvent(assistant, usage);
        emptyAssistantResponses += 1;
        if (emptyAssistantResponses > MAX_EMPTY_ASSISTANT_RESPONSES) {
          throw new Error(
            `LLM returned an empty assistant response ${emptyAssistantResponses} times; stopping to avoid a silent loop`,
          );
        }
        return "continue";
      }
      emptyAssistantResponses = 0;
      await emitAssistantEvent(assistant, usage);
      
      // Check if this is a plan generation in planning phase
      if (sessionPhase === "planning" && onPlanEvent) {
        const parsedPlan = planGenerator.parseFromLlmOutput(assistant.content, "temp");
        if (parsedPlan.valid && parsedPlan.steps.length > 0) {
          const plan = planManager.createPlan("temp", parsedPlan.summary, parsedPlan.steps as any);
          if (plan) {
            planManager.markPendingReview(plan.id);
            onPlanEvent({ type: "plan_generated", plan });
          }
        }
      }
      
      onEvent?.({ type: "done", messages });
      await triggerCheckpoint("completed", { turn });
      return "done";
    }

    // ── Has tool calls ─────────────────────────────────────────────
    emptyAssistantResponses = 0;
    await emitAssistantEvent(assistant, usage);

    // Checkpoint 2: received full tool calls, before executing tools
    await triggerCheckpoint("before_tool", { turn, toolCall: calls[0] });

    const execResult = await executeTurnTools({
      calls,
      turnTools,
      parallel: parallelToolExecution,
      executeTool,
      emitToolStart,
      onEvent,
      activeSignal,
      messages,
    });
    if (execResult.wasAborted) {
      emitAborted(onEvent, messages, permissionTurn);
      return "aborted";
    }
    const toolMessages = execResult.toolMessages;

    let processedToolMessages: ToolResultMessage[];
    try {
      permissionTurn?.assertCurrent();
      processedToolMessages = (await applyPreprocessors(
        toolMessages,
        finalPreprocessors,
        preprocessContext,
      )) as ToolResultMessage[];
      permissionTurn?.assertCurrent();
    } catch (err) {
      if (!isAbortError(err)) throw err;
      messages.push(...toolMessages);
      emitAborted(onEvent, messages, permissionTurn);
      return "aborted";
    }
    let nextTurnToolResults = processedToolMessages;
    messages.push(...processedToolMessages.map((message) => ({
      ...message,
      content: truncateToolResult(message.content),
    })));

    const stallResult = stallDetector.recordActions(calls, processedToolMessages);
    if (stallResult.stalled && stallResult.details) {
      return stopRun("stalled", stallResult.details, turn);
    }

    // Checkpoint 3: tool results entered history
    await triggerCheckpoint("tool_result", { turn });
    if (autoValidate && processedToolMessages.some((message) =>
      !message.isError && ["write", "edit", "delete", "mkdir", "copy", "move", "patch", "document_edit"].includes(message.name))) {
      const validationCall: ToolCall = { id: `auto_validation_${turn}`, name: "validate_workspace", arguments: {} };
      const validationAssistant: AssistantMessage = { role: "assistant", content: "", toolCalls: [validationCall] };
      await emitAssistantEvent(validationAssistant);
      emitToolStart(validationCall);
      const report = await runValidation({ workspace: validationWorkspace, signal: activeSignal });
      const validationResult: ToolResult = { content: formatValidationReport(report), isError: !report.ok };
      const validationMessage: ToolResultMessage = {
        role: "tool", toolCallId: validationCall.id, name: validationCall.name,
        content: validationResult.content, isError: validationResult.isError,
      };
      messages.push(validationMessage);
      nextTurnToolResults = [...processedToolMessages, validationMessage];
      onEvent?.({ type: "tool_end", call: validationCall, result: validationResult });
    }
    await prepareNextTurn(turn, assistant, nextTurnToolResults);
    try {
      permissionTurn?.assertCurrent();
    } catch (err) {
      if (isAbortError(err)) {
        emitAborted(onEvent, messages, permissionTurn);
        return "aborted";
      }
      throw err;
    }
    return "continue";
  }

  for (let turn = 1; maxEmergencyTurns == null || turn <= maxEmergencyTurns; turn++) {
    await pauseGate?.wait(activeSignal);
    if (activeSignal?.aborted) {
      emitAborted(onEvent, messages, permissionTurn);
      return messages;
    }
    await appendPendingUserMessages(turn);
    const budgetExhaustedReason = checkPolicyBudgets(turn);
    if (budgetExhaustedReason) {
      const usage = budgetTracker.getUsage();
      const details = `Run budget exhausted (tokens=${usage.tokensUsed}, tools=${usage.toolCallsUsed}, writes=${usage.writeCallsUsed}, elapsedMs=${usage.elapsedMs}); progress was saved.`;
      return stopRun(budgetExhaustedReason, details, turn - 1);
    }
    const loopBudget = activeRuntimeRef?.globalBudgetState;
    if (loopBudget?.tokenLedger) loopBudget.used = await loopBudget.tokenLedger.readTokens();
    if (loopBudget?.limit !== undefined && loopBudget.used >= loopBudget.limit) {
      throw new Error(`Global agent token budget exhausted (${loopBudget.limit}).`);
    }
    try {
      permissionTurn?.assertCurrent();
    } catch (err) {
      if (isAbortError(err)) {
        emitAborted(onEvent, messages, permissionTurn);
        return messages;
      }
      throw err;
    }

    await runSkillHooks(activeSkills, "beforeTurn", {
      turn,
      currentLlm,
      assistantMessage: { role: "assistant", content: "" },
      toolResults: [],
      messages: [...messages],
    });

    const baseTools = resolveToolProvider(tools);
    const turnTools = [...baseTools, ...skillTools];
    if (pendingHistoryCapEvent) {
      pendingHistoryCapEvent = false;
      // The cap payload replaces only the initial history prefix; keep any
      // inbox messages injected before this point and the initial user batch.
      const baseLength = cappedHistory.length + initialBatch.length;
      const injected = messages.slice(baseLength);
      await emitHistoryCapCompaction(turn, turnTools, [...cappedHistory, ...initialBatch, ...injected]);
    }

    // Optional deterministic preflight + coordinator activation. This happens
    // once before the first model request and is intentionally not passed into
    // nested subagent loops.
    if (turn === 1 && !autoSubagentAttempted) {
      autoSubagentAttempted = true;
      const autoPolicy = options.autoSubagent;
      const subagentTool = turnTools.find((tool) => tool.name === "subagent");
      if (autoPolicy?.enabled) {
        const decision = decideAutoSubagent(effectiveUserText, autoPolicy);
        const canExecute = Boolean(subagentTool) && decision.shouldDelegate && !activeSignal?.aborted;
        onEvent?.({
          type: "auto_subagent",
          shouldDelegate: decision.shouldDelegate,
          executed: false,
          coordinatorMode: decision.coordinatorMode,
          score: decision.score,
          reasons: decision.reasons,
          profile: decision.profile,
        });

        // Activate coordinator guidance even if the preflight tool call cannot run
        // (for example when subagent tool is missing). Budget enforcement only
        // matters when the parent still has exploration tools.
        if (decision.coordinatorMode) {
          injectCoordinatorPrompt(decision, false);
        }

        if (canExecute && subagentTool) {
          const properties = subagentTool.parameters.properties;
          const supportsProfile = Boolean(
            properties &&
            typeof properties === "object" &&
            Object.prototype.hasOwnProperty.call(properties, "profile"),
          );
          const call: ToolCall = {
            id: `auto_subagent_${randomUUID()}`,
            name: "subagent",
            arguments: {
              // Use a focused preflight task, not the raw user prompt blob.
              task: decision.task,
              ...(supportsProfile ? { profile: decision.profile } : {}),
              ...(autoPolicy.model ? { model: autoPolicy.model } : {}),
              ...(autoPolicy.maxTurns ? { maxTurns: autoPolicy.maxTurns } : {}),
              runInBackground: false,
            },
          };
          const assistant: AssistantMessage = {
            role: "assistant",
            content: "",
            toolCalls: [call],
          };
          await emitAssistantEvent(assistant);
          emitToolStart(call);

          let result: ToolResult;
          let wasAborted = false;
          try {
            const args = validateToolArgs(subagentTool, call.arguments);
            // Preflight itself is intentional delegation, not parent exploration.
            // Temporarily disable budget counting by routing through the tool
            // implementation with coordinator bookkeeping already aware of
            // DELEGATION_TOOL_NAMES.
            result = await executeTool(subagentTool, args);
          } catch (error) {
            wasAborted = isAbortError(error) || Boolean(activeSignal?.aborted);
            result = isAbortError(error)
              ? { content: "已停止", isError: true }
              : {
                  content: error instanceof Error ? error.message : String(error),
                  isError: true,
                };
          }

          const toolMessage: ToolResultMessage = {
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
          };
          const processedToolMessages = (await applyPreprocessors(
            [toolMessage],
            finalPreprocessors,
            preprocessContext,
          )) as ToolResultMessage[];
          messages.push(...processedToolMessages.map((message) => ({
      ...message,
      content: truncateToolResult(message.content),
    })));
          onEvent?.({ type: "tool_end", call, result });
          coordinatorPreflightExecuted = true;
          // Refresh coordinator prompt now that preflight has actually run.
          if (decision.coordinatorMode) {
            const systemMsg = messages.find((message) => message.role === "system");
            if (systemMsg && typeof systemMsg.content === "string") {
              const fragment = buildCoordinatorPromptFragment({
                profile: decision.profile,
                preflightExecuted: true,
                maxDirectExploration,
              });
              systemMsg.content = systemMsg.content.includes("### Coordinator Mode")
                ? systemMsg.content.replace(
                    /### Coordinator Mode[\s\S]*$/,
                    fragment,
                  )
                : `${systemMsg.content}\n\n${fragment}`;
            }
            onEvent?.({
              type: "coordinator_mode",
              active: true,
              profile: decision.profile,
              preflightExecuted: true,
              maxDirectExploration,
              directExplorationUsed,
              reasons: decision.reasons,
            });
          }
          onEvent?.({
            type: "auto_subagent",
            shouldDelegate: true,
            executed: true,
            coordinatorMode: decision.coordinatorMode,
            score: decision.score,
            reasons: decision.reasons,
            profile: decision.profile,
          });

          if (wasAborted || activeSignal?.aborted) {
            emitAborted(onEvent, messages, permissionTurn);
            return messages;
          }
          await prepareNextTurn(1, assistant, processedToolMessages);
        }
      }
    }

    // Preflight delegation can consume a budget before the first model request.
    const preflightStopReason = checkPolicyBudgets(turn);
    if (preflightStopReason) {
      return stopRun(preflightStopReason, "Run budget exhausted after preflight; progress was saved.", turn - 1);
    }
    const preparedMessages = compactForModel(messages, currentLlm, turnTools, currentContext, autocompactState);
    if (preparedMessages !== messages) await applyCompaction(preparedMessages, turn, turnTools, "token budget");
    const modelMessages = goalRuntime
      ? await goalRuntime.prepareMessages(messages)
      : messages;
    let assistant: AssistantMessage;
    let lastUsage: StreamChatUsage | undefined;
    try {
      if (useInjectedChat) {
        // Injected chat (tests) stays non-streaming for deterministic offline coverage.
        permissionTurn?.assertCurrent();
        assistant = await completeChat!(currentLlm, modelMessages, turnTools);
        lastUsage = (assistant as any).usage;
        permissionTurn?.assertCurrent();
      } else {
        assistant = {
          role: "assistant",
          content: "",
        };
        let sawFinal = false;
        let streamed = "";
        try {
        for await (const event of streamLlmEvents(currentLlm, modelMessages, turnTools, activeSignal)) {
            if (event.type === "answer_delta") {
              streamed += event.text;
              onEvent?.({ type: "assistant_delta", text: event.text, kind: "answer" });
              continue;
            }
            if (event.type === "reasoning_delta") {
              onEvent?.({ type: "assistant_delta", text: event.text, kind: "reasoning" });
              continue;
            }
            if (event.type === "completed") {
              assistant = event.message;
              lastUsage = event.usage;
              sawFinal = true;
              continue;
            }
            if (event.type === "error") {
              throw event.error;
            }
          }
        } catch (err) {
          if (isAbortError(err)) {
            if (streamed) {
              assistant = { role: "assistant", content: streamed };
              await emitAssistantEvent(assistant);
            }
            emitAborted(onEvent, messages, permissionTurn);
            return messages;
          }
          // Timeout is a terminal state: preserve partial output but re-throw
          // so the upper layer emits an error event instead of continuing
          // the loop or hitting MaxTurnsExceededError.
          if (err instanceof LlmTimeoutError) {
            if (streamed) {
              const partial = { role: "assistant" as const, content: streamed };
              await emitAssistantEvent(partial);
            }
            // Attach the accumulated messages so the caller can restore history.
            throw new LlmTimeoutError(
              streamed || err.partialContent,
              messages,
              {
                phase: err.phase,
                timeoutMs: err.timeoutMs,
                elapsedMs: err.elapsedMs,
              },
            );
          }
          throw err;
        }
        if (!sawFinal) {
          throw new Error("LLM stream ended without a final assistant message");
        }
        // Some gateways send answer deltas and then a terminal assistant
        // object with empty content. Preserve the streamed answer for loop
        // history and final-response handling instead of treating it as an
        // empty assistant turn.
        if (!assistant.content.trim() && streamed.trim()) {
          assistant = { ...assistant, content: streamed };
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        emitAborted(onEvent, messages, permissionTurn);
        return messages;
      }
      if (err instanceof IncompleteLlmResponseError && err.reason === "reasoning_only") {
        if (currentLlm.thinkingLevel !== "off" && reasoningOnlyRetries < 1 && supportsThinkingOff(currentLlm)) {
          reasoningOnlyRetries += 1;
          onEvent?.({ type: "attempt_reset", reason: "reasoning_only", attempt: reasoningOnlyRetries });
          currentLlm = withThinkingLevel(currentLlm, "off");
          continue;
        }

        const retryNote = reasoningOnlyRetries > 0
          ? "The recovery attempt also returned no final answer."
          : "This model/provider does not expose a usable thinking-off control.";
        throw new IncompleteLlmResponseError(
          "reasoning_only",
          `LLM ${formatLlmIdentity(currentLlm)} returned reasoning without a final answer. ${retryNote} ` +
          "Choose a different model or configure a provider-supported thinking mode.",
        );
      }
      if (err instanceof LlmTimeoutError) {
        const hasPartialAnswer = Boolean(err.partialContent?.trim());
        if (!hasPartialAnswer && timeoutRetries < 1) {
          timeoutRetries += 1;
          onEvent?.({
            type: "retry_attempt",
            errorType: "timeout",
            attempt: timeoutRetries,
            maxRetries: 1,
            delayMs: 0,
            errorMessage: err.message,
          });
          turn -= 1;
          continue;
        }
        throw err;
      }
      // Stream cut off mid-generation (no [DONE]/finish_reason). Tool calls
      // have not been executed yet, so replaying the request is side-effect
      // free. Reset the UI's streamed text first so the retry doesn't
      // duplicate the partial answer, then re-run the same turn.
      if (err instanceof StreamTruncatedError && truncatedStreamRetries < MAX_TRUNCATED_STREAM_RETRIES) {
        truncatedStreamRetries += 1;
        onEvent?.({ type: "attempt_reset", reason: "stream_truncated", attempt: truncatedStreamRetries });
        turn -= 1;
        continue;
      }
      if (err instanceof StreamTruncatedError) {
        throw new Error(
          `LLM stream truncated ${MAX_TRUNCATED_STREAM_RETRIES + 1} times in a row; ` +
          "provider connection is unstable. " +
          (err.partialContent.trim()
            ? `Partial answer before disconnect: "${err.partialContent.slice(0, 200)}"`
            : "No content was received."),
        );
      }
      const maxRetries = currentContext?.maxCompactionRetries ?? 1;
      if (isContextOverflowError(err) && overflowRetries < maxRetries) {
        overflowRetries += 1;
        const compacted = compactForModel(
          messages,
          currentLlm,
          turnTools,
          currentContext,
          autocompactState,
          true,
        );
        if (compacted === messages) {
          if (runPolicy) return stopRun("context_exhausted", "Context window overflowed and could not be compacted further; progress was saved.", turn - 1);
          throw new Error("Context window overflowed and could not be compacted further");
        }
        await applyCompaction(compacted, turn, turnTools, "provider context overflow");
        turn -= 1;
        continue;
      }

      if (runPolicy && isContextOverflowError(err)) {
        return stopRun("context_exhausted", "Context window overflowed after compaction recovery; progress was saved.", turn - 1);
      }

      // Retry only request-level transient failures. Retrying after a tool
      // call, timeout, permission error, or budget error could repeat side
      // effects or hide the actual policy boundary.
      const retry = retryCoordinator.next(err);
      if (retry) {
        onEvent?.({
          type: "retry_attempt",
          errorType: retry.errorType,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          delayMs: retry.delayMs,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        await waitForRetry(retry.delayMs, activeSignal);
        turn -= 1;
        continue;
      }
      throw err;
    }

    // Shared post-processing for both streaming and injected-chat paths.
    let action: "done" | "continue" | "aborted";
    try {
      permissionTurn?.assertCurrent();
      action = await handleAssistantResponse(assistant, turnTools, turn, lastUsage);
    } catch (err) {
      if (isAbortError(err)) {
        emitAborted(onEvent, messages, permissionTurn);
        return messages;
      }
      throw err;
    }

    timeoutRetries = 0;
    truncatedStreamRetries = 0;
    retryCoordinator.resetAfterSuccess();

    const afterToolResults = messages
      .slice()
      .reverse()
      .filter((m): m is ToolResultMessage => m.role === "tool")
      .reverse();
    // Only include tool results that belong to this assistant response.
    const assistantCallIds = new Set((assistant.toolCalls ?? []).map((c) => c.id));
    const turnToolResults = afterToolResults.filter((m) => assistantCallIds.has(m.toolCallId));

    await runSkillHooks(activeSkills, "afterTurn", {
      turn,
      currentLlm,
      assistantMessage: assistant,
      toolResults: turnToolResults,
      messages: [...messages],
    });

    if (action === "aborted") return messages;
    if (action === "done") {
      if (await appendPendingUserMessages(turn + 1)) continue;
      return messages;
    }
  }

  if (options.blockTurns !== undefined) return messages;
  const details = `Safety cap reached (${maxEmergencyTurns} steps); progress was saved.`;
  return stopRun("safety_cap_reached", details, maxEmergencyTurns ?? 0);
}

/** Helper for logging / tests */
export function previewContent(content: MessageContent, max = 120): string {
  const s = contentAsString(content).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

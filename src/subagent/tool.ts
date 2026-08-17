/**
 * Subagent tool — allows the parent agent to spawn a nested agent loop.
 *
 * The tool is registered as `subagent` in the parent's tool set.  When
 * the LLM calls it, a fresh agent loop runs with the specified task,
 * system prompt, and tool subset.  The final assistant text is returned
 * to the parent as the tool result.
 *
 * Key safety measures:
 * - `maxDepth` caps nesting (default 3).
 * - The subagent tool is excluded from the child tool set by default to
 *   prevent runaway recursion.
 * - Each subagent has its own `maxTurns` budget.
 * - The parent's `AbortSignal` is propagated so the whole tree can be
 *   cancelled.
 * - Optional `timeout` aborts long-running subagents.
 */

import { randomUUID } from "node:crypto";
import { contentAsString } from "../content.ts";
import { switchLlmModel, type LlmConfig } from "../llm/index.ts";
import {
  MaxTurnsExceededError,
  runAgentLoop,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../loop.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../tools/types.ts";
import type {
  SubagentArgs,
  SubagentBatchArgs,
  SubagentBatchTask,
  SubagentEvent,
  SubagentProfile,
  SubagentRuntimeInfo,
  SubagentToolOptions,
} from "./types.ts";
import type { PermissionTurnContext } from "../permissions.ts";
import type { ThinkingMode } from "../thinking-policy.ts";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENCY_BATCH = 0; // 0 = unlimited (all concurrent)
const SUBAGENT_TOOL_NAME = "subagent";
const MAX_PARTIAL_TOOL_SNIPPETS = 4;
const MAX_PARTIAL_TOOL_CHARS = 400;

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  "You are a focused sub-agent. Complete the given task precisely and return a clear, concise result.",
  "Do not ask follow-up questions — work with the information provided.",
  "When you have finished the task, respond with your final answer as plain text.",
  "Important: always end with a non-empty text answer. Tool calls alone are not enough.",
].join("\n");

type ExtractedAnswer = {
  text: string;
  /** True when we had to synthesize/fallback instead of a clean final assistant answer. */
  partial: boolean;
  source: "assistant" | "tool_results" | "none";
};

// ─── Global cross-batch concurrency limiter ────────────────────────────────────
let _globalActiveCount = 0;
type GlobalConcurrencyWaiter = {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const _globalConcurrencyQueue: GlobalConcurrencyWaiter[] = [];

/** Acquire a global concurrency slot. Resolves immediately if under limit. */
async function acquireGlobalSlot(limit: number, signal?: AbortSignal): Promise<void> {
  if (limit <= 0) return; // No global limit
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  if (_globalActiveCount < limit) {
    _globalActiveCount++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: GlobalConcurrencyWaiter = { resolve, reject, signal };
    const onAbort = () => {
      const index = _globalConcurrencyQueue.indexOf(waiter);
      if (index >= 0) _globalConcurrencyQueue.splice(index, 1);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener("abort", onAbort, { once: true });
    _globalConcurrencyQueue.push(waiter);
  });
  _globalActiveCount++;
}

/** Release a global concurrency slot. */
function releaseGlobalSlot(): void {
  if (_globalActiveCount > 0) {
    _globalActiveCount--;
    while (_globalConcurrencyQueue.length > 0) {
      const next = _globalConcurrencyQueue.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort!);
      if (next.signal?.aborted) {
        next.reject(next.signal.reason ?? new Error("Aborted"));
        continue;
      }
      next.resolve();
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveProfile(
  name: string | undefined,
  profiles: SubagentProfile[],
): SubagentProfile | undefined {
  if (!name) return undefined;
  return profiles.find((p) => p.name === name);
}

function buildChildTools(
  parentTools: ToolProvider,
  allowedNames: string[] | undefined,
  /**
   * Whether to allow the `subagent` tool itself in the child.
   * Default: false (prevents infinite recursion).
   */
  allowRecursion: boolean,
): Tool[] {
  const all = resolveToolProvider(parentTools);
  let filtered = all;

  if (allowedNames && allowedNames.length > 0) {
    const nameSet = new Set(allowedNames);
    filtered = all.filter((t) => nameSet.has(t.name));
  }

  if (!allowRecursion) {
    filtered = filtered.filter((t) => t.name !== SUBAGENT_TOOL_NAME);
  }

  return filtered;
}

/**
 * Extract the best available answer from a completed (or partial) message list.
 * Prefers the last non-empty assistant text; falls back to recent tool outputs
 * so maxTurns / empty-final-answer cases still return usable progress.
 */
function extractBestAnswer(messages: AgentMessage[]): ExtractedAnswer {
  // Prefer the latest non-empty assistant text, not merely the last assistant
  // message (which may be a tool-call-only turn with empty content).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const text = contentAsString(msg.content).trim();
    if (text.length > 0) {
      return { text, partial: false, source: "assistant" };
    }
  }

  const toolSnippets: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    const toolMsg = msg as ToolResultMessage;
    const body = contentAsString(toolMsg.content).trim();
    if (!body) continue;
    const clipped =
      body.length > MAX_PARTIAL_TOOL_CHARS
        ? `${body.slice(0, MAX_PARTIAL_TOOL_CHARS)}…`
        : body;
    const flag = toolMsg.isError ? "error" : "ok";
    toolSnippets.push(`- ${toolMsg.name} [${flag}]: ${clipped}`);
    if (toolSnippets.length >= MAX_PARTIAL_TOOL_SNIPPETS) break;
  }

  if (toolSnippets.length > 0) {
    return {
      text: [
        "No final assistant summary was produced. Recovered recent tool output:",
        ...toolSnippets.reverse(),
      ].join("\n"),
      partial: true,
      source: "tool_results",
    };
  }

  // Last resort: mention tool-call-only assistant turns so the parent knows work happened.
  const toolOnlyTurns = messages.filter(
    (msg): msg is AssistantMessage =>
      msg.role === "assistant" && Boolean(msg.toolCalls?.length),
  ).length;
  if (toolOnlyTurns > 0) {
    return {
      text: `Sub-agent made ${toolOnlyTurns} tool-calling turn(s) but produced no textual answer or tool output to recover.`,
      partial: true,
      source: "none",
    };
  }

  return { text: "", partial: true, source: "none" };
}

function countTurns(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function countToolCalls(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "assistant") return sum;
    return sum + (message.toolCalls?.length ?? 0);
  }, 0);
}

function formatExecSummary(input: {
  turns: number;
  toolCallCount: number;
  tokens: number;
  errorCount: number;
  modelFallback: boolean;
  partial?: boolean;
}): string {
  const bits = [
    `${input.turns} turn(s)`,
    `${input.toolCallCount} tool call(s)`,
    `~${input.tokens} tokens`,
  ];
  if (input.errorCount > 0) bits.push(`${input.errorCount} error(s)`);
  if (input.modelFallback) bits.push("model fallback");
  if (input.partial) bits.push("partial result");
  return `— Sub-agent exec summary: ${bits.join(", ")}`;
}

/**
 * Build runtime info for a resolved LLM config.
 * Tracks whether the model switch succeeded or fell back.
 */
function buildRuntimeInfo(
  llm: LlmConfig,
  requestedModel: string | undefined,
  switchSucceeded: boolean,
  thinkingMode: ThinkingMode,
): SubagentRuntimeInfo {
  return {
    model: llm.model,
    provider: llm.provider,
    baseUrl: llm.baseUrl,
    thinkingMode,
    thinkingLevel: llm.thinkingLevel,
    modelSwitchSucceeded: switchSucceeded,
    requestedModel,
  };
}

/**
 * Merge multiple abort signals into a single AbortController.
 * Compatible with Node.js 18 (no AbortSignal.any()).
 *
 * Returns a controller whose signal aborts when ANY of the input signals
 * fires, plus a cleanup function to remove the listeners.
 */
function mergeAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  for (const sig of signals) {
    if (!sig) continue;

    // Already aborted — abort immediately.
    if (sig.aborted) {
      controller.abort(sig.reason);
      return { controller, cleanup: () => {} };
    }

    const handler = () => controller.abort(sig.reason);
    sig.addEventListener("abort", handler, { once: true });
    cleanups.push(() => sig.removeEventListener("abort", handler));
  }

  return {
    controller,
    cleanup: () => cleanups.forEach((fn) => fn()),
  };
}

/**
 * Run tasks with a concurrency limit using a token-bucket semaphore.
 * Compatible with Node.js 18 (no AbortSignal.any()).
 *
 * When `maxConcurrency` is 0 or undefined, all tasks run concurrently
 * (original Promise.allSettled behavior).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number,
): Promise<T[]> {
  if (maxConcurrency <= 0 || maxConcurrency >= tasks.length) {
    return Promise.all(tasks.map((fn) => fn()));
  }

  /**
   * Each slot holds either a pending factory function or a settled promise.
   * A factory is only called when a worker grabs that slot, enforcing concurrency.
   */
  type Pending<T> = { tag: "pending"; factory: () => Promise<T>; index: number };
  type Resolved<T> = { tag: "resolved"; result: PromiseSettledResult<T>; index: number };
  type Slot<T> = Pending<T> | Resolved<T>;

  const slots: Slot<T>[] = tasks.map((fn, i) => ({ tag: "pending", factory: fn, index: i }));

  const limit = Math.min(maxConcurrency, tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      if (idx >= tasks.length) return;
      nextIndex += 1;
      const slot = slots[idx]!;
      if (slot.tag === "resolved") continue;
      // Only now call the factory — this is what enforces the concurrency limit
      const result = await Promise.allSettled([slot.factory()]).then(
        ([r]): PromiseSettledResult<T> => r,
      );
      slots[idx] = { tag: "resolved", result, index: slot.index };
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));

  // Reassemble in original index order, throwing on first rejection
  const ordered = slots
    .filter((s): s is Resolved<T> => s.tag === "resolved")
    .sort((a, b) => a.index - b.index);
  const results: T[] = new Array(ordered.length);
  for (const slot of ordered) {
    if (slot.result.status === "rejected") throw slot.result.reason;
    results[slot.index] = slot.result.value;
  }
  return results;
}

// ─── Main factory ────────────────────────────────────────────────────────────

/**
 * Create the `subagent` {@link Tool} that spawns nested agent loops.
 *
 * The returned tool can be added to any agent's tool set.  It handles
 * profile resolution, tool filtering, depth limiting, event
 * propagation, abort signal forwarding, timeout, and token tracking.
 */
export function createSubagentTool(options: SubagentToolOptions): Tool<SubagentArgs> {
  const {
    parentLlm,
    parentTools,
    profiles = [],
    preprocessors = [],
    signal,
    maxDepth = DEFAULT_MAX_DEPTH,
    currentDepth = 0,
    onSubagentEvent,
    chat: injectedChat,
    permissionMode,
    permissionTurn,
    getPermissionTurn,
    getPermissionMode,
    authorizeTool,
    timeout: constructorTimeout,
    thinkingMode: parentThinkingMode,
    maxThinkingEscalations: parentMaxEscalations,
    getParentHistory,
    parentRuntime,
  } = options;
  const globalBudgetState = options.globalBudgetState ?? (
    options.globalTokenBudget !== undefined
      ? { used: 0, limit: options.globalTokenBudget }
      : undefined
  );

  // Build the parameter schema dynamically to include available profile names.
  const profileEnum =
    profiles.length > 0
      ? profiles.map((p) => p.name)
      : undefined;

  const profileDescription = profiles.length > 0
    ? `Available profiles: ${profiles.map((p) => `"${p.name}" — ${p.description}`).join("; ")}.`
    : "No pre-defined profiles available. Use systemPrompt and tools for ad-hoc configuration.";

  return {
    name: SUBAGENT_TOOL_NAME,
    displayName: "Sub-Agent",
    description: [
      "Spawn a sub-agent to handle a focused sub-task independently.",
      "The sub-agent runs in its own context with its own tool set and returns a text result.",
      "Use this to delegate complex or independent pieces of work.",
      profileDescription,
    ].join(" "),
    annotations: {
      title: "Sub-Agent",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task description / prompt for the sub-agent.",
        },
        ...(profileEnum
          ? {
              profile: {
                type: "string",
                description: `Name of a pre-defined sub-agent profile. ${profileDescription}`,
                enum: profileEnum,
              },
            }
          : {}),
        systemPrompt: {
          type: "string",
          description:
            "Custom system prompt for the sub-agent (ignored when a profile is used).",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "List of tool names the sub-agent may use. Omit to inherit all parent tools (except subagent itself).",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          description: `Maximum turns for the sub-agent loop. Default: ${DEFAULT_MAX_TURNS}.`,
        },
        model: {
          type: "string",
          description:
            "Model identifier for this sub-agent (e.g. 'openai/gpt-4o-mini'). Overrides profile and parent model.",
        },
        sharedContext: {
          type: "string",
          description:
            "Background context from the parent agent. Prepended to the sub-agent's system prompt.",
        },
        thinkingMode: {
          type: "string",
          enum: ["fixed", "adaptive"],
          description:
            "Thinking mode for the sub-agent loop. 'adaptive' enables explainable effort escalation after tool failures.",
        },
        maxThinkingEscalations: {
          type: "integer",
          minimum: 0,
          description:
            "Maximum adaptive effort increases after tool or validation failures. Default: 2.",
        },
        contextPolicy: {
          type: "object",
          description:
            "Optional context compaction policy (same shape as parent loop's context option).",
        },
        skillNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Skill names to activate for this sub-agent loop.",
        },
        inheritContextHistory: {
          type: "boolean",
          description: "Whether to include the parent agent's current message history.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },

    execute: async (args: SubagentArgs, execSignal?: AbortSignal): Promise<import("../tools/types.ts").ToolResult> => {
      // ── Depth check ─────────────────────────────────────────────
      if (currentDepth >= maxDepth) {
        return {
          content: `Sub-agent nesting depth limit reached (max ${maxDepth}). Cannot spawn further sub-agents. Please complete this task directly.`,
          isError: true,
        };
      }

      const invocationId = randomUUID();
      const depth = currentDepth + 1;

      // ── Resolve configuration ───────────────────────────────────
      const profile = resolveProfile(args.profile, profiles);
      const baseSystemPrompt =
        profile?.systemPrompt ?? args.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;
      // Prepend shared context if provided
      const systemPrompt = args.sharedContext
        ? `[Shared context from parent agent]\n${args.sharedContext}\n[End shared context]\n\n${baseSystemPrompt}`
        : baseSystemPrompt;
      const allowedTools = profile?.allowedTools ?? args.tools;
      const maxTurns = args.maxTurns ?? profile?.maxTurns ?? DEFAULT_MAX_TURNS;
      // Resolve timeout: profile.timeout > constructor timeout
      const timeout = profile?.timeout ?? constructorTimeout;

      // ── Thinking mode & escalation: args > profile > parent > default ──
      const effectiveParentLlm = parentRuntime?.llm ?? parentLlm;
      const effectiveParentThinkingMode = parentRuntime?.thinkingMode ?? parentThinkingMode;
      const effectiveParentMaxEscalations = parentRuntime?.maxThinkingEscalations ?? parentMaxEscalations;
      const effectiveContextPolicy = args.contextPolicy ?? parentRuntime?.context;
      const inheritedParentHistory = args.inheritContextHistory
        ? parentRuntime?.history ?? getParentHistory?.()
        : undefined;
      const effectiveThinkingMode: ThinkingMode =
        args.thinkingMode ?? profile?.thinkingMode ?? effectiveParentThinkingMode ?? "fixed";
      const effectiveMaxEscalations =
        args.maxThinkingEscalations ?? profile?.maxThinkingEscalations ?? effectiveParentMaxEscalations ?? 2;

      // Model resolution: args.model > profile.llm > parentLlm
      // Track whether the model switch actually succeeded.
      let llm: LlmConfig = profile?.llm ?? effectiveParentLlm;
      let modelSwitchSucceeded = true;
      if (args.model) {
        try {
          llm = switchLlmModel(effectiveParentLlm, args.model);
        } catch (error) {
          // Explicit model override failed — return isError instead of
          // silently falling back to the profile or parent model.
          return {
            content: `model "${args.model}" not found or invalid: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      }

      if (globalBudgetState && globalBudgetState.used >= globalBudgetState.limit) {
        return {
          content: `Sub-agent global token budget exhausted (${globalBudgetState.limit}).`,
          isError: true,
        };
      }

      // Build runtime info for observability events
      const runtimeInfo = buildRuntimeInfo(
        llm,
        args.model,
        modelSwitchSucceeded,
        effectiveThinkingMode,
      );

      // ── Build child tool set ────────────────────────────────────
      const childTools = buildChildTools(parentTools, allowedTools, false);
      const childRuntimeRef: AgentRuntimeRef = {};

      // If the child is allowed to spawn sub-agents itself (depth < maxDepth),
      // add a nested subagent tool with incremented depth.
      if (depth < maxDepth) {
        const nestedSubagentTool = createSubagentTool({
          parentLlm: llm,
          parentTools: childTools,
          profiles,
          preprocessors,
          signal: execSignal ?? signal,
          maxDepth,
          currentDepth: depth,
          onSubagentEvent,
          chat: injectedChat,
          permissionMode,
          permissionTurn,
          getPermissionTurn,
          getPermissionMode,
          authorizeTool,
          timeout,
          thinkingMode: effectiveThinkingMode,
          maxThinkingEscalations: effectiveMaxEscalations,
          parentRuntime: childRuntimeRef,
          globalBudgetState,
          checkGlobalBudget: options.checkGlobalBudget,
        });
        childTools.push(nestedSubagentTool as Tool);
      }

      // ── Emit start event (with runtime info) ────────────────────
      onSubagentEvent?.({
        type: "subagent_start",
        id: invocationId,
        task: args.task,
        profile: args.profile,
        depth,
        runtime: runtimeInfo,
      });

      // ── Merge abort signals (fix: properly combine ALL signals) ─
      // On Node 18 we can't use AbortSignal.any(), so we use a manual
      // merge that fires when ANY source signal aborts.
      const signalsToMerge: (AbortSignal | undefined)[] = [execSignal, signal];

      // ── Timeout support ─────────────────────────────────────────
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timeoutController: AbortController | undefined;
      if (timeout && timeout > 0) {
        timeoutController = new AbortController();
        timeoutId = setTimeout(() => timeoutController!.abort(new Error("Sub-agent timeout exceeded")), timeout);
        signalsToMerge.push(timeoutController.signal);
      }

      const merged = mergeAbortSignals(...signalsToMerge);

      // ── Token tracking ──────────────────────────────────────────
      let accumulatedTokens = 0;
      type ErrorKind = "timeout" | "api" | "compaction" | "max_turns" | "abort";
      const errors: Array<{ message: string; kind: ErrorKind }> = [];

      // ── Run the nested loop ─────────────────────────────────────
      let finalMessages: AgentMessage[] = [];
      let success = true;
      let hitMaxTurns = false;

      try {
        finalMessages = await runAgentLoop(args.task, {
          llm,
          tools: childTools,
          systemPrompt,
          maxTurns,
          signal: merged.controller.signal,
          preprocessors,
          permissionMode,
          permissionTurn: getPermissionTurn?.() ?? permissionTurn,
          authorizeTool,
          ...(injectedChat ? { chat: injectedChat } : {}),
          // ── Pass through thinking mode & escalation ─────────────
          thinkingMode: effectiveThinkingMode,
          maxThinkingEscalations: effectiveMaxEscalations,
          // ── Pass through context policy if provided ─────────────
          ...(effectiveContextPolicy ? { context: effectiveContextPolicy } : {}),
          // ── Pass through skill names if provided ────────────────
          ...(args.skillNames && args.skillNames.length > 0
            ? { skillNames: args.skillNames }
            : {}),
          // ── Inherit parent history when requested ───────────────
          ...(inheritedParentHistory ? { _parentHistory: inheritedParentHistory } : {}),
          runtimeRef: childRuntimeRef,
          onEvent: (event: LoopEvent) => {
            // Accumulate token usage from assistant events
            if (event.type === "assistant" && event.usage) {
              const delta = event.usage.totalTokens;
              accumulatedTokens += delta;
              if (globalBudgetState) {
                globalBudgetState.used += delta;
                if (globalBudgetState.used > globalBudgetState.limit) {
                  throw new Error(`Sub-agent global token budget exceeded (${globalBudgetState.limit}).`);
                }
                options.checkGlobalBudget?.(globalBudgetState.used);
              } else {
                options.checkGlobalBudget?.(accumulatedTokens);
              }
            }

            // Capture notable errors for subagent_end reporting
            if (event.type === "error") {
              errors.push({ message: event.message, kind: "api" });
            }
            if (event.type === "max_turns") {
              hitMaxTurns = true;
              errors.push({
                message: `maxTurns exceeded (${event.maxTurns})`,
                kind: "max_turns",
              });
            }

            onSubagentEvent?.({
              type: "subagent_event",
              id: invocationId,
              inner: event,
              depth,
            });
          },
        });
      } catch (err) {
        // maxTurns is partial success when we already have messages/progress.
        if (err instanceof MaxTurnsExceededError || (err instanceof Error && err.name === "MaxTurnsExceededError")) {
          hitMaxTurns = true;
          finalMessages = err instanceof MaxTurnsExceededError
            ? err.messages
            : ((err as { messages?: AgentMessage[] }).messages ?? []);
          if (!errors.some((item) => item.kind === "max_turns")) {
            errors.push({
              message: err instanceof Error ? err.message : String(err),
              kind: "max_turns",
            });
          }
        } else {
          success = false;
          const errorMessage =
            err instanceof Error ? err.message : String(err);

          // Classify the error kind
          const isTimeout = timeoutController?.signal.aborted === true;

          if (isTimeout) {
            errors.push({ message: "Sub-agent timeout exceeded", kind: "timeout" });
          } else {
            errors.push({ message: errorMessage, kind: "api" });
          }

          onSubagentEvent?.({
            type: "subagent_end",
            id: invocationId,
            result: "",
            success: false,
            depth,
            turns: 0,
            totalTokens: accumulatedTokens,
            runtime: runtimeInfo,
            errors,
            autoDelegationInherited: false, // auto-delegation is deliberately not inherited
          });

          return {
            content: isTimeout
              ? `Sub-agent timed out after ${timeout}ms. Consider increasing the timeout or simplifying the task.`
              : `Sub-agent failed: ${errorMessage}`,
            isError: true,
          };
        }
      } finally {
        // Clean up timeout and signal listeners
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        merged.cleanup();
      }

      // ── Post-run timeout check ───────────────────────────────────
      // The timeout may have fired during runAgentLoop but not thrown
      // (e.g. when the injected chat completes before the timeout). Check
      // here to report it as a timeout error.
      if (timeoutController?.signal.aborted === true && !success) {
        // Already handled in catch above
      } else if (timeoutController?.signal.aborted === true) {
        // Timeout fired but runAgentLoop returned normally — treat as timeout
        onSubagentEvent?.({
          type: "subagent_end",
          id: invocationId,
          result: "",
          success: false,
          depth,
          turns: countTurns(finalMessages ?? []),
          totalTokens: accumulatedTokens,
          runtime: runtimeInfo,
          errors: [{ message: "Sub-agent timeout exceeded", kind: "timeout" }],
          autoDelegationInherited: false,
        });
        return {
          content: `Sub-agent timed out after ${timeout}ms. Consider increasing the timeout or simplifying the task.`,
          isError: true,
        };
      }

      // ── Extract best available result (including partial progress) ─
      const extracted = extractBestAnswer(finalMessages ?? []);
      const turns = countTurns(finalMessages ?? []);
      const toolCallCount = countToolCalls(finalMessages ?? []);
      const partial = extracted.partial || hitMaxTurns;
      // Partial progress is still useful to the parent; only hard-fail when
      // we truly recovered nothing.
      success = extracted.text.length > 0;

      onSubagentEvent?.({
        type: "subagent_end",
        id: invocationId,
        result: extracted.text,
        success,
        depth,
        turns,
        totalTokens: accumulatedTokens,
        runtime: runtimeInfo,
        errors: errors.length > 0 ? errors : undefined,
        autoDelegationInherited: false, // auto-delegation is intentionally isolated per subagent
      });

      if (!extracted.text) {
        return {
          content: hitMaxTurns
            ? `Sub-agent stopped after maxTurns=${maxTurns} without recoverable progress. Narrow the task or raise maxTurns.`
            : "Sub-agent completed but produced no final answer.",
          isError: true,
        };
      }

      const headerBits: string[] = [];
      if (hitMaxTurns) {
        headerBits.push(
          `Partial result: stopped at maxTurns=${maxTurns}. Continue from this progress or spawn another focused subagent.`,
        );
      } else if (extracted.partial) {
        headerBits.push(
          "Partial result: no clean final summary was produced; recovered the best available progress below.",
        );
      }

      const summary = formatExecSummary({
        turns,
        toolCallCount,
        tokens: accumulatedTokens,
        errorCount: errors.length,
        modelFallback: !modelSwitchSucceeded && Boolean(args.model),
        partial,
      });

      const content = [
        ...headerBits,
        summary,
        "",
        extracted.text,
      ].join("\n");

      // Recoverable partial results are returned without isError so the parent
      // keeps coordinating instead of treating the whole delegation as failed.
      return { content };
    },
  };
}

// ─── Parallel batch tool ──────────────────────────────────────────────────────

const SUBAGENT_BATCH_TOOL_NAME = "subagent_batch";

/**
 * Create the `subagent_batch` {@link Tool} that runs multiple subagents in parallel.
 *
 * Each task in the batch spawns an independent subagent via the single
 * `createSubagentTool`, and all tasks execute concurrently (optionally
 * bounded by `maxConcurrency`) using a token-bucket semaphore.
 * Results are collected in order and returned as a combined text result.
 */
export function createSubagentBatchTool(options: SubagentToolOptions): Tool<SubagentBatchArgs> {
  const singleTool = createSubagentTool(options);
  const { profiles = [] } = options;

  const profileEnum =
    profiles.length > 0
      ? profiles.map((p) => p.name)
      : undefined;

  return {
    name: SUBAGENT_BATCH_TOOL_NAME,
    displayName: "Parallel Sub-Agents",
    description: [
      "Run multiple sub-agents in parallel. Each task spawns an independent sub-agent that executes concurrently.",
      "Use this when you have multiple independent sub-tasks that can be done simultaneously.",
      "Results are collected and returned together once all sub-agents complete.",
      "Optionally control concurrency with `maxConcurrency` to avoid overwhelming rate limits.",
    ].join(" "),
    annotations: {
      title: "Parallel Sub-Agents",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Unique label for this task." },
              task: { type: "string", description: "Task prompt for the sub-agent." },
              ...(profileEnum
                ? { profile: { type: "string", enum: profileEnum, description: "Profile to use." } }
                : {}),
              model: { type: "string", description: "Optional model override." },
              maxTurns: { type: "integer", minimum: 1, description: "Max turns override." },
              sharedContext: { type: "string", description: "Shared context for this task." },
              thinkingMode: {
                type: "string",
                enum: ["fixed", "adaptive"],
                description: "Thinking mode override.",
              },
              maxThinkingEscalations: {
                type: "integer",
                minimum: 0,
                description: "Max adaptive escalations override.",
              },
              contextPolicy: {
                type: "object",
                description: "Context compaction policy override.",
              },
              skillNames: {
                type: "array",
                items: { type: "string" },
                description: "Skill names override.",
              },
              inheritContextHistory: {
                type: "boolean",
                description: "Whether to include the parent's current message history.",
              },
            },
            required: ["label", "task"],
          },
          description: "Array of tasks to run in parallel.",
          minItems: 1,
          maxItems: 10,
        },
        maxConcurrency: {
          type: "integer",
          minimum: 0,
          description: "Maximum concurrent sub-agents. 0 or omitted means all run concurrently.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },

    execute: async (args: SubagentBatchArgs, execSignal?: AbortSignal): Promise<import("../tools/types.ts").ToolResult> => {
      if (!args.tasks || args.tasks.length === 0) {
        return { content: "No tasks provided for batch execution.", isError: true };
      }

      const maxConcurrency = args.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY_BATCH;
      const globalLimit = options.globalConcurrencyLimit ?? 0;

      // Run all tasks respecting both local and global concurrency limits.
      // runWithConcurrency throws on first rejection; callers get a single error.
      const settled = await runWithConcurrency(
        args.tasks.map((task: SubagentBatchTask) => async () => {
          // Wait for a global concurrency slot if limit is set
          await acquireGlobalSlot(globalLimit, execSignal);
          try {
            return await singleTool.execute(
              {
                task: task.task,
                profile: task.profile,
                model: task.model,
                maxTurns: task.maxTurns,
                sharedContext: task.sharedContext,
                thinkingMode: task.thinkingMode,
                maxThinkingEscalations: task.maxThinkingEscalations,
                contextPolicy: task.contextPolicy,
                skillNames: task.skillNames,
                inheritContextHistory: task.inheritContextHistory,
              },
              execSignal,
            );
          } finally {
            releaseGlobalSlot();
          }
        }),
        maxConcurrency,
      ).catch((reason): import("../tools/types.ts").ToolResult[] => {
        // On error, return error results for all tasks so we still produce output.
        return args.tasks.map(() => ({ content: String(reason), isError: true }));
      });

      // Collect results in order
      const parts: string[] = [];
      for (let i = 0; i < args.tasks.length; i++) {
        const task = args.tasks[i]!;
        const outcome = settled[i]!;
        const header = `── ${task.label} ──`;

        const content = typeof outcome.content === "string"
          ? outcome.content
          : "[complex content]";
        parts.push(`${header}\n${outcome.isError ? "[ERROR] " : ""}${content}`);
      }

      const hasErrors = settled.some((s) => s.isError);

      return {
        content: parts.join("\n\n"),
        isError: hasErrors ? true : undefined,
      };
    },
  };
}

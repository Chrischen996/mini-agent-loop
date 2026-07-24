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
import { runAgentLoop, type LoopEvent } from "../loop.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../tools/types.ts";
import type {
  SubagentArgs,
  SubagentEvent,
  SubagentProfile,
  SubagentToolOptions,
} from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_MAX_DEPTH = 3;
const SUBAGENT_TOOL_NAME = "subagent";

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  "You are a focused sub-agent. Complete the given task precisely and return a clear, concise result.",
  "Do not ask follow-up questions — work with the information provided.",
  "When you have finished the task, respond with your final answer directly.",
].join("\n");

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
 * Extract the final assistant text from the completed message list.
 * Walks backward to find the last assistant message.
 */
function extractFinalAnswer(
  messages: import("../types.ts").AgentMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      return contentAsString(msg.content);
    }
  }
  return "";
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
  } = options;

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
      const systemPrompt =
        profile?.systemPrompt ?? args.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;
      const allowedTools = profile?.allowedTools ?? args.tools;
      const maxTurns = args.maxTurns ?? profile?.maxTurns ?? DEFAULT_MAX_TURNS;
      const timeout = profile?.timeout;
      const llm = profile?.llm ?? parentLlm;

      // ── Build child tool set ────────────────────────────────────
      const childTools = buildChildTools(parentTools, allowedTools, false);

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
        });
        childTools.push(nestedSubagentTool as Tool);
      }

      // ── Emit start event ────────────────────────────────────────
      onSubagentEvent?.({
        type: "subagent_start",
        id: invocationId,
        task: args.task,
        profile: args.profile,
        depth,
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

      // ── Run the nested loop ─────────────────────────────────────
      let finalMessages: import("../types.ts").AgentMessage[];
      let success = true;

      try {
        finalMessages = await runAgentLoop(args.task, {
          llm,
          tools: childTools,
          systemPrompt,
          maxTurns,
          signal: merged.controller.signal,
          preprocessors,
          ...(injectedChat ? { chat: injectedChat } : {}),
          onEvent: (event: LoopEvent) => {
            // Accumulate token usage from assistant events
            if (event.type === "assistant" && event.usage) {
              accumulatedTokens += event.usage.totalTokens;
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
        success = false;
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        const isTimeout = timeoutController?.signal.aborted === true;

        onSubagentEvent?.({
          type: "subagent_end",
          id: invocationId,
          result: "",
          success: false,
          depth,
          turns: 0,
          totalTokens: accumulatedTokens,
        });

        return {
          content: isTimeout
            ? `Sub-agent timed out after ${timeout}ms. Consider increasing the timeout or simplifying the task.`
            : `Sub-agent failed: ${errorMessage}`,
          isError: true,
        };
      } finally {
        // Clean up timeout and signal listeners
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        merged.cleanup();
      }

      // ── Extract result ──────────────────────────────────────────
      const finalAnswer = extractFinalAnswer(finalMessages);
      // Count turns (assistant messages = turns)
      const turns = finalMessages.filter((m) => m.role === "assistant").length;

      onSubagentEvent?.({
        type: "subagent_end",
        id: invocationId,
        result: finalAnswer,
        success,
        depth,
        turns,
        totalTokens: accumulatedTokens,
      });

      if (!finalAnswer) {
        return {
          content: "Sub-agent completed but produced no final answer.",
          isError: true,
        };
      }

      return { content: finalAnswer };
    },
  };
}

// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import { contentAsString } from "../content.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import { PERMISSION_MODES, type PermissionMode } from "../permissions.ts";
import type { SessionPhase, ExecutionPlan, PlanActEvent } from "../plan-act/types.ts";
import type { PlanDocument } from "../plan/document.ts";
import { isTodoRevisionNewer, nextTodoRevision, TODO_WRITE_TOOL_NAME, type TodoItem, type TodoViewMode } from "../todo.ts";
import { executionPlanToTodoItems } from "./todo-format.ts";
import { permissionModeLabel, toolArgumentSummary } from "./claude-style.ts";
import { toolVisualName } from "./tool-lines.ts";
import { compactText } from "./text-utils.ts";

export type { PermissionMode } from "../permissions.ts";
export type { SessionPhase } from "../plan-act/types.ts";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolState = "running" | "done" | "error";

/** Global thinking display mode for extended reasoning (DeepSeek / Claude). */
export type ThinkingDisplayMode = "hidden" | "summary" | "full";

export const THINKING_MODE_ORDER: ThinkingDisplayMode[] = ["hidden", "summary", "full"];

export type ToolCardState = {
  id: string;
  name: string;
  args?: string;
  preview?: string;
  status: ToolState;
  startedAt?: number;
  durationMs?: number;
};

export type PendingPermissionState = {
  requestId: string;
  sessionId: string;
  tool: string;
  /** Read-only snapshot used by the presentation card; never used to decide permission. */
  arguments?: Record<string, unknown>;
  risk: "safe" | "medium" | "high";
};

export type WorkflowStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
};

export type SubagentInnerEvent = {
  type: string;
  label: string;
  detail?: string;
};

export type ImageAttachment = {
  path: string;
  mimeType: string;
  size?: number;
  data?: string; // base64
};

export type ChatMessage =
  | { kind: "user"; text: string; displayText?: string; images?: ImageAttachment[] }
  | { kind: "assistant"; text: string; reasoning?: string }
  | { kind: "notice"; title?: string; text: string }
  | { kind: "tool_call"; id: string; name: string; args: string; rawArgs: Record<string, unknown>; status: ToolState; result?: string; durationMs?: number; startedAt: number }
  | { kind: "subagent_call"; id: string; task: string; profile?: string; depth: number; status: ToolState; result?: string; turns?: number; totalTokens?: number; tokenBreakdown?: import("../subagent/types.ts").SubagentTokenBreakdown; estimatedCost?: import("../subagent/types.ts").SubagentCost; lastToolInfo?: string; innerEvents: SubagentInnerEvent[]; toolCallCount: number; startedAt: number; durationMs?: number; expanded: boolean }
  | { kind: "error"; text: string };

export type TuiState = {
  messages: ChatMessage[];
  /** First user prompt in the active conversation. */
  goal: string;
  /** Tool-backed steps shown in the workflow sidebar. */
  steps: WorkflowStep[];
  /** Workspace paths seen in tool arguments during this conversation. */
  touchedFiles: string[];
  /** Tool activity cards, kept separately from the chat feed for the sidebar. */
  toolCards: ToolCardState[];
  /** Independent task checklist maintained by the agent. */
  todos: TodoItem[];
  streamingText: string;
  streamingReasoning: string;
  /** Wall-clock start of the active user turn; presentation-only. */
  turnStartedAt?: number;
  /** Last streamed reasoning/answer delta; used to surface a stalled stream. */
  lastStreamAt?: number;
  /** Track context compaction events for /context command. */
  contextCompactions: { before: number; after: number; reason: string; turn: number }[];
  busy: boolean;
  status: string;
  modelName: string;
  usedTokens: number;
  contextTokens: number;
  /** Cache hit tokens from last assistant response. */
  cacheReadTokens?: number;
  /** Pending images attached via /image command. */
  pendingImages: ImageAttachment[];
  /** Global default for how thinking blocks are shown. */
  thinkingMode: ThinkingDisplayMode;
  /** Currently active permission mode. */
  permissionMode: PermissionMode;
  /** Current Plan-Act workflow phase. */
  phase: SessionPhase;
  /** Currently active execution plan. */
  currentPlan?: ExecutionPlan;
  /** Persisted file-backed plan shown as the Todo list in the TUI. */
  todoPlan?: PlanDocument;
  /** Session-scoped TodoWrite list; it takes precedence over todoPlan while active. */
  todoItems?: TodoItem[];
  todoRevision: number;
  todoViewMode: TodoViewMode;
  /** Spinner tip shown below the todo panel while no tools are active. Cleared on tool start. */
  spinnerMessage?: string;
  /** Pending permission request shown to the user while execution waits. */
  pendingPermission?: PendingPermissionState;
  /**
   * Message indices whose thinking is force-expanded (overrides summary).
   * Stored as a sorted unique array for stable React updates.
   */
  expandedThinking: number[];
  /** Currently focused message index for keyboard navigation; -1 = none. */
  focusedMessageIndex: number;
  /**
   * Number of visual terminal rows below the viewport.
   * 0 = stick to bottom (show latest).
   */
  scrollOffset: number;
};

export type TuiAction =
  | { type: "USER_MESSAGE"; text: string; displayText?: string; images?: ImageAttachment[] }
  | {
      type: "RESTORE_SESSION";
      history: AgentMessage[];
      permissionMode: PermissionMode;
      modelName?: string;
      thinkingMode?: ThinkingDisplayMode;
      phase?: SessionPhase;
      currentPlan?: ExecutionPlan;
      todos?: TodoItem[];
      todoRevision?: number;
    }
  | { type: "LOOP_EVENT"; event: LoopEvent }
  | { type: "PLAN_ACT_EVENT"; event: PlanActEvent }
  | { type: "AUTO_CONTINUE"; count: number; max: number }
  | { type: "MODEL_CHANGED"; modelName: string }
  | { type: "SET_STATUS"; status: string }
  | { type: "SET_TODOS"; todos: TodoItem[] }
  | { type: "RESET" }
  | { type: "CANCEL_GENERATION" }
  | { type: "TOGGLE_THINKING_MODE" }
  | { type: "TOGGLE_PERMISSION_MODE" }
  | { type: "SET_PERMISSION_MODE"; mode: PermissionMode }
  | { type: "APPROVE_PLAN"; planId: string }
  | { type: "REJECT_PLAN"; planId: string; reason?: string }
  | { type: "SET_TODO_PLAN"; plan?: PlanDocument }
  | { type: "SET_TODO_ITEMS"; todos: TodoItem[]; revision: number }
  | { type: "CLEAR_TODO_ITEMS" }
  | { type: "SET_TODO_VIEW_MODE"; mode: TodoViewMode }
  | { type: "CLEAR_SPINNER_MESSAGE" }
  | { type: "CLEAR_PENDING_PERMISSION" }
  | { type: "TOGGLE_MESSAGE_THINKING"; index?: number }
  | { type: "SET_FOCUSED_MESSAGE"; index: number }
  | { type: "FOCUS_NEXT_REASONING"; direction: 1 | -1 }
  | { type: "SUBAGENT_EVENT"; event: SubagentEvent }
  | { type: "TOGGLE_SUBAGENT_EXPAND"; id: string }
  | { type: "ADD_PENDING_IMAGE"; image: ImageAttachment }
  | { type: "CLEAR_PENDING_IMAGES" }
  | { type: "ATTACHMENT_ERROR"; message: string }
  | { type: "ADD_NOTICE"; title?: string; text: string }
  | { type: "SCROLL_BY"; delta: number }
  | { type: "SCROLL_TO"; offset: number }
  | { type: "SCROLL_TO_BOTTOM" };

function toolTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "pattern", "command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const target = toolTarget(args);
  return compactText(target ? `${name} ${target}` : name, 48, "…");
}

function toolPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "source", "destination", "from", "to"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() && !paths.includes(value.trim())) {
      paths.push(value.trim());
    }
  }
  return paths;
}

function updateExecutionTodo(
  state: TuiState,
  stepId: string,
  status: TodoItem["status"],
  error?: string,
): TuiState {
  const items = state.todoItems ?? (state.currentPlan ? executionPlanToTodoItems(state.currentPlan) : []);
  if (items.length === 0) return state;
  return {
    ...state,
    todoItems: items.map((item) => item.id === stepId ? { ...item, status, ...(error ? { error } : {}) } : item),
    todoRevision: nextTodoRevision(),
  };
}

function resultPreview(content: unknown): string {
  if (typeof content === "string") return compactText(content, 180, "…");
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join(" ");
    return text ? compactText(text, 180, "…") : "[binary]";
  }
  return "";
}

/** Preserve line breaks for the transcript while keeping unbounded tool
 * output from taking over the frame. Sidebar cards continue using preview(). */
function resultContent(content: unknown, max = 4000): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  const normalized = text.trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function createInitialState(modelName: string): TuiState {
  return {
    messages: [],
    goal: "",
    steps: [],
    touchedFiles: [],
    toolCards: [],
    todos: [],
    streamingText: "",
    streamingReasoning: "",
    turnStartedAt: undefined,
    lastStreamAt: undefined,
    busy: false,
    status: "Ready",
    modelName,
    usedTokens: 0,
    contextTokens: 0,
    cacheReadTokens: undefined,
    thinkingMode: "summary",
    permissionMode: "plan",
    pendingPermission: undefined,
    expandedThinking: [],
    focusedMessageIndex: -1,
    pendingImages: [],
    contextCompactions: [],
    scrollOffset: 0,
    phase: "planning",
    todoPlan: undefined,
    todoItems: undefined,
    todoRevision: 0,
    // Match Claude Code: keep the task list compact during normal work;
    // users can expand it with Ctrl+T or /tasks expanded.
    todoViewMode: "compact",
    spinnerMessage: undefined,
  };
}

/** Indices of assistant messages that carry reasoning content. */
export function reasoningMessageIndices(messages: ChatMessage[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.kind === "assistant" && msg.reasoning) indices.push(i);
  }
  return indices;
}

/**
 * Reducer-level append operations retain the current row offset. App.tsx adds
 * the measured row-height delta after render so wrapped text stays anchored.
 */
export function preserveScrollOnAppend(
  scrollOffset: number,
  previousCount: number,
  nextCount: number,
): number {
  // Stick to bottom when pinned; otherwise preserve visual position.
  if (scrollOffset === 0) return 0;
  return Math.max(0, scrollOffset + (nextCount - previousCount));
}

/**
 * Project persisted AgentMessage history into the reducer's chat feed.
 *
 * Agent history is the source of truth for the loop; this projection is only
 * presentation state used by the TUI after a session resume. Tool calls are
 * paired with their later tool results by id so resumed conversations retain
 * the same compact activity cards as a live turn.
 */
export function chatMessagesFromAgentHistory(history: readonly AgentMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolCards = new Map<string, Extract<ChatMessage, { kind: "tool_call" }>>();

  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      messages.push({ kind: "user", text: contentAsString(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = contentAsString(message.content);
      const toolCalls = message.toolCalls ?? [];
      // Always emit an assistant ChatMessage when there is text content.
      // For tool-only turns (empty text but with tool calls), emit a minimal
      // assistant marker so the conversation flow is visible after resume.
      if (text || toolCalls.length === 0) {
        messages.push({ kind: "assistant", text: text || "" });
      }
      for (const call of toolCalls) {
        const card: Extract<ChatMessage, { kind: "tool_call" }> = {
          kind: "tool_call",
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.arguments ?? {}),
          rawArgs: call.arguments ?? {},
          status: "running",
          startedAt: Date.now(),
        };
        messages.push(card);
        toolCards.set(call.id, card);
      }
      continue;
    }
    const card = toolCards.get(message.toolCallId);
    const result = resultPreviewForChat(message.content);
    if (card) {
      card.status = message.isError ? "error" : "done";
      card.result = result;
      card.durationMs = 0;
    } else {
      messages.push({
        kind: "tool_call",
        id: message.toolCallId,
        name: message.name,
        args: "{}",
        rawArgs: {},
        status: message.isError ? "error" : "done",
        result,
        startedAt: Date.now(),
        durationMs: 0,
      });
    }
  }
  return messages;
}

function resultPreviewForChat(content: MessageContent): string {
  // Kept as a small local formatter to avoid importing reducer internals into
  // the persistence layer. The actual content shape is handled defensively.
  if (typeof content === "string") return content.trim().slice(0, 4000);
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim()
      .slice(0, 4000);
  }
  return "";
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "USER_MESSAGE":
      return {
        ...state,
        messages: [...state.messages, {
          kind: "user",
          text: action.text,
          ...(action.displayText !== undefined ? { displayText: action.displayText } : {}),
          ...(action.images?.length ? { images: action.images } : {}),
        }],
        goal: state.goal || action.text,
        busy: true,
        status: "Thinking…",
        streamingText: "",
        streamingReasoning: "",
        turnStartedAt: Date.now(),
        lastStreamAt: undefined,
        // New user turns always re-pin the feed to the latest content.
        scrollOffset: 0,
      };

    case "RESTORE_SESSION": {
      const messages = chatMessagesFromAgentHistory(action.history);
      const firstUser = messages.find((message): message is Extract<ChatMessage, { kind: "user" }> => message.kind === "user");
      return {
        ...createInitialState(action.modelName ?? state.modelName),
        thinkingMode: action.thinkingMode ?? state.thinkingMode,
        permissionMode: action.permissionMode,
        messages,
        goal: firstUser?.text ?? "",
        phase: action.phase ?? "planning",
        currentPlan: action.currentPlan,
        todoPlan: state.todoPlan,
        todoItems: action.todos && action.todos.length > 0 ? action.todos : undefined,
        todoRevision: action.todoRevision ?? nextTodoRevision(),
        status: "Session resumed",
      };
    }

    case "RESET":
      return {
        ...createInitialState(state.modelName),
        thinkingMode: state.thinkingMode,
        permissionMode: state.permissionMode,
        todoPlan: state.todoPlan,
        todoViewMode: state.todoViewMode,
        todoRevision: nextTodoRevision(),
      };

    case "SET_TODO_PLAN":
      return {
        ...state,
        todoPlan: action.plan,
        todoItems: undefined,
        todoRevision: nextTodoRevision(),
      };

    case "SET_TODO_ITEMS":
      if (!isTodoRevisionNewer(state.todoRevision, action.revision)) return state;
      return {
        ...state,
        todoItems: action.todos,
        todoRevision: action.revision,
      };

    case "CLEAR_TODO_ITEMS":
      return {
        ...state,
        todoItems: undefined,
        todoRevision: nextTodoRevision(),
      };

    case "SET_TODO_VIEW_MODE":
      return { ...state, todoViewMode: action.mode };
    case "CLEAR_SPINNER_MESSAGE":
      return { ...state, spinnerMessage: undefined };
    case "MODEL_CHANGED":
      return { ...state, modelName: action.modelName, status: "Ready", usedTokens: 0, contextTokens: 0 };

    case "SET_STATUS":
      return { ...state, status: action.status };

    case "SET_TODOS":
      return {
        ...state,
        todos: action.todos,
        todoItems: action.todos.length > 0 ? action.todos : undefined,
        todoRevision: nextTodoRevision(),
      };

    case "CANCEL_GENERATION":
      return {
        ...state,
        busy: false,
        streamingText: "",
        streamingReasoning: "",
        turnStartedAt: undefined,
        lastStreamAt: undefined,
        status: "Generation cancelled (ESC)",
      };

    case "AUTO_CONTINUE":
      return {
        ...state,
        busy: true,
        streamingText: "",
        streamingReasoning: "",
        lastStreamAt: undefined,
        status: `Continuing… (${action.count}/${action.max})`,
      };

    case "CLEAR_PENDING_PERMISSION":
      return {
        ...state,
        pendingPermission: undefined,
        // The request is resolved (allowed or denied), so the status moves on
        // to the tool itself instead of repeating "Waiting for permission".
        status: state.pendingPermission ? `Running ${state.pendingPermission.tool}…` : state.status,
      };

    case "TOGGLE_THINKING_MODE": {
      const current = THINKING_MODE_ORDER.indexOf(state.thinkingMode);
      const next = THINKING_MODE_ORDER[(current + 1) % THINKING_MODE_ORDER.length] ?? "summary";
      return {
        ...state,
        thinkingMode: next,
        expandedThinking: [],
        status:
          next === "hidden" ? "Thinking display: hidden"
            : next === "summary" ? "Thinking display: summary"
              : "Thinking display: full",
      };
    }

    case "TOGGLE_PERMISSION_MODE": {
      const current = PERMISSION_MODES.indexOf(state.permissionMode);
      const next = PERMISSION_MODES[(current + 1) % PERMISSION_MODES.length] ?? "plan";
      const modeLabel = permissionModeLabel(next);
      return {
        ...state,
        permissionMode: next,
        status: `Permission mode: ${modeLabel}`,
      };
    }

    case "SET_PERMISSION_MODE": {
      const modeLabel = permissionModeLabel(action.mode);
      return {
        ...state,
        permissionMode: action.mode,
        pendingPermission: undefined,
        status: `Permission mode: ${modeLabel}`,
      };
    }

    case "TOGGLE_MESSAGE_THINKING": {
      const indices = reasoningMessageIndices(state.messages);
      if (indices.length === 0) return state;
      const target =
        typeof action.index === "number"
          ? action.index
          : state.focusedMessageIndex >= 0
            ? state.focusedMessageIndex
            : indices[indices.length - 1]!;
      if (!indices.includes(target)) return state;
      const expanded = new Set(state.expandedThinking);
      if (expanded.has(target)) expanded.delete(target);
      else expanded.add(target);
      return {
        ...state,
        expandedThinking: [...expanded].sort((a, b) => a - b),
        focusedMessageIndex: target,
      };
    }

    case "SET_FOCUSED_MESSAGE":
      return { ...state, focusedMessageIndex: action.index };

    case "FOCUS_NEXT_REASONING": {
      const indices = reasoningMessageIndices(state.messages);
      if (indices.length === 0) return { ...state, focusedMessageIndex: -1 };
      const currentPos = indices.indexOf(state.focusedMessageIndex);
      let nextPos: number;
      if (currentPos < 0) {
        nextPos = action.direction === 1 ? 0 : indices.length - 1;
      } else {
        nextPos = (currentPos + action.direction + indices.length) % indices.length;
      }
      return { ...state, focusedMessageIndex: indices[nextPos]! };
    }

    case "LOOP_EVENT": {
      const event = action.event;
      switch (event.type) {
        case "todo_updated":
          if (!isTodoRevisionNewer(state.todoRevision, event.revision)) return state;
          const nextTodoTask = event.todos.find(t => t.status !== "completed");
          return {
            ...state,
            todoItems: event.todos,
            todoRevision: event.revision,
            status: "Todos updated",
            spinnerMessage: nextTodoTask ? `▶ ${nextTodoTask.activeForm}` : undefined,
          };

        case "assistant_delta":
          return {
            ...state,
            streamingText: event.kind === "answer"
              ? state.streamingText + event.text
              : state.streamingText,
            streamingReasoning: event.kind === "reasoning"
              ? state.streamingReasoning + event.text
              : state.streamingReasoning,
            lastStreamAt: Date.now(),
            status: "Responding…",
          };

        case "assistant": {
          // Prefer streamed text; the final assistant event often has content=""
          const contentText = typeof event.message.content === "string"
            ? event.message.content
            : "";
          const text = contentText || state.streamingText;
          const reasoning = state.streamingReasoning || undefined;
          const hasTools = (event.message.toolCalls?.length ?? 0) > 0;
          // Only skip if we genuinely have nothing to show
          if (!text && !reasoning && !hasTools) return { ...state, streamingText: "", streamingReasoning: "" };
          const assistantMsg: ChatMessage = { kind: "assistant", text: text || "", ...(reasoning ? { reasoning } : {}) };
          const newMessages: ChatMessage[] = (text || reasoning)
            ? [...state.messages, assistantMsg]
            : state.messages;
          const usedTokens = event.usage?.totalTokens ?? state.usedTokens;
          const contextTokens = event.usage?.promptTokens ?? state.contextTokens;
          const cacheReadTokens = event.usage?.cacheReadTokens ?? state.cacheReadTokens;
          return {
            ...state,
            messages: newMessages,
            streamingText: "",
            streamingReasoning: "",
            status: hasTools ? "Running tool…" : "Finalizing response…",
            usedTokens,
            contextTokens,
            cacheReadTokens,
            scrollOffset: preserveScrollOnAppend(
              state.scrollOffset,
              state.messages.length,
              newMessages.length,
            ),
          };
        }

        case "error": {
          const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: event.message }];
          return {
            ...state,
            busy: false,
            messages: newMessages,
            streamingText: "",
            streamingReasoning: "",
            turnStartedAt: undefined,
            lastStreamAt: undefined,
            pendingPermission: undefined,
            status: "Request failed",
            scrollOffset: preserveScrollOnAppend(
              state.scrollOffset,
              state.messages.length,
              newMessages.length,
            ),
          };
        }

        case "attempt_reset":
          return {
            ...state,
            streamingText: "",
            streamingReasoning: "",
            lastStreamAt: undefined,
            status: event.reason === "stream_truncated"
              ? `Connection lost, retrying (${event.attempt})…`
              : `Incomplete reasoning, retrying (${event.attempt})…`,
          };

        case "retry_attempt":
          return {
            ...state,
            streamingText: "",
            streamingReasoning: "",
            lastStreamAt: undefined,
            status: event.errorType === "timeout"
              ? `Request timed out, retrying (${event.attempt}/${event.maxRetries})…`
              : `Request failed, retrying (${event.attempt}/${event.maxRetries})…`,
          };

        case "max_turns":
          return {
            ...state,
            streamingText: "",
            streamingReasoning: "",
            status: `Turn limit reached (${event.maxTurns}), continuing…`,
          };

        case "context_compacted":
          return {
            ...state,
            contextTokens: event.afterTokens,
            status: `Context compacted ${event.beforeTokens} → ${event.afterTokens} tokens`,
          };

        case "plan_act_event":
          // Keep plan lifecycle events on the same reducer path regardless of
          // whether they arrive from Ink or the standalone terminal service.
          return tuiReducer(state, { type: "PLAN_ACT_EVENT", event: event.event });

        case "auto_subagent":
          return {
            ...state,
            status: event.executed
              ? `Auto subagent started (${event.profile}, score=${event.score})`
              : event.shouldDelegate
                ? `Subagent delegation suggested (${event.profile}, score=${event.score})`
                : `No auto delegation (score=${event.score})`,
          };

        case "coordinator_mode":
          return {
            ...state,
            status: event.active
              ? `Orchestration: ${event.profile} (exploration ${event.directExplorationUsed}/${event.maxDirectExploration})`
              : "Orchestration disabled",
          };

        case "thinking_policy":
          return {
            ...state,
            status: `Adaptive thinking: ${event.level} (${event.reasons.join(", ")})`,
          };

        case "tool_start": {
          if (event.call.name === TODO_WRITE_TOOL_NAME) {
            return { ...state, status: "Updating todos…" };
          }
          const rawArgs = (event.call.arguments ?? {}) as Record<string, unknown>;
          const args = compactText(JSON.stringify(rawArgs), 120, "…");
          const startedAt = Date.now();
          const paths = toolPaths(rawArgs);
          const card: ChatMessage = {
            kind: "tool_call",
            id: event.call.id,
            name: event.call.name,
            args,
            rawArgs,
            status: "running",
            startedAt,
          };
          const sidebarCard: ToolCardState = {
            id: event.call.id,
            name: event.call.name,
            args,
            status: "running",
            startedAt,
          };
          const step: WorkflowStep = {
            id: event.call.id,
            label: toolLabel(event.call.name, rawArgs),
            status: "running",
          };
          const newMessages: ChatMessage[] = [...state.messages, card];
          return {
            ...state,
            messages: newMessages,
            steps: [...state.steps.filter((item) => item.id !== step.id), step],
            touchedFiles: [...state.touchedFiles, ...paths.filter((path) => !state.touchedFiles.includes(path))].slice(-50),
            toolCards: [...state.toolCards.filter((item) => item.id !== sidebarCard.id), sidebarCard],
            status: `${event.call.name}...`,
            spinnerMessage: undefined,
            scrollOffset: preserveScrollOnAppend(
              state.scrollOffset,
              state.messages.length,
              newMessages.length,
            ),
          };
        }

        case "tool_end": {
          if (event.call.name === TODO_WRITE_TOOL_NAME) {
            return {
              ...state,
              status: event.result.isError ? "Todo update failed" : "Todos updated",
            };
          }
          if (event.call.name === "validate_workspace") {
            return {
              ...state,
              status: event.result.isError ? "Post-edit verification failed, repairing" : "Post-edit verification passed",
              spinnerMessage: undefined,
            };
          }
          const now = Date.now();
          const result = resultPreview(event.result.content);
          const transcriptResult = resultContent(event.result.content);
          const updatedMessages = state.messages.map((m) => {
            if (m.kind === "tool_call" && m.id === event.call.id) {
              return {
                ...m,
                status: (event.result.isError ? "error" : "done") as ToolState,
                result: transcriptResult,
                durationMs: now - m.startedAt,
              };
            }
            return m;
          });
          const updatedCards = state.toolCards.map((card) => {
            if (card.id !== event.call.id) return card;
            return {
              ...card,
              status: event.result.isError ? "error" : "done",
              preview: result || undefined,
              durationMs: card.startedAt ? Math.max(0, now - card.startedAt) : undefined,
            } satisfies ToolCardState;
          });
          const updatedSteps = state.steps.map((step) =>
            step.id === event.call.id
              ? { ...step, status: event.result.isError ? ("error" as const) : ("done" as const) }
              : step,
          );
          return {
            ...state,
            messages: updatedMessages,
            steps: updatedSteps,
            toolCards: updatedCards,
            status: event.result.isError ? `${event.call.name} failed` : `${event.call.name} completed`,
            spinnerMessage: undefined,
          };
        }

        case "permission_required":
          return {
            ...state,
            pendingPermission: {
              requestId: event.request.id,
              sessionId: event.request.sessionId,
              tool: event.request.tool,
              arguments: event.request.arguments,
              risk: event.request.risk,
            },
            status: `Waiting for permission: ${event.request.tool} (${event.request.risk}) [A allow / D deny / Enter deny / Esc cancel]`,
          };

        case "aborted":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            turnStartedAt: undefined,
            lastStreamAt: undefined,
            pendingPermission: undefined,
            status: "Aborted",
          };

        case "done":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            turnStartedAt: undefined,
            lastStreamAt: undefined,
            pendingPermission: undefined,
            status: "Ready",
          };

        default:
          return state;
      }
    }

    case "PLAN_ACT_EVENT": {
      const event = action.event;
      switch (event.type) {
        case "planning_started":
          return { ...state, phase: "planning", status: "Planning…" };
        case "plan_generated":
          return {
            ...state,
            phase: "review",
            currentPlan: event.plan,
            todoItems: executionPlanToTodoItems(event.plan),
            todoRevision: nextTodoRevision(),
            status: "Plan ready for review (A approve / R reject)",
          };
        case "plan_approved":
          return {
            ...state,
            phase: "acting",
            currentPlan: state.currentPlan?.status === "approved"
              ? state.currentPlan
              : state.currentPlan
                ? { ...state.currentPlan, status: "approved" as const }
                : undefined,
            status: "Executing…",
          };
        case "plan_rejected":
          return {
            ...state,
            phase: "cancelled",
            currentPlan: undefined,
            status: "Plan rejected",
          };
        case "plan_modified":
          return {
            ...state,
            phase: "review",
            currentPlan: event.plan,
            status: "Plan revised, waiting for review (A approve / R reject)",
          };
        case "acting_started":
          return { ...state, phase: "acting", status: "Executing plan…" };
        case "step_started":
          return {
            ...updateExecutionTodo(state, event.stepId, "in_progress"),
            status: `Running: ${event.step.description.slice(0, 30)}…`,
          };
        case "step_completed":
          return {
            ...updateExecutionTodo(state, event.stepId, "completed"),
            status: "Step completed",
          };
        case "step_failed":
          return {
            ...updateExecutionTodo(state, event.stepId, "failed", event.error),
            status: `Step failed: ${event.error.slice(0, 50)}`,
          };
        case "all_steps_completed":
          return {
            ...state,
            phase: "completed",
            currentPlan: state.currentPlan
              ? { ...state.currentPlan, status: "completed" as const }
              : undefined,
            todoItems: state.todoItems?.map((item) => ({ ...item, status: "completed" })),
            todoRevision: nextTodoRevision(),
            status: "Plan execution completed",
          };
        case "execution_failed":
          return {
            ...state,
            phase: "failed",
            currentPlan: state.currentPlan
              ? { ...state.currentPlan, status: "failed" as const }
              : undefined,
            todoItems: state.todoItems?.map((item) => item.status === "completed" ? item : { ...item, status: "failed" }),
            todoRevision: nextTodoRevision(),
            status: "Execution failed",
          };
        default:
          return state;
      }
    }

    case "APPROVE_PLAN": {
      const plan = state.currentPlan;
      if (!plan || plan.status !== "pending_review") return state;
      return {
        ...state,
        currentPlan: { ...plan, status: "approved" as const },
        phase: "acting",
        status: "Plan approved, executing…",
      };
    }
    
    case "REJECT_PLAN": {
      const plan = state.currentPlan;
      if (!plan) return state;
      return {
        ...state,
        currentPlan: { ...plan, status: "rejected" as const },
        phase: "cancelled",
        status: "Plan rejected",
      };
    }

    case "SUBAGENT_EVENT": {
      const evt = action.event;
      switch (evt.type) {
        case "subagent_start": {
          const card: ChatMessage = {
            kind: "subagent_call",
            id: evt.id,
            task: evt.task,
            profile: evt.profile,
            depth: evt.depth,
            status: "running",
            innerEvents: [],
            toolCallCount: 0,
            startedAt: Date.now(),
            expanded: false,
          };
          const newMessages: ChatMessage[] = [...state.messages, card];
          return {
            ...state,
            messages: newMessages,
            status: `Delegating (depth ${evt.depth})…`,
            scrollOffset: preserveScrollOnAppend(
              state.scrollOffset,
              state.messages.length,
              newMessages.length,
            ),
          };
        }
        case "subagent_event": {
          const inner = evt.inner;
          const label =
            inner.type === "tool_start" ? `▶ ${inner.call.name}`
            : inner.type === "tool_end" ? `${inner.result.isError ? "✗" : "✓"} ${inner.call.name}`
            : inner.type === "assistant" ? "💬 assistant"
            : inner.type === "error" ? `✗ ${inner.message}`
            : inner.type;
          const detail =
            inner.type === "tool_start" ? compactText(JSON.stringify(inner.call.arguments), 80, "…")
            : inner.type === "tool_end" ? compactText(typeof inner.result.content === "string" ? inner.result.content : "[complex]", 80, "…")
            : undefined;
          const isToolEnd = inner.type === "tool_end";
          const lastToolInfo = inner.type === "tool_start"
            ? (() => {
                const summary = toolArgumentSummary(inner.call.name, inner.call.arguments, JSON.stringify(inner.call.arguments)).replace(/^\$\s*/, "");
                return `${toolVisualName(inner.call.name)}${summary ? `(${summary})` : ""}`;
              })()
            : undefined;
          return {
            ...state,
            messages: state.messages.map((m) => {
              if (m.kind === "subagent_call" && m.id === evt.id) {
                return {
                  ...m,
                  innerEvents: [...m.innerEvents, { type: inner.type, label, detail }],
                  toolCallCount: m.toolCallCount + (isToolEnd ? 1 : 0),
                  ...(lastToolInfo ? { lastToolInfo } : {}),
                };
              }
              return m;
            }),
          };
        }
        case "budget_warning": {
          return {
            ...state,
            status: `Budget warning ${evt.percentage}%`,
            messages: state.messages.map((m) => {
              if (m.kind === "subagent_call" && m.id === evt.id) {
                return {
                  ...m,
                  innerEvents: [
                    ...m.innerEvents,
                    {
                      type: "budget_warning",
                      label: `⚠ budget ${evt.percentage}% (${evt.used}/${evt.limit})`,
                    },
                  ],
                };
              }
              return m;
            }),
          };
        }
        case "subagent_end": {
          const now = Date.now();
          return {
            ...state,
            messages: state.messages.map((m) => {
              if (m.kind === "subagent_call" && m.id === evt.id) {
                return {
                  ...m,
                  status: evt.success ? "done" as const : "error" as const,
                  result: evt.result,
                  turns: evt.turns,
                  totalTokens: evt.totalTokens || undefined,
                  tokenBreakdown: evt.tokenBreakdown,
                  estimatedCost: evt.estimatedCost,
                  durationMs: now - m.startedAt,
                };
              }
              return m;
            }),
            status: evt.success ? "Subagent done" : "Subagent failed",
          };
        }
        default:
          return state;
      }
    }

    case "TOGGLE_SUBAGENT_EXPAND": {
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.kind === "subagent_call" && m.id === action.id) {
            return { ...m, expanded: !m.expanded };
          }
          return m;
        }),
      };
    }

    case "ADD_PENDING_IMAGE": {
      const exists = state.pendingImages.some((img) => img.path === action.image.path);
      if (exists) return state;
      return {
        ...state,
        pendingImages: [...state.pendingImages, action.image],
        status: `Attached image: ${action.image.path.split("/").pop() ?? action.image.path}`,
      };
    }

    case "CLEAR_PENDING_IMAGES":
      return { ...state, pendingImages: [] };

    case "ATTACHMENT_ERROR": {
      const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: action.message }];
      return {
        ...state,
        messages: newMessages,
        status: "Unable to attach image",
        scrollOffset: preserveScrollOnAppend(
          state.scrollOffset,
          state.messages.length,
          newMessages.length,
        ),
      };
    }

    case "ADD_NOTICE": {
      const messages: ChatMessage[] = [
        ...state.messages,
        { kind: "notice", text: action.text, ...(action.title ? { title: action.title } : {}) },
      ];
      return { ...state, messages, status: "Ready", scrollOffset: 0 };
    }

    case "SCROLL_BY": {
      const next = Math.max(0, state.scrollOffset + action.delta);
      return next === state.scrollOffset ? state : { ...state, scrollOffset: next };
    }

    case "SCROLL_TO": {
      const next = Math.max(0, action.offset);
      return next === state.scrollOffset ? state : { ...state, scrollOffset: next };
    }

    case "SCROLL_TO_BOTTOM":
      return state.scrollOffset === 0 ? state : { ...state, scrollOffset: 0 };

    default:
      return state;
  }
}

export type TuiStore = {
  getState: () => TuiState;
  dispatch: (action: TuiAction) => void;
  subscribe: (listener: () => void) => () => void;
};

/** Store adapter shared by React Ink and the standalone terminal entrypoint. */
export function createTuiStore(initialState: TuiState): TuiStore {
  let current = initialState;
  const listeners = new Set<() => void>();
  return {
    getState: () => current,
    dispatch: (action) => {
      const next = tuiReducer(current, action);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

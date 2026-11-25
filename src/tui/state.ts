// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import { contentAsString } from "../content.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import { PERMISSION_MODES, type PermissionMode } from "../permissions.ts";
import type { SessionPhase, ExecutionPlan, PlanActEvent } from "../plan-act/types.ts";
import type { PlanDocument } from "../plan/document.ts";
import {
  isTodoRevisionNewer,
  nextTodoRevision,
  type TodoItem,
  type TodoViewMode
} from "../todo.ts";
import { reduceLoopEvent } from "./state/loop-events.ts";
import { reduceSubagentEvent, toggleSubagentExpand } from "./state/subagent-events.ts";
import { reducePlanActEvent } from "./state/plan-events.ts";
import {
  reduceAutoContinue,
  reduceCancelGeneration,
  reduceContinueTurn,
  reduceUserMessage
} from "./state/turn-actions.ts";
import { compactText } from "./text-utils.ts";

export type { PermissionMode } from "../permissions.ts";
export type { SessionPhase } from "../plan-act/types.ts";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolState = "running" | "done" | "partial" | "error";

/** Global thinking display mode for extended reasoning (DeepSeek / Claude). */
export type ThinkingDisplayMode = "hidden" | "summary" | "full";

export type TaskSummaryStatus = "running" | "completed" | "failed" | "cancelled" | "paused";

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

/**
 * A model-initiated permission-mode request awaiting a one-key decision.
 *
 * The model cannot switch the mode itself: it calls `request_permission_mode`,
 * which lands here. `A` applies the switch through the `PermissionManager`,
 * `D`/Esc dismisses it and keeps the current mode.
 */
export type PendingModeRequestState = {
  mode: PermissionMode;
  reason: string;
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
  /** Dynamic subagent card snapshots are normalized beside the transcript. */
  subagentById: Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>;
  /** Dynamic tool snapshots are normalized beside the transcript. */
  toolById: Record<string, Extract<ChatMessage, { kind: "tool_call" }>>;
  /** O(1) lookup for lifecycle updates targeting transcript entries. */
  subagentIndexById: Record<string, number>;
  toolIndexById: Record<string, number>;
  /** Monotonic revisions for normalized dynamic transcript overlays. */
  subagentRevision: number;
  toolRevision: number;
  /** The most recent overlay update, used for targeted viewport cache repair. */
  subagentChange?: { id: string; index: number; revision: number };
  toolChange?: { id: string; index: number; revision: number };
  /** Most recently started parent tool, for O(1) activity rendering. */
  activeToolId?: string;
  /** First user prompt in the active conversation. */
  goal: string;
  /** Root task metadata used by the completed checklist projection. */
  taskTitle: string;
  taskStatus: TaskSummaryStatus;
  taskStartedAt?: number;
  taskDurationMs?: number;
  taskTokens: number;
  /** Tool-backed steps shown in the workflow sidebar. */
  steps: WorkflowStep[];
  /** Workspace paths seen in tool arguments during this conversation. */
  touchedFiles: string[];
  /** Tool activity cards, kept separately from the chat feed for the sidebar. */
  toolCards: ToolCardState[];
  /** Independent task checklist maintained by the agent. */
  todos: TodoItem[];
  /** Bounded text shown by the live renderer; full output stays in chunks. */
  streamingText: string;
  streamingReasoning: string;
  streamingTextParts: string[];
  streamingReasoningParts: string[];
  /**
   * Answer text already frozen into the document stream before an automatic
   * retry. The renderer keeps it as the seal-dedup baseline instead of
   * freezing the regenerated stream again.
   */
  streamRetryCommittedText?: string;
  /**
   * Document layout: the assistant message that just finished streaming,
   * together with the source text of the rows already frozen into the
   * terminal's native scrollback by the commit channel. While an
   * un-sealable interactive entry (e.g. a subagent card) blocks the sealed
   * prefix, the frame must drop those frozen body rows so the answer is not
   * rendered a second time. Survives until the message is actually sealed
   * or the turn ends / is interrupted.
   */
  streamSealPending?: {
    message: Extract<ChatMessage, { kind: "assistant" }>;
    committedText: string;
  };
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
  /** Active Todo label for the activity row; hidden there when TodoPanel already shows it. */
  spinnerMessage?: string;
  /** Pending permission request shown to the user while execution waits. */
  pendingPermission?: PendingPermissionState;
  /** Pending model-initiated mode switch awaiting A/D. */
  pendingModeRequest?: PendingModeRequestState;
  /** Pending todo run plan awaiting user confirmation before execution. */
  pendingTodoRunPlan?: PendingTodoRunPlan;
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
  /** Maximum scroll offset allowed by the viewport height and content size. */
  maxScrollOffset?: number;
  /** Auto-continue state for max_tokens truncation handling */
  autoContinueCount: number;
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
      /** Unanswered model mode request that survived the restart. */
      pendingModeRequest?: PendingModeRequestState;
    }
  | { type: "LOOP_EVENT"; event: LoopEvent }
  | { type: "PLAN_ACT_EVENT"; event: PlanActEvent }
  | { type: "AUTO_CONTINUE"; count: number; max: number }
  | { type: "CONTINUE_TURN" }
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
  | { type: "CLEAR_MODE_REQUEST" }
  | { type: "SET_TODO_RUN_PLAN"; plan: PendingTodoRunPlan }
  | { type: "CLEAR_TODO_RUN_PLAN" }
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
  | { type: "SCROLL_TO_BOTTOM" }
  | { type: "SET_MAX_SCROLL_OFFSET"; offset: number }
  | { type: "CLEAR_STREAM_RETRY_BASELINE" };

function toolTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "pattern", "command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function toolLabel(name: string, args: Record<string, unknown>): string {
  const target = toolTarget(args);
  return compactText(target ? `${name} ${target}` : name, 48, "…");
}

export function toolPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "source", "destination", "from", "to"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() && !paths.includes(value.trim())) {
      paths.push(value.trim());
    }
  }
  return paths;
}

export function resultPreview(content: unknown): string {
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
export function resultContent(content: unknown, max = 4000): string {
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
    subagentById: {},
    toolById: {},
    subagentIndexById: {},
    toolIndexById: {},
    subagentRevision: 0,
    toolRevision: 0,
    goal: "",
    taskTitle: "",
    taskStatus: "completed",
    taskStartedAt: undefined,
    taskDurationMs: undefined,
    taskTokens: 0,
    steps: [],
    touchedFiles: [],
    toolCards: [],
    todos: [],
    streamingText: "",
    streamingReasoning: "",
    streamingTextParts: [],
    streamingReasoningParts: [],
    streamRetryCommittedText: undefined,
    streamSealPending: undefined,
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
    pendingModeRequest: undefined,
    pendingTodoRunPlan: undefined,
    expandedThinking: [],
    focusedMessageIndex: -1,
    pendingImages: [],
    contextCompactions: [],
    scrollOffset: 0,
    // maxScrollOffset is intentionally absent (undefined) until AgentSessionApp.tsx
    // measures the viewport and dispatches SET_MAX_SCROLL_OFFSET. The
    // reducer falls back to no clamp when it is unset.
    phase: "planning",
    todoPlan: undefined,
    todoItems: undefined,
    todoRevision: 0,
    // Match Claude Code: keep the task list compact during work;
    // users can expand it with Ctrl+T or /tasks expanded.
    todoViewMode: "compact",
    spinnerMessage: undefined,
    autoContinueCount: 0,
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
      const reasoning = (message.thinking ?? [])
        .map((part) => part.thinking)
        .filter((thinking) => thinking.trim().length > 0)
        .join("\n");
      // Emit an assistant message when it has text or reasoning. Tool-only
      // and fully empty turns draw no marker row; the tool cards emitted below
      // carry the conversation flow after resume.
      if (text || reasoning) {
        messages.push({ kind: "assistant", text, ...(reasoning ? { reasoning } : {}) });
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

const MAX_STREAMING_PREVIEW_CHARS = 16_000;
const MAX_STREAMING_PARTS = 512; // cap chunk array length to avoid unbounded growth during long streams

export function appendStreamingPreview(previous: string, chunk: string): string {
  if (!chunk) return previous;
  const combined = previous + chunk;
  if (combined.length <= MAX_STREAMING_PREVIEW_CHARS) return combined;
  return `… ${combined.slice(-(MAX_STREAMING_PREVIEW_CHARS - 2))}`;
}

/** Append a chunk to the parts array, capping total length to prevent memory bloat. */
export function appendStreamingParts(previous: string[], chunk: string | undefined): string[] {
  if (!chunk) return previous;
  const next = [...previous, chunk];
  if (next.length > MAX_STREAMING_PARTS) {
    // Drop the oldest half; the newest parts are most useful for the .join() fallback
    return next.slice(next.length - MAX_STREAMING_PARTS / 2);
  }
  return next;
}

export function taskDuration(startedAt?: number): number | undefined {
  return startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
}

/**
 * When the in-memory UI transcript grows past this many messages, the oldest
 * entries are dropped from memory but remain in the persisted session snapshot
 * (so rewind/fork/restore can still reach them). This bounds memory WITHOUT
 * truncating the scrollback the user can page through during a session — only
 * the in-memory live window is capped. Set via `MINI_AGENT_TUI_TRANSCRIPT_OFFLOAD`.
 *
 * Default is 0 (offload disabled): the full transcript stays resident in memory
 * so scrolling is always physically continuous with zero reconstruction
 * latency, matching Antigravity CLI. The persisted snapshot and the model-
 * context compaction still bound on-disk/context growth, and an operator can
 * set a positive threshold to re-enable the memory safety net on pathologically
 * long sessions.
 */
export const TRANSCRIPT_OFFLOAD_THRESHOLD = (() => {
  const raw = Number(process.env.MINI_AGENT_TUI_TRANSCRIPT_OFFLOAD);
  if (Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
  return 0;
})();

/**
 * Maximum entries kept in the tool/subagent lookup dictionaries.
 * Stale entries (no longer referenced by state.messages) are pruned first;
 * if still over the cap, the oldest entries are dropped.
 */
const MAX_DICT_ENTRIES = 500;

/** Keep only the most recent compaction records; older ones are presentation-only. */
const MAX_CONTEXT_COMPACTIONS = 50;

/**
 * Offload the oldest transcript entries from memory once the transcript grows
 * past `TRANSCRIPT_OFFLOAD_THRESHOLD`. Offloaded messages stay in the persisted
 * session snapshot, so rewind/fork/restore still reach them; only the in-memory
 * live transcript drops them. This bounds memory WITHOUT truncating the
 * scrollback the user can page through (that would re-introduce the old
 * "stuck after 500 messages" behaviour). Returns the same array unchanged when
 * offload is disabled (`TRANSCRIPT_OFFLOAD_THRESHOLD === 0`) or not yet hit.
 */
export function offloadTranscript(messages: readonly ChatMessage[]): ChatMessage[] {
  if (TRANSCRIPT_OFFLOAD_THRESHOLD <= 0) return messages as ChatMessage[];
  if (messages.length <= TRANSCRIPT_OFFLOAD_THRESHOLD) return messages as ChatMessage[];
  const keepFrom = messages.length - TRANSCRIPT_OFFLOAD_THRESHOLD;
  const firstUserIdx = messages.findIndex((m) => m.kind === "user");
  const offloaded: ChatMessage[] = [];
  // Always preserve the first user message (goal prompt) even if it falls
  // outside the retained window, so the conversation origin stays reachable.
  if (firstUserIdx >= 0 && firstUserIdx < keepFrom) {
    offloaded.push(messages[firstUserIdx]!);
  }
  offloaded.push(...messages.slice(keepFrom));
  return offloaded;
}
/**
 * Prune stale tool/subagent lookup dictionaries that no longer reference a
 * transcript message. Never truncates the visible transcript — scrolling must
 * remain available for the full canonical history. Memory is bounded by
 * `offloadTranscript` (offload to disk-backed snapshot) and by `historyRef`
 * compaction in AgentSessionApp.tsx, not by deleting UI history.
 */
export function pruneTranscriptAndDictionaries(state: TuiState): TuiState {
  const messages = offloadTranscript(state.messages);
  const { subagent, tools } = messageIndices(messages);
  const subagentById = Object.fromEntries(
    Object.entries(state.subagentById).filter(([id]) => id in subagent),
  );
  const toolById = Object.fromEntries(
    Object.entries(state.toolById).filter(([id]) => id in tools),
  );
  const subagentIndexById = subagent;
  const toolIndexById = tools;

  // Cap dictionary size by dropping oldest entries if still over the limit.
  const capDict = <T extends Record<string, unknown>>(dict: T): T => {
    const keys = Object.keys(dict);
    if (keys.length <= MAX_DICT_ENTRIES) return dict;
    const keep = keys.slice(keys.length - MAX_DICT_ENTRIES);
    return Object.fromEntries(keep.map((k) => [k, dict[k]])) as T;
  };

  return {
    ...state,
    messages,
    subagentById: capDict(subagentById),
    toolById: capDict(toolById),
    subagentIndexById,
    toolIndexById,
    // steps and toolCards are keyed by tool id; drop entries no longer in messages
    steps: state.steps.filter((step) => step.id in tools),
    toolCards: state.toolCards.filter((card) => card.id in tools),
    // Cap the compaction log to prevent unbounded growth on very long sessions.
    contextCompactions: state.contextCompactions.length > MAX_CONTEXT_COMPACTIONS
      ? state.contextCompactions.slice(-MAX_CONTEXT_COMPACTIONS)
      : state.contextCompactions,
  };
}

export function todoSpinnerMessage(todos: readonly TodoItem[]): string | undefined {
  const activeTodo = todos.find((todo) => todo.status === "in_progress");
  return activeTodo ? `▶ ${activeTodo.activeForm}` : undefined;
}

export function messageIndices(messages: readonly ChatMessage[]): {
  subagent: Record<string, number>;
  tools: Record<string, number>;
} {
  const subagent: Record<string, number> = {};
  const tools: Record<string, number> = {};
  for (let position = 0; position < messages.length; position++) {
    const message = messages[position];
    if (message?.kind === "subagent_call") subagent[message.id] = position;
    else if (message?.kind === "tool_call") tools[message.id] = position;
  }
  return { subagent, tools };
}

export function resolveSubagentMessage(
  message: ChatMessage,
  subagentById: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>,
): ChatMessage {
  return message.kind === "subagent_call" ? subagentById[message.id] ?? message : message;
}

export function resolveTranscriptMessage(
  message: ChatMessage,
  subagentById: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>> = {},
  toolById: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>> = {},
): ChatMessage {
  if (message.kind === "subagent_call") return subagentById[message.id] ?? message;
  if (message.kind === "tool_call") return toolById[message.id] ?? message;
  return message;
}

export function updateSubagentMessage(
  state: TuiState,
  id: string,
  update: (message: Extract<ChatMessage, { kind: "subagent_call" }>) => Extract<ChatMessage, { kind: "subagent_call" }>,
): TuiState {
  const position = state.subagentIndexById[id];
  if (position === undefined) return state;
  const base = state.messages[position];
  if (!base || base.kind !== "subagent_call") return state;
  const current = state.subagentById[id] ?? base;
  const next = update(current);
  if (next === current) return state;
  // The transcript keeps a stable card object for compatibility with callers
  // that inspect `state.messages` directly. Only the normalized overlay map is
  // replaced, so the large transcript array is never copied on this hot path.
  Object.assign(base, next);
  const revision = state.subagentRevision + 1;
  const updated: TuiState = {
    ...state,
    subagentById: { ...state.subagentById, [id]: next },
    subagentRevision: revision,
    subagentChange: { id, index: position, revision },
  };
  // Hot-path lifecycle updates never copy the transcript array: the overlay
  // maps hold the normalized state, and pruning is deferred to the append
  // sites (USER_MESSAGE, tool_start, done, AUTO_CONTINUE).
  return updated;
}

export function updateToolMessage(
  state: TuiState,
  id: string,
  update: (message: Extract<ChatMessage, { kind: "tool_call" }>) => Extract<ChatMessage, { kind: "tool_call" }>,
): TuiState {
  const position = state.toolIndexById[id];
  if (position === undefined) return state;
  const base = state.messages[position];
  if (!base || base.kind !== "tool_call") return state;
  const current = state.toolById[id] ?? base;
  const next = update(current);
  if (next === current) return state;
  // Preserve direct `state.messages` readers while avoiding a transcript copy.
  Object.assign(base, next);
  const revision = state.toolRevision + 1;
  return {
    ...state,
    toolById: { ...state.toolById, [id]: next },
    toolRevision: revision,
    toolChange: { id, index: position, revision },
    activeToolId: next.status === "running" ? id : state.activeToolId === id ? undefined : state.activeToolId,
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "USER_MESSAGE":
      return reduceUserMessage(state, action);

    case "RESTORE_SESSION": {
      const messages = chatMessagesFromAgentHistory(action.history);
      const firstUser = messages.find((message): message is Extract<ChatMessage, { kind: "user" }> => message.kind === "user");
      return {
        ...createInitialState(action.modelName ?? state.modelName),
        thinkingMode: action.thinkingMode ?? state.thinkingMode,
        permissionMode: action.permissionMode,
        messages,
        subagentById: Object.fromEntries(messages.filter((message): message is Extract<ChatMessage, { kind: "subagent_call" }> => message.kind === "subagent_call").map((message) => [message.id, message])),
        toolById: Object.fromEntries(messages.filter((message): message is Extract<ChatMessage, { kind: "tool_call" }> => message.kind === "tool_call").map((message) => [message.id, message])),
        subagentIndexById: messageIndices(messages).subagent,
        toolIndexById: messageIndices(messages).tools,
        goal: firstUser?.text ?? "",
        taskTitle: firstUser?.text ?? "",
        taskStatus: "completed",
        taskStartedAt: undefined,
        taskDurationMs: undefined,
        taskTokens: 0,
        phase: action.phase ?? "planning",
        currentPlan: action.currentPlan,
        // A card restored from disk must not offer a switch that already
        // happened while the process was down (e.g. the user changed the mode
        // from another client). Drop it when it matches the restored mode.
        pendingModeRequest: action.pendingModeRequest
          && action.pendingModeRequest.mode !== action.permissionMode
          ? action.pendingModeRequest
          : undefined,
        todoPlan: state.todoPlan,
        todos: action.todos ?? [],
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
        taskTitle: "",
        taskStatus: "completed",
        taskStartedAt: undefined,
        taskDurationMs: undefined,
        taskTokens: 0,
        todoPlan: state.todoPlan,
        todoViewMode: state.todoViewMode,
        todoRevision: nextTodoRevision(),
      };

    case "SET_TODO_PLAN":
      return {
        ...state,
        todoPlan: action.plan,
        todos: [],
        todoItems: undefined,
        todoRevision: nextTodoRevision(),
        spinnerMessage: undefined,
      };

    case "SET_TODO_ITEMS":
      if (!isTodoRevisionNewer(state.todoRevision, action.revision)) return state;
      return {
        ...state,
        todos: action.todos,
        todoItems: action.todos,
        todoRevision: action.revision,
        spinnerMessage: todoSpinnerMessage(action.todos),
      };

    case "CLEAR_TODO_ITEMS":
      return {
        ...state,
        todos: [],
        todoItems: undefined,
        todoRevision: nextTodoRevision(),
        spinnerMessage: undefined,
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
        spinnerMessage: todoSpinnerMessage(action.todos),
      };

    case "CANCEL_GENERATION":
      return reduceCancelGeneration(state);

    case "CONTINUE_TURN":
      return reduceContinueTurn(state);

    case "AUTO_CONTINUE":
      return reduceAutoContinue(state, action);

    case "CLEAR_PENDING_PERMISSION":
      return {
        ...state,
        pendingPermission: undefined,
        // The request is resolved (allowed or denied), so the status moves on
        // to the tool itself instead of repeating "Waiting for permission".
        status: state.pendingPermission ? `Running ${state.pendingPermission.tool}…` : state.status,
      };

    case "CLEAR_MODE_REQUEST":
      return {
        ...state,
        pendingModeRequest: undefined,
        // The card is gone, so a status that only described the card would be
        // stale ("Mode switch requested: bypass" surviving a Shift+Tab that
        // already changed the mode).
        status: state.status.startsWith("Mode switch requested") ? "Ready" : state.status,
      };

    case "SET_TODO_RUN_PLAN": {
      return {
        ...state,
        pendingTodoRunPlan: action.plan,
        status: "Todo run plan ready — press A to execute / Esc to cancel",
      };
    }

    case "CLEAR_TODO_RUN_PLAN":
      return {
        ...state,
        pendingTodoRunPlan: undefined,
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
      return {
        ...state,
        permissionMode: next,
        status: state.status.startsWith("Permission mode:") ? "Ready" : state.status,
      };
    }

    case "SET_PERMISSION_MODE": {
      return {
        ...state,
        permissionMode: action.mode,
        pendingPermission: undefined,
        // Any explicit mode change answers a pending model request: keeping the
        // card would offer a switch that already happened (for example after
        // `/plan-run` forces bypass while the model asked for bypass).
        pendingModeRequest: undefined,
        status: state.status.startsWith("Permission mode:") || state.status.startsWith("Mode switch requested")
          ? "Ready"
          : state.status,
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

    case "LOOP_EVENT":
      return reduceLoopEvent(state, action.event, tuiReducer);

    case "PLAN_ACT_EVENT":
      return reducePlanActEvent(state, action.event);

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

    case "SUBAGENT_EVENT":
      return reduceSubagentEvent(state, action.event);

    case "TOGGLE_SUBAGENT_EXPAND":
      return toggleSubagentExpand(state, action.id);

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
      const baseNext: TuiState = {
        ...state,
        messages: newMessages,
        status: "Unable to attach image",
      };
      return pruneTranscriptAndDictionaries(baseNext);
    }

    case "ADD_NOTICE": {
      const baseNext: TuiState = {
        ...state,
        messages: [...state.messages, {
          kind: "notice",
          text: action.text,
          ...(action.title ? { title: action.title } : {}),
        }],
        status: state.busy ? state.status : "Ready",
        scrollOffset: 0,
      };
      return pruneTranscriptAndDictionaries(baseNext);
    }

    case "SCROLL_BY": {
      const max = state.maxScrollOffset;
      const next = max === undefined
        ? Math.max(0, state.scrollOffset + action.delta)
        : Math.max(0, Math.min(max, state.scrollOffset + action.delta));
      if (next === state.scrollOffset) return state;
      return { ...state, scrollOffset: next };
    }

    case "SCROLL_TO": {
      const max = state.maxScrollOffset;
      const next = max === undefined
        ? Math.max(0, action.offset)
        : Math.max(0, Math.min(max, action.offset));
      return next === state.scrollOffset ? state : { ...state, scrollOffset: next };
    }

    case "SCROLL_TO_BOTTOM":
      return state.scrollOffset === 0 ? state : { ...state, scrollOffset: 0 };

    case "SET_MAX_SCROLL_OFFSET": {
      if (state.maxScrollOffset === action.offset) return state;
      const clamped =
        action.offset == null
          ? state.scrollOffset
          : Math.max(0, Math.min(action.offset, state.scrollOffset));
      return { ...state, maxScrollOffset: action.offset, scrollOffset: clamped };
    }

    case "CLEAR_STREAM_RETRY_BASELINE":
      return state.streamRetryCommittedText === undefined
        ? state
        : { ...state, streamRetryCommittedText: undefined };

    default:
      return state;
  }
}

export type TuiStore = {
  getState: () => TuiState;
  dispatch: (action: TuiAction) => void;
  subscribe: (listener: () => void) => () => void;
};

/** Headless store adapter over the same reducer used by the Ink UI. */
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

// Pending todo run plan for user confirmation before execution.
export type PendingTodoRunPlan = {
  plan: import('../todos/index.ts').RunnerPlan;
  parsed: import('../todos/index.ts').ParsedTodosRunArgs;
  todos: TodoItem[];
};

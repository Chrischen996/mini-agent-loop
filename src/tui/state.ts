// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import { PERMISSION_MODES, type PermissionMode } from "../permissions.ts";
import type { SessionPhase, ExecutionPlan, PlanActEvent } from "../plan-act/types.ts";
import type { TodoItem } from "../tools/todo.ts";
import type { PlanDocument } from "../plan/document.ts";
import { isTodoRevisionNewer, nextTodoRevision, TODO_WRITE_TOOL_NAME, type TodoItem, type TodoViewMode } from "../todo.ts";
import { executionPlanToTodoItems } from "./todo-format.ts";

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
  | { kind: "subagent_call"; id: string; task: string; profile?: string; depth: number; status: ToolState; result?: string; turns?: number; totalTokens?: number; tokenBreakdown?: import("../subagent/types.ts").SubagentTokenBreakdown; estimatedCost?: import("../subagent/types.ts").SubagentCost; innerEvents: SubagentInnerEvent[]; toolCallCount: number; startedAt: number; durationMs?: number; expanded: boolean }
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

function shortPreview(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function toolTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "pattern", "command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const target = toolTarget(args);
  return shortPreview(target ? `${name} ${target}` : name, 48);
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
  if (typeof content === "string") return shortPreview(content, 180);
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join(" ");
    return text ? shortPreview(text, 180) : "[binary]";
  }
  return "";
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
    busy: false,
    status: "就绪",
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
    todoViewMode: "expanded",
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
        status: "思考中...",
        streamingText: "",
        streamingReasoning: "",
        // New user turns always re-pin the feed to the latest content.
        scrollOffset: 0,
      };

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

    case "MODEL_CHANGED":
      return { ...state, modelName: action.modelName, status: "就绪", usedTokens: 0, contextTokens: 0 };

    case "SET_STATUS":
      return { ...state, status: action.status };

    case "SET_TODOS":
      return { ...state, todos: action.todos };

    case "CANCEL_GENERATION":
      return {
        ...state,
        busy: false,
        streamingText: "",
        streamingReasoning: "",
        status: "Generation cancelled (ESC)",
      };

    case "AUTO_CONTINUE":
      return {
        ...state,
        busy: true,
        streamingText: "",
        streamingReasoning: "",
        status: `自动续跑 (${action.count}/${action.max})...`,
      };

    case "CLEAR_PENDING_PERMISSION":
      return {
        ...state,
        pendingPermission: undefined,
        status: state.pendingPermission ? `正在执行 ${state.pendingPermission.tool}...` : state.status,
      };

    case "TOGGLE_THINKING_MODE": {
      const current = THINKING_MODE_ORDER.indexOf(state.thinkingMode);
      const next = THINKING_MODE_ORDER[(current + 1) % THINKING_MODE_ORDER.length] ?? "summary";
      return {
        ...state,
        thinkingMode: next,
        expandedThinking: [],
        status:
          next === "hidden" ? "思考过程: 隐藏"
            : next === "summary" ? "思考过程: 摘要"
              : "思考过程: 完整",
      };
    }

    case "TOGGLE_PERMISSION_MODE": {
      const current = PERMISSION_MODES.indexOf(state.permissionMode);
      const next = PERMISSION_MODES[(current + 1) % PERMISSION_MODES.length] ?? "plan";
      const modeLabel = next === "plan" ? "计划" : next === "approval" ? "审批" : "绕过";
      return {
        ...state,
        permissionMode: next,
        status: `权限模式: ${modeLabel}`,
      };
    }

    case "SET_PERMISSION_MODE": {
      const modeLabel = action.mode === "plan" ? "计划" : action.mode === "approval" ? "审批" : "绕过";
      return {
        ...state,
        permissionMode: action.mode,
        pendingPermission: undefined,
        status: `权限模式: ${modeLabel}`,
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
          return {
            ...state,
            todoItems: event.todos,
            todoRevision: event.revision,
            status: "任务列表已更新",
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
            status: "输出中...",
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
            status: hasTools ? "执行工具..." : "整理回复...",
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
            pendingPermission: undefined,
            status: "请求失败",
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
            status: `思考结果不完整，正在重试 (${event.attempt})...`,
          };

        case "retry_attempt":
          return {
            ...state,
            streamingText: "",
            streamingReasoning: "",
            status: event.errorType === "timeout"
              ? `请求超时，正在重试 (${event.attempt}/${event.maxRetries})...`
              : `请求失败，正在重试 (${event.attempt}/${event.maxRetries})...`,
          };

        case "max_turns":
          return {
            ...state,
            streamingText: "",
            streamingReasoning: "",
            status: `已达到最大执行轮数 (${event.maxTurns})，准备续跑...`,
          };

        case "context_compacted":
          return {
            ...state,
            contextTokens: event.afterTokens,
            status: `上下文已压缩 ${event.beforeTokens} → ${event.afterTokens} tokens`,
          };

        case "auto_subagent":
          return {
            ...state,
            status: event.executed
              ? `自动子 agent 已启动 (${event.profile}, score=${event.score})`
              : event.shouldDelegate
                ? `建议委托子 agent (${event.profile}, score=${event.score})`
                : `不自动委托 (score=${event.score})`,
          };

        case "coordinator_mode":
          return {
            ...state,
            status: event.active
              ? `编排模式: ${event.profile} (探索 ${event.directExplorationUsed}/${event.maxDirectExploration})`
              : "编排模式已关闭",
          };

        case "thinking_policy":
          return {
            ...state,
            status: `自适应思考: ${event.level} (${event.reasons.join(", ")})`,
          };

        case "tool_start": {
          if (event.call.name === TODO_WRITE_TOOL_NAME) {
            return { ...state, status: "更新任务列表..." };
          }
          const rawArgs = (event.call.arguments ?? {}) as Record<string, unknown>;
          const args = shortPreview(JSON.stringify(rawArgs), 120);
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
              status: event.result.isError ? "任务列表更新失败" : "任务列表已更新",
            };
          }
          const now = Date.now();
          const result = resultPreview(event.result.content);
          const updatedMessages = state.messages.map((m) => {
            if (m.kind === "tool_call" && m.id === event.call.id) {
              return {
                ...m,
                status: (event.result.isError ? "error" : "done") as ToolState,
                result,
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
            status: event.result.isError ? `${event.call.name} 失败` : `${event.call.name} 完成`,
          };
        }

        case "permission_required":
          return {
            ...state,
            pendingPermission: {
              requestId: event.request.id,
              sessionId: event.request.sessionId,
              tool: event.request.tool,
              risk: event.request.risk,
            },
            status: `等待权限确认: ${event.request.tool} (${event.request.risk}) [A 允许 / D 拒绝 / Enter 拒绝 / Esc 取消]`,
          };

        case "aborted":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            pendingPermission: undefined,
            status: "已中止",
          };

        case "done":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            pendingPermission: undefined,
            status: "就绪",
          };

        default:
          return state;
      }
    }

    case "PLAN_ACT_EVENT": {
      const event = action.event;
      switch (event.type) {
        case "planning_started":
          return { ...state, phase: "planning", status: "规划中..." };
        case "plan_generated":
          return {
            ...state,
            phase: "review",
            currentPlan: event.plan,
            todoItems: executionPlanToTodoItems(event.plan),
            todoRevision: nextTodoRevision(),
            status: "计划已生成，等待审批 (A=批准 / R=拒绝)",
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
            status: "执行中...",
          };
        case "plan_rejected":
          return {
            ...state,
            phase: "cancelled",
            currentPlan: undefined,
            status: "计划已拒绝",
          };
        case "plan_modified":
          return {
            ...state,
            phase: "review",
            currentPlan: event.plan,
            status: "计划已修改，等待审批 (A=批准 / R=拒绝)",
          };
        case "acting_started":
          return { ...state, phase: "acting", status: "执行计划..." };
        case "step_started":
          return {
            ...updateExecutionTodo(state, event.stepId, "in_progress"),
            status: `执行: ${event.step.description.slice(0, 30)}...`,
          };
        case "step_completed":
          return {
            ...updateExecutionTodo(state, event.stepId, "completed"),
            status: "步骤完成",
          };
        case "step_failed":
          return {
            ...updateExecutionTodo(state, event.stepId, "failed", event.error),
            status: `步骤失败: ${event.error.slice(0, 50)}`,
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
            status: "计划执行完成",
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
            status: "执行失败",
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
        status: "计划已批准，开始执行...",
      };
    }
    
    case "REJECT_PLAN": {
      const plan = state.currentPlan;
      if (!plan) return state;
      return {
        ...state,
        currentPlan: { ...plan, status: "rejected" as const },
        phase: "cancelled",
        status: "计划已拒绝",
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
            status: `子代理 (depth ${evt.depth})...`,
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
            inner.type === "tool_start" ? shortPreview(JSON.stringify(inner.call.arguments), 80)
            : inner.type === "tool_end" ? shortPreview(typeof inner.result.content === "string" ? inner.result.content : "[complex]", 80)
            : undefined;
          const isToolEnd = inner.type === "tool_end";
          return {
            ...state,
            messages: state.messages.map((m) => {
              if (m.kind === "subagent_call" && m.id === evt.id) {
                return {
                  ...m,
                  innerEvents: [...m.innerEvents, { type: inner.type, label, detail }],
                  toolCallCount: m.toolCallCount + (isToolEnd ? 1 : 0),
                };
              }
              return m;
            }),
          };
        }
        case "budget_warning": {
          return {
            ...state,
            status: `预算警告 ${evt.percentage}%`,
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
            status: evt.success ? "子代理完成" : "子代理失败",
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
        status: `已添加图片: ${action.image.path.split("/").pop() ?? action.image.path}`,
      };
    }

    case "CLEAR_PENDING_IMAGES":
      return { ...state, pendingImages: [] };

    case "ATTACHMENT_ERROR": {
      const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: action.message }];
      return {
        ...state,
        messages: newMessages,
        status: "图片添加失败",
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
      return { ...state, messages, status: "就绪", scrollOffset: 0 };
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

// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";
import type { SubagentEvent } from "../subagent/types.ts";

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
  durationMs?: number;
};

export type WorkflowStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
};

export type TimelineEvent = {
  id: string;
  timestamp: number;
  icon: "✓" | "▶" | "✗" | "•";
  label: string;
  detail?: string;
};

export type SubagentInnerEvent = {
  type: string;
  label: string;
  detail?: string;
};

export type ChatMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning?: string }
  | { kind: "tool_call"; id: string; name: string; args: string; rawArgs: Record<string, unknown>; status: ToolState; result?: string; durationMs?: number; startedAt: number }
  | { kind: "subagent_call"; id: string; task: string; profile?: string; depth: number; status: ToolState; result?: string; turns?: number; totalTokens?: number; innerEvents: SubagentInnerEvent[]; toolCallCount: number; startedAt: number; durationMs?: number; expanded: boolean }
  | { kind: "error"; text: string };

export type TuiState = {
  messages: ChatMessage[];
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  status: string;
  modelName: string;
  usedTokens: number;
  contextTokens: number;
  /** Global default for how thinking blocks are shown. */
  thinkingMode: ThinkingDisplayMode;
  /**
   * Message indices whose thinking is force-expanded (overrides summary).
   * Stored as a sorted unique array for stable React updates.
   */
  expandedThinking: number[];
  /** Currently focused message index for keyboard navigation; -1 = none. */
  focusedMessageIndex: number;
};

export type TuiAction =
  | { type: "USER_MESSAGE"; text: string }
  | { type: "LOOP_EVENT"; event: LoopEvent }
  | { type: "MODEL_CHANGED"; modelName: string }
  | { type: "RESET" }
  | { type: "TOGGLE_THINKING_MODE" }
  | { type: "TOGGLE_MESSAGE_THINKING"; index?: number }
  | { type: "SET_FOCUSED_MESSAGE"; index: number }
  | { type: "FOCUS_NEXT_REASONING"; direction: 1 | -1 }
  | { type: "SUBAGENT_EVENT"; event: SubagentEvent }
  | { type: "TOGGLE_SUBAGENT_EXPAND"; id: string };

function shortPreview(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function createInitialState(modelName: string): TuiState {
  return {
    messages: [],
    streamingText: "",
    streamingReasoning: "",
    busy: false,
    status: "就绪",
    modelName,
    usedTokens: 0,
    contextTokens: 0,
    thinkingMode: "summary",
    expandedThinking: [],
    focusedMessageIndex: -1,
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

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "USER_MESSAGE":
      return {
        ...state,
        messages: [...state.messages, { kind: "user", text: action.text }],
        busy: true,
        status: "思考中...",
        streamingText: "",
        streamingReasoning: "",
      };

    case "RESET":
      return {
        ...createInitialState(state.modelName),
        thinkingMode: state.thinkingMode,
      };

    case "MODEL_CHANGED":
      return { ...state, modelName: action.modelName, status: "就绪", usedTokens: 0, contextTokens: 0 };

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
          return {
            ...state,
            messages: newMessages,
            streamingText: "",
            streamingReasoning: "",
            status: hasTools ? "执行工具..." : "就绪",
            usedTokens,
            contextTokens,
          };
        }

        case "error":
          return {
            ...state,
            messages: [...state.messages, { kind: "error", text: event.message }],
            streamingText: "",
            streamingReasoning: "",
            status: "请求失败",
          };

        case "max_turns":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            status: `已达到最大执行轮数 (${event.maxTurns})，本轮已停止`,
          };

        case "context_compacted":
          return {
            ...state,
            contextTokens: event.afterTokens,
            status: `上下文已压缩 ${event.beforeTokens} → ${event.afterTokens} tokens`,
          };

        case "tool_start": {
          const rawArgs = (event.call.arguments ?? {}) as Record<string, unknown>;
          const args = shortPreview(JSON.stringify(rawArgs), 120);
          const card: ChatMessage = {
            kind: "tool_call",
            id: event.call.id,
            name: event.call.name,
            args,
            rawArgs,
            status: "running",
            startedAt: Date.now(),
          };
          return {
            ...state,
            messages: [...state.messages, card],
            status: `${event.call.name}...`,
          };
        }

        case "tool_end": {
          const result =
            typeof event.result.content === "string"
              ? shortPreview(event.result.content, 200)
              : "[binary]";
          const now = Date.now();
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
          return {
            ...state,
            messages: updatedMessages,
            status: event.result.isError ? `${event.call.name} 失败` : `${event.call.name} 完成`,
          };
        }

        case "aborted":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            status: "已中止",
          };

        case "done":
          return {
            ...state,
            busy: false,
            streamingText: "",
            streamingReasoning: "",
            status: "就绪",
          };

        default:
          return state;
      }
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
          return {
            ...state,
            messages: [...state.messages, card],
            status: `子代理 (depth ${evt.depth})...`,
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
  }
}

// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolState = "running" | "done" | "error";

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

export type ChatMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning?: string }
  | { kind: "tool_call"; id: string; name: string; args: string; rawArgs: Record<string, unknown>; status: ToolState; result?: string; durationMs?: number; startedAt: number }
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
};

export type TuiAction =
  | { type: "USER_MESSAGE"; text: string }
  | { type: "LOOP_EVENT"; event: LoopEvent }
  | { type: "MODEL_CHANGED"; modelName: string }
  | { type: "RESET" };

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
  };
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
      return createInitialState(state.modelName);

    case "MODEL_CHANGED":
      return { ...state, modelName: action.modelName, status: "就绪", usedTokens: 0 };

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
  }
}

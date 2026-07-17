// Simplified Claude Code-style TUI state

import type { LoopEvent } from "../loop.ts";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolState = "running" | "done" | "error";

export type ChatMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: string; rawArgs: Record<string, unknown>; status: ToolState; result?: string; durationMs?: number; startedAt: number }
  | { kind: "error"; text: string };

export type TuiState = {
  messages: ChatMessage[];
  streamingText: string;
  busy: boolean;
  status: string;
  modelName: string;
  usedTokens: number;
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
    busy: false,
    status: "就绪",
    modelName,
    usedTokens: 0,
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
            streamingText: state.streamingText + event.text,
            status: "输出中...",
          };

        case "assistant": {
          // Prefer streamed text; the final assistant event often has content=""
          const contentText = typeof event.message.content === "string"
            ? event.message.content
            : "";
          const text = contentText || state.streamingText;
          const hasTools = (event.message.toolCalls?.length ?? 0) > 0;
          // Only skip if we genuinely have nothing to show
          if (!text && !hasTools) return { ...state, streamingText: "" };
          const newMessages: ChatMessage[] = text
            ? [...state.messages, { kind: "assistant", text }]
            : state.messages;
          const usedTokens = event.usage?.totalTokens ?? state.usedTokens;
          return {
            ...state,
            messages: newMessages,
            streamingText: "",
            status: hasTools ? "执行工具..." : "就绪",
            usedTokens,
          };
        }

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
            status: "已中止",
          };

        case "done":
          return {
            ...state,
            busy: false,
            streamingText: "",
            status: "就绪",
          };

        default:
          return state;
      }
    }
  }
}

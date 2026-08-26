import type { ChatMessage, ToolState } from "./state.ts";

export type MessageVisualKind = "user" | "assistant" | "tool" | "notice" | "subagent" | "error";

export type MessageRenderModel = {
  kind: MessageVisualKind;
  marker: string;
  label?: string;
  state?: ToolState;
  text: string;
};

/** Convert state messages to presentation semantics without mutating state. */
export function toMessageRenderModel(message: ChatMessage): MessageRenderModel {
  switch (message.kind) {
    case "user":
      return { kind: "user", marker: "❯", text: message.displayText ?? message.text };
    case "assistant":
      return { kind: "assistant", marker: "⏺", text: message.text };
    case "tool_call":
      return { kind: "tool", marker: "⎿", label: message.name, state: message.status, text: message.result ?? "" };
    case "notice":
      return { kind: "notice", marker: "─", label: message.title, text: message.text };
    case "subagent_call":
      return { kind: "subagent", marker: "⎿", label: message.profile ?? "subagent", state: message.status, text: message.result ?? message.task };
    case "error":
      return { kind: "error", marker: "✗", text: message.text };
  }
}


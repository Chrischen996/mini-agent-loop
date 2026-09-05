import type { ChatMessage } from "./state.ts";

export type CopyTarget =
  | "auto"
  | "last"
  | "assistant"
  | "input"
  | "tool"
  | "thinking"
  | "user";

export type CopySelection = {
  label: string;
  text: string;
};

export function parseCopyCommand(input: string): CopyTarget | undefined {
  const match = input.trim().match(/^\/copy(?:\s+(last|assistant|input|tool|thinking|user|all))?$/i);
  if (!match) return undefined;
  const verb = match[1]?.toLowerCase();
  if (!verb || verb === "last" || verb === "all") return verb === "all" ? "assistant" : "auto";
  return verb as CopyTarget;
}

export function extractMessageCopyText(
  message: ChatMessage,
  prefer: "default" | "thinking" = "default",
): string {
  switch (message.kind) {
    case "user":
      return message.text;
    case "assistant":
      if (prefer === "thinking") return message.reasoning?.trim() ?? "";
      return message.text;
    case "notice":
      return [message.title, message.text].filter(Boolean).join("\n\n");
    case "tool_call":
    case "subagent_call":
      return message.result?.trim() ?? "";
    case "error":
      return message.text;
  }
}

function findLast(
  messages: readonly ChatMessage[],
  match: (message: ChatMessage) => boolean,
): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && match(message)) return message;
  }
  return undefined;
}

export function resolveCopyTarget(options: {
  messages: readonly ChatMessage[];
  focusedIndex?: number;
  streamingText?: string;
  streamingReasoning?: string;
  input?: string;
  target?: CopyTarget;
}): CopySelection | undefined {
  const {
    messages,
    focusedIndex = -1,
    streamingText = "",
    streamingReasoning = "",
    input = "",
    target = "auto",
  } = options;

  if (target === "input") {
    const text = input.trim();
    return text ? { label: "current input", text } : undefined;
  }

  if (target === "thinking") {
    const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
    const focusedThinking = focused ? extractMessageCopyText(focused, "thinking") : "";
    if (focusedThinking) return { label: "reasoning", text: focusedThinking };
    if (streamingReasoning.trim()) return { label: "reasoning", text: streamingReasoning };
    const lastAssistant = findLast(messages, (message) => message.kind === "assistant");
    const thinking = lastAssistant ? extractMessageCopyText(lastAssistant, "thinking") : "";
    return thinking ? { label: "reasoning", text: thinking } : undefined;
  }

  if (target === "tool") {
    const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
    if (focused && (focused.kind === "tool_call" || focused.kind === "subagent_call")) {
      const text = extractMessageCopyText(focused);
      if (text) {
        return {
          label: focused.kind === "subagent_call" ? "subagent output" : `${focused.name} output`,
          text,
        };
      }
    }
    const lastTool = findLast(messages, (message) => message.kind === "tool_call" || message.kind === "subagent_call");
    if (!lastTool) return undefined;
    const text = extractMessageCopyText(lastTool);
    if (!text) return undefined;
    if (lastTool.kind === "subagent_call") return { label: "subagent output", text };
    if (lastTool.kind === "tool_call") return { label: `${lastTool.name} output`, text };
    return { label: "tool output", text };
  }

  if (target === "user") {
    const lastUser = findLast(messages, (message) => message.kind === "user" && Boolean(message.text.trim()));
    return lastUser && lastUser.kind === "user" ? { label: "user prompt", text: lastUser.text } : undefined;
  }

  if (target === "assistant" || target === "last") {
    if (streamingText.trim()) return { label: "current response", text: streamingText };
    const lastAssistant = findLast(messages, (message) => message.kind === "assistant" && Boolean(message.text.trim()));
    return lastAssistant && lastAssistant.kind === "assistant" ? { label: "assistant reply", text: lastAssistant.text } : undefined;
  }

  const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
  if (focused) {
    const text = extractMessageCopyText(focused);
    if (text) {
      const label = focused.kind === "assistant" ? "assistant reply"
        : focused.kind === "user" ? "user prompt"
          : focused.kind === "tool_call" ? `${focused.name} output`
            : focused.kind === "subagent_call" ? "subagent output"
              : focused.kind === "notice" ? "notice"
                : "error";
      return { label, text };
    }
  }

  if (streamingText.trim()) return { label: "current response", text: streamingText };

  const lastAssistant = findLast(messages, (message) => message.kind === "assistant" && Boolean(message.text.trim()));
  if (lastAssistant && lastAssistant.kind === "assistant") return { label: "assistant reply", text: lastAssistant.text };

  const lastTool = findLast(messages, (message) => Boolean(extractMessageCopyText(message)));
  if (lastTool) {
    let label = "transcript";
    if (lastTool.kind === "tool_call") {
      label = `${lastTool.name} output`;
    } else if (lastTool.kind === "user") {
      label = "user prompt";
    } else if (lastTool.kind === "assistant") {
      label = "assistant reply";
    } else if (lastTool.kind === "subagent_call") {
      label = "subagent output";
    }
    return {
      label,
      text: extractMessageCopyText(lastTool),
    };
  }

  const draft = input.trim();
  return draft ? { label: "current input", text: draft } : undefined;
}
export function formatCopyResultNotice(selection: CopySelection, method: string): string {
  const lineCount = selection.text.split(/\r?\n/).length;
  const charCount = [...selection.text].length;
  return `${selection.label} · ${lineCount} ${lineCount === 1 ? "line" : "lines"} / ${charCount} ${charCount === 1 ? "char" : "chars"} · ${method}`;
}

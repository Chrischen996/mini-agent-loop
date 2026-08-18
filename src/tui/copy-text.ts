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
    return text ? { label: "当前输入", text } : undefined;
  }

  if (target === "thinking") {
    const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
    const focusedThinking = focused ? extractMessageCopyText(focused, "thinking") : "";
    if (focusedThinking) return { label: "思考过程", text: focusedThinking };
    if (streamingReasoning.trim()) return { label: "思考过程", text: streamingReasoning };
    const lastAssistant = findLast(messages, (message) => message.kind === "assistant");
    const thinking = lastAssistant ? extractMessageCopyText(lastAssistant, "thinking") : "";
    return thinking ? { label: "思考过程", text: thinking } : undefined;
  }

  if (target === "tool") {
    const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
    if (focused && (focused.kind === "tool_call" || focused.kind === "subagent_call")) {
      const text = extractMessageCopyText(focused);
      if (text) return { label: focused.kind === "subagent_call" ? "子任务输出" : `${focused.name} 输出`, text };
    }
    const lastTool = findLast(messages, (message) => (
      (message.kind === "tool_call" || message.kind === "subagent_call")
      && Boolean(extractMessageCopyText(message))
    ));
    if (!lastTool) return undefined;
    return {
      label: lastTool.kind === "subagent_call" ? "子任务输出" : `${lastTool.name} 输出`,
      text: extractMessageCopyText(lastTool),
    };
  }

  if (target === "user") {
    const lastUser = findLast(messages, (message) => message.kind === "user" && Boolean(message.text.trim()));
    return lastUser ? { label: "用户原文", text: lastUser.text } : undefined;
  }

  if (target === "assistant" || target === "last") {
    if (streamingText.trim()) return { label: "当前回复", text: streamingText };
    const lastAssistant = findLast(messages, (message) => message.kind === "assistant" && Boolean(message.text.trim()));
    return lastAssistant ? { label: "助手回复", text: lastAssistant.text } : undefined;
  }

  const focused = focusedIndex >= 0 ? messages[focusedIndex] : undefined;
  if (focused) {
    const text = extractMessageCopyText(focused);
    if (text) {
      const label = focused.kind === "assistant" ? "助手回复"
        : focused.kind === "user" ? "用户原文"
          : focused.kind === "tool_call" ? `${focused.name} 输出`
            : focused.kind === "subagent_call" ? "子任务输出"
              : focused.kind === "notice" ? "通知"
                : "错误信息";
      return { label, text };
    }
  }

  if (streamingText.trim()) return { label: "当前回复", text: streamingText };

  const lastAssistant = findLast(messages, (message) => message.kind === "assistant" && Boolean(message.text.trim()));
  if (lastAssistant) return { label: "助手回复", text: lastAssistant.text };

  const lastTool = findLast(messages, (message) => Boolean(extractMessageCopyText(message)));
  if (lastTool) {
    return {
      label: lastTool.kind === "tool_call" ? `${lastTool.name} 输出` : lastTool.kind === "user" ? "用户原文" : "可复制内容",
      text: extractMessageCopyText(lastTool),
    };
  }

  const draft = input.trim();
  return draft ? { label: "当前输入", text: draft } : undefined;
}

export function formatCopyResultNotice(selection: CopySelection, method: string): string {
  const lineCount = selection.text.split(/\r?\n/).length;
  const charCount = [...selection.text].length;
  return `${selection.label} · ${lineCount} 行 / ${charCount} 字 · ${method}`;
}

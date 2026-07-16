import { contentAsString } from "./content.ts";
import type { AgentMessage } from "./types.ts";

export type ContextManagerOptions = {
  maxChars?: number;
  keepRecentMessages?: number;
};

const DEFAULT_MAX_CHARS = 160_000;
const DEFAULT_KEEP_RECENT = 12;

function messageLabel(message: AgentMessage): string {
  if (message.role === "user") return "User";
  if (message.role === "assistant") return "Assistant";
  if (message.role === "tool") return `Tool(${message.name})`;
  return "System";
}

function compactMessage(message: AgentMessage): string {
  const text = contentAsString(message.content).replace(/\s+/g, " ").trim().slice(0, 800);
  if (message.role === "assistant" && message.toolCalls?.length) {
    return `${messageLabel(message)} called: ${message.toolCalls.map((call) => call.name).join(", ")}${text ? `; ${text}` : ""}`;
  }
  return `${messageLabel(message)}: ${text}`;
}

function messageChars(message: AgentMessage): number {
  return compactMessage(message).length + 40;
}

export function compactHistory(
  history: AgentMessage[],
  options: ContextManagerOptions = {},
): AgentMessage[] {
  const system = history.find((message) => message.role === "system");
  const nonSystem = history.filter((message) => message.role !== "system");
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const keepRecent = Math.max(2, options.keepRecentMessages ?? DEFAULT_KEEP_RECENT);
  const totalChars = history.reduce((total, message) => total + messageChars(message), 0);
  if (totalChars <= maxChars || nonSystem.length <= keepRecent) return history;

  let splitAt = Math.max(0, nonSystem.length - keepRecent);
  while (splitAt > 0 && nonSystem[splitAt]?.role === "tool") splitAt -= 1;
  const oldMessages = nonSystem.slice(0, splitAt);
  const recentMessages = nonSystem.slice(splitAt);
  const summaryMessage: AgentMessage = {
    role: "system",
    content: [
      "[Conversation summary - older messages were compacted to fit the context window]",
      oldMessages.map(compactMessage).join("\n"),
      "[End conversation summary]",
    ].join("\n"),
  };
  return [...(system ? [system] : []), summaryMessage, ...recentMessages];
}

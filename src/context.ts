import { contentAsString, normalizeToParts } from "./content.ts";
import type { Tool } from "./tools/types.ts";
import type { AgentMessage } from "./types.ts";

export type ContextManagerOptions = {
  /** Approximate output space to keep available in the model window. */
  reserveTokens?: number;
  /** Number of recent messages to retain when compacting. */
  keepRecentMessages?: number;
  /** Maximum number of automatic overflow compaction retries. */
  maxCompactionRetries?: number;
  /** Legacy character threshold, retained for callers and tests. */
  maxChars?: number;
  /** Explicit token threshold used by the new budget-aware path. */
  maxTokens?: number;
  /** Internal escape hatch for a provider-reported overflow. */
  force?: boolean;
};

const DEFAULT_MAX_CHARS = 160_000;
const DEFAULT_KEEP_RECENT = 12;

/** Conservative, dependency-free estimate for mixed English/CJK content. */
export function estimateTextTokens(text: string): number {
  let estimate = 0;
  for (const character of text) {
    estimate += character.charCodeAt(0) > 0x7f ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(estimate));
}

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

function messageTokens(message: AgentMessage): number {
  let value = 4 + estimateTextTokens(contentAsString(message.content));
  if (message.role === "assistant" && message.toolCalls) {
    value += estimateTextTokens(JSON.stringify(message.toolCalls));
  }
  if (message.role === "tool") value += estimateTextTokens(message.toolCallId);
  for (const part of normalizeToParts(message.content)) {
    if (part.type !== "text") value += 256;
  }
  return value;
}

export function estimateContextTokens(history: AgentMessage[], tools: Tool[] = []): number {
  const messageTotal = history.reduce((total, message) => total + messageTokens(message), 0);
  const toolTotal = tools.reduce(
    (total, tool) => total + 12 + estimateTextTokens(`${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`),
    0,
  );
  return messageTotal + toolTotal;
}

function recentStartIndex(messages: AgentMessage[], keepRecent: number): number {
  let splitAt = Math.max(0, messages.length - keepRecent);
  while (splitAt > 0) {
    const current = messages[splitAt];
    const previous = messages[splitAt - 1];
    if (current?.role === "tool" || (previous?.role === "assistant" && previous.toolCalls?.length)) {
      splitAt -= 1;
      continue;
    }
    break;
  }
  return splitAt;
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
  const totalTokens = estimateContextTokens(history);
  const overBudget = options.maxTokens !== undefined && totalTokens > options.maxTokens;
  if (!options.force && !overBudget && totalChars <= maxChars) return history;
  if (nonSystem.length <= keepRecent) return history;

  const splitAt = recentStartIndex(nonSystem, keepRecent);
  if (splitAt <= 0) return history;
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

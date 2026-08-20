import type { AgentMessage } from "../types.ts";

/**
 * Find the last assistant message in history (most recent by traversal order).
 */
export function lastAssistantMessage(history: AgentMessage[]): AgentMessage | undefined {
  return [...history].reverse().find((m) => m.role === "assistant");
}

/**
 * Safely extract string content from an assistant message.
 */
export function assistantContentAsString(msg: AgentMessage | undefined): string {
  if (!msg || msg.role !== "assistant") return "";
  return typeof msg.content === "string" ? msg.content : String(msg.content);
}

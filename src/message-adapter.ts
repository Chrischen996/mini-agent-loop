/**
 * Message adapter for model switching.
 *
 * When switching models mid-conversation, the history may contain messages
 * that are incompatible with the new model's capabilities. This module
 * provides functions to adapt the message history so it can be safely
 * consumed by a different model.
 */

import { contentAsString } from "./content.ts";
import type { ModelCapabilities } from "./models.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ContentPart,
  MessageContent,
  ToolResultMessage,
} from "./types.ts";

export type AdaptHistoryOptions = {
  /** Capabilities of the new target model. */
  targetCapabilities: ModelCapabilities;
  /** Capabilities of the previous model (for detecting downgrades). */
  sourceCapabilities?: ModelCapabilities;
};

/**
 * Adapt conversation history for a new model, handling capability mismatches.
 *
 * This function is idempotent — calling it on already-adapted history is safe.
 */
export function adaptHistoryForModel(
  messages: AgentMessage[],
  options: AdaptHistoryOptions,
): AgentMessage[] {
  const { targetCapabilities } = options;
  let adapted = messages;

  // 1. Handle tool call compatibility
  if (!targetCapabilities.tools) {
    adapted = collapseToolCalls(adapted);
  }

  // 2. Handle image compatibility
  if (!targetCapabilities.input.includes("image")) {
    adapted = stripImages(adapted);
  }

  return adapted;
}

/**
 * Collapse tool_call + tool_result pairs into text summaries.
 *
 * When switching to a model that doesn't support tools, we fold each
 * assistant tool_call and its corresponding tool_result into a descriptive
 * text block so the model can still understand what happened.
 */
function collapseToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      // Convert assistant message with tool calls to pure text
      const toolDescriptions = message.toolCalls.map((call) => {
        pendingToolCallIds.add(call.id);
        const argsStr = Object.entries(call.arguments)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ");
        return `[Tool used: ${call.name}(${argsStr})]`;
      });

      const textContent = [
        message.content,
        ...toolDescriptions,
      ].filter(Boolean).join("\n\n");

      const collapsed: AssistantMessage = {
        role: "assistant",
        content: textContent,
        // Remove toolCalls — the new model doesn't support them
      };
      result.push(collapsed);
      continue;
    }

    if (message.role === "tool") {
      // Convert tool result to a user message summarizing the result
      if (pendingToolCallIds.has(message.toolCallId)) {
        pendingToolCallIds.delete(message.toolCallId);
        const content = contentAsString(message.content);
        const truncated = content.length > 2000
          ? `${content.slice(0, 2000)}… (truncated)`
          : content;
        const prefix = message.isError ? "[Tool error" : "[Tool result";
        result.push({
          role: "user",
          content: `${prefix} for ${message.name}]: ${truncated}`,
        });
        continue;
      }
      // If this tool result doesn't match any pending call, still convert it
      const content = contentAsString(message.content);
      result.push({
        role: "user",
        content: `[Tool result for ${message.name}]: ${content.slice(0, 2000)}`,
      });
      continue;
    }

    result.push(message);
  }

  return result;
}

/**
 * Strip image content from messages when the target model doesn't support vision.
 * Replaces image parts with placeholder text descriptions.
 */
function stripImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      const parts = message.content as ContentPart[];
      const hasImage = parts.some((part) => part.type === "image");
      if (!hasImage) return message;

      const filtered = parts.map((part) => {
        if (part.type === "image") {
          return {
            type: "text" as const,
            text: `[Image: ${part.source ?? "uploaded image"} — omitted, model lacks vision support]`,
          };
        }
        return part;
      });

      return { ...message, content: filtered };
    }

    if (message.role === "tool" && Array.isArray(message.content)) {
      const parts = message.content as ContentPart[];
      const hasImage = parts.some((part) => part.type === "image");
      if (!hasImage) return message;

      const filtered = parts.map((part) => {
        if (part.type === "image") {
          return {
            type: "text" as const,
            text: "[Image content omitted — model lacks vision support]",
          };
        }
        return part;
      });

      return { ...message, content: filtered as MessageContent };
    }

    return message;
  });
}

/**
 * Merge consecutive same-role messages that may result from tool call collapsing.
 * Some models reject consecutive user messages; this merges them.
 */
export function mergeConsecutiveSameRole(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= 1) return messages;

  const result: AgentMessage[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]!;
    const previous = result[result.length - 1]!;

    if (current.role === "user" && previous.role === "user") {
      // Merge consecutive user messages
      const prevText = contentAsString(previous.content);
      const currText = contentAsString(current.content);
      result[result.length - 1] = {
        role: "user",
        content: `${prevText}\n\n${currText}`,
      };
      continue;
    }

    result.push(current);
  }

  return result;
}

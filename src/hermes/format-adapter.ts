/**
 * Hermes format adapter.
 *
 * Routes between OpenAI and Hermes tool-calling formats based on the model's
 * `toolCallFormat` field. This adapter is the integration point between the
 * Hermes parser and the existing LLM chat pipeline.
 *
 * For OpenAI-format models, all behavior is unchanged — tools are passed via
 * the API `tools` parameter and tool_calls come back in the response JSON.
 *
 * For Hermes-format models:
 * 1. Tools are injected into the system prompt as XML (no `tools` API param)
 * 2. The model's text response is parsed for `<tool_call>` and `<think>` blocks
 * 3. Parsed results are mapped to the standard `AssistantMessage` + `ToolCall[]`
 */

import { randomUUID } from "node:crypto";
import type { Tool } from "../tools/types.ts";
import type { AssistantMessage, ToolCall } from "../types.ts";
import { parseHermesResponse } from "./parser.ts";
import { buildHermesSystemPrompt } from "./system-prompt.ts";
import type { ToolCallFormat } from "./types.ts";

/**
 * Determine whether tools should be passed via the API parameter
 * or embedded in the system prompt.
 *
 * - OpenAI format: tools go in the API request body
 * - Hermes format: tools go in the system prompt, API gets no tools
 */
export function shouldEmbedToolsInPrompt(format: ToolCallFormat): boolean {
  return format === "hermes";
}

/**
 * Prepare the system prompt for the given format.
 *
 * For Hermes format, this embeds tool definitions in the system prompt.
 * For OpenAI format, returns the base prompt unchanged.
 */
export function prepareSystemPrompt(
  basePrompt: string,
  tools: Tool[],
  format: ToolCallFormat,
): string {
  if (format === "hermes") {
    return buildHermesSystemPrompt({
      basePrompt,
      tools,
    });
  }
  return basePrompt;
}

/**
 * Convert a Hermes-format assistant text response into the standard
 * `AssistantMessage` type used by the agent loop.
 *
 * This extracts `<tool_call>` blocks from the text and maps them to
 * `ToolCall[]`, and extracts `<think>` blocks as reasoning content.
 *
 * For OpenAI-format responses (which already have structured tool_calls),
 * this function should NOT be called — use the response as-is.
 */
export function convertHermesResponse(rawText: string): {
  message: AssistantMessage;
  reasoning: string;
  errors: string[];
} {
  const parsed = parseHermesResponse(rawText);

  const toolCalls: ToolCall[] = parsed.toolCalls.map((tc) => ({
    id: `hermes_${randomUUID().slice(0, 8)}`,
    name: tc.name,
    arguments: tc.arguments,
  }));

  return {
    message: {
      role: "assistant",
      content: parsed.text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    reasoning: parsed.thinking,
    errors: parsed.errors,
  };
}

/**
 * Post-process an assistant response based on the model's tool-call format.
 *
 * For OpenAI format: returns the message unchanged.
 * For Hermes format: parses the text content for XML tool calls and thinking.
 */
export function postProcessAssistantResponse(
  message: AssistantMessage,
  format: ToolCallFormat,
): {
  message: AssistantMessage;
  reasoning: string;
  errors: string[];
} {
  if (format === "openai") {
    return { message, reasoning: "", errors: [] };
  }

  // Hermes format: the model returns tool calls in the text body
  // If the model already returned structured tool_calls (shouldn't happen
  // for a true Hermes model, but defensive), prefer them.
  if (message.toolCalls && message.toolCalls.length > 0) {
    return { message, reasoning: "", errors: [] };
  }

  return convertHermesResponse(message.content);
}

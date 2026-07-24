n/**
 * Hermes Agent format types.
 *
 * Nous Research's Hermes models use XML-based structured output for tool
 * calling and reasoning, as opposed to OpenAI's JSON `tool_calls` array.
 *
 * This module defines the types shared across the Hermes parsing and
 * formatting pipeline.
 */

/**
 * The wire format a model uses for tool calling.
 *
 * - `"openai"` — standard OpenAI Chat Completions `tool_calls` JSON array
 * - `"hermes"` — Hermes XML `<tool_call>` blocks in assistant text
 */
export type ToolCallFormat = "openai" | "hermes";

/**
 * A parsed `<tool_call>` block from Hermes model output.
 *
 * Hermes models emit tool calls inside the assistant text body as:
 * ```
 * <tool_call>
 * {"name": "read", "arguments": {"path": "package.json"}}
 * </tool_call>
 * ```
 */
export type HermesToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Result of parsing a Hermes assistant response.
 *
 * The parser extracts three categories of content from the raw text:
 * - `thinking` — content inside `<think>` / `<thinking>` blocks
 * - `toolCalls` — content inside `<tool_call>` blocks (parsed as JSON)
 * - `text` — everything outside special blocks (the "visible" response)
 */
export type HermesParseResult = {
  /** Plain text content (outside all special blocks). */
  text: string;
  /** Extracted reasoning / thinking content. */
  thinking: string;
  /** Parsed tool calls from `<tool_call>` blocks. */
  toolCalls: HermesToolCall[];
  /** Parse errors encountered (malformed JSON inside tags, etc.). */
  errors: string[];
};

/**
 * Incremental state for streaming Hermes XML parsing.
 *
 * Used by the streaming parser to handle partial tags that span
 * across multiple SSE chunks.
 */
export type HermesStreamState = {
  /** Accumulated raw text buffer (unparsed tail). */
  buffer: string;
  /** Whether we are currently inside a `<tool_call>` block. */
  inToolCall: boolean;
  /** Whether we are currently inside a `<think>` / `<thinking>` block. */
  inThinking: boolean;
  /** The specific thinking tag name found (for matching close tag). */
  thinkingTagName: string;
  /** Accumulated content inside the current `<tool_call>` block. */
  toolCallContent: string;
  /** Accumulated content inside the current thinking block. */
  thinkingContent: string;
  /** Completed tool calls so far. */
  toolCalls: HermesToolCall[];
  /** Completed thinking text so far. */
  thinking: string;
  /** Completed plain text so far. */
  text: string;
  /** Parse errors. */
  errors: string[];
};

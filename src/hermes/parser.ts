/**
 * Hermes XML structured output parser.
 *
 * Parses assistant text containing Hermes-format blocks:
 * - `<tool_call>{"name":"...", "arguments":{...}}</tool_call>`
 * - `<think>...</think>` or `<thinking>...</thinking>`
 *
 * Supports both complete (non-streaming) and incremental (streaming) parsing.
 */

import { parseToolArgumentsJson } from "../validate.ts";
import type {
  HermesParseResult,
  HermesStreamState,
  HermesToolCall,
} from "./types.ts";

// ─── Tag patterns ─────────────────────────────────────────────────────────────

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const THINKING_OPEN_TAGS = ["<think>", "<thinking>"];
const THINKING_CLOSE_TAGS: Record<string, string> = {
  "<think>": "</think>",
  "<thinking>": "</thinking>",
};

// ─── Complete (non-streaming) parser ──────────────────────────────────────────

/**
 * Parse a complete Hermes-format assistant response.
 *
 * Extracts tool calls, thinking blocks, and plain text from the raw output.
 * This is the primary entry point for non-streaming responses.
 */
export function parseHermesResponse(raw: string): HermesParseResult {
  const result: HermesParseResult = {
    text: "",
    thinking: "",
    toolCalls: [],
    errors: [],
  };

  let pos = 0;

  while (pos < raw.length) {
    // Check for tool_call open tag
    if (raw.startsWith(TOOL_CALL_OPEN, pos)) {
      pos += TOOL_CALL_OPEN.length;
      const closeIdx = raw.indexOf(TOOL_CALL_CLOSE, pos);
      if (closeIdx === -1) {
        // Unclosed tool_call — treat remaining as malformed
        result.errors.push(`Unclosed <tool_call> tag at position ${pos - TOOL_CALL_OPEN.length}`);
        result.text += raw.slice(pos);
        break;
      }
      const content = raw.slice(pos, closeIdx).trim();
      pos = closeIdx + TOOL_CALL_CLOSE.length;

      const parsed = parseToolCallJson(content);
      if (parsed.error) {
        result.errors.push(parsed.error);
      } else if (parsed.toolCall) {
        result.toolCalls.push(parsed.toolCall);
      }
      continue;
    }

    // Check for thinking open tags
    let matchedThinkOpen: string | undefined;
    for (const tag of THINKING_OPEN_TAGS) {
      if (raw.startsWith(tag, pos)) {
        matchedThinkOpen = tag;
        break;
      }
    }

    if (matchedThinkOpen) {
      const closeTag = THINKING_CLOSE_TAGS[matchedThinkOpen]!;
      pos += matchedThinkOpen.length;
      const closeIdx = raw.indexOf(closeTag, pos);
      if (closeIdx === -1) {
        // Unclosed thinking — treat remaining as thinking content
        result.thinking += raw.slice(pos);
        break;
      }
      result.thinking += raw.slice(pos, closeIdx);
      pos = closeIdx + closeTag.length;
      continue;
    }

    // Find next special tag
    let nextTagPos = raw.length;
    for (const tag of [TOOL_CALL_OPEN, ...THINKING_OPEN_TAGS]) {
      const idx = raw.indexOf(tag, pos);
      if (idx !== -1 && idx < nextTagPos) {
        nextTagPos = idx;
      }
    }

    // Everything before the next tag is plain text
    result.text += raw.slice(pos, nextTagPos);
    pos = nextTagPos;
  }

  result.text = result.text.trim();
  result.thinking = result.thinking.trim();

  return result;
}

// ─── Streaming (incremental) parser ───────────────────────────────────────────

/**
 * Create a fresh streaming parser state.
 */
export function createHermesStreamState(): HermesStreamState {
  return {
    buffer: "",
    inToolCall: false,
    inThinking: false,
    thinkingTagName: "",
    toolCallContent: "",
    thinkingContent: "",
    toolCalls: [],
    thinking: "",
    text: "",
    errors: [],
  };
}

/**
 * Streaming parse result for a single chunk.
 */
export type HermesStreamChunkResult = {
  /** New plain text emitted by this chunk. */
  textDelta: string;
  /** New thinking text emitted by this chunk. */
  thinkingDelta: string;
  /** Tool calls completed by this chunk. */
  completedToolCalls: HermesToolCall[];
};

/**
 * Feed a new text chunk to the streaming parser.
 *
 * Returns the deltas produced by this chunk. The state is mutated in place.
 */
export function feedHermesChunk(
  state: HermesStreamState,
  chunk: string,
): HermesStreamChunkResult {
  const result: HermesStreamChunkResult = {
    textDelta: "",
    thinkingDelta: "",
    completedToolCalls: [],
  };

  state.buffer += chunk;

  while (state.buffer.length > 0) {
    if (state.inToolCall) {
      const closeIdx = state.buffer.indexOf(TOOL_CALL_CLOSE);
      if (closeIdx === -1) {
        // Check if we might have a partial close tag at the end
        if (hasPartialTag(state.buffer, TOOL_CALL_CLOSE)) {
          break; // Wait for more data
        }
        // No close tag — accumulate content
        state.toolCallContent += state.buffer;
        state.buffer = "";
        break;
      }
      // Found close tag
      state.toolCallContent += state.buffer.slice(0, closeIdx);
      state.buffer = state.buffer.slice(closeIdx + TOOL_CALL_CLOSE.length);
      state.inToolCall = false;

      const parsed = parseToolCallJson(state.toolCallContent.trim());
      if (parsed.error) {
        state.errors.push(parsed.error);
      } else if (parsed.toolCall) {
        state.toolCalls.push(parsed.toolCall);
        result.completedToolCalls.push(parsed.toolCall);
      }
      state.toolCallContent = "";
      continue;
    }

    if (state.inThinking) {
      const closeTag = THINKING_CLOSE_TAGS[state.thinkingTagName]!;
      const closeIdx = state.buffer.indexOf(closeTag);
      if (closeIdx === -1) {
        if (hasPartialTag(state.buffer, closeTag)) {
          break;
        }
        const delta = state.buffer;
        state.thinkingContent += delta;
        state.thinking += delta;
        result.thinkingDelta += delta;
        state.buffer = "";
        break;
      }
      const delta = state.buffer.slice(0, closeIdx);
      state.thinkingContent += delta;
      state.thinking += delta;
      result.thinkingDelta += delta;
      state.buffer = state.buffer.slice(closeIdx + closeTag.length);
      state.inThinking = false;
      state.thinkingContent = "";
      continue;
    }

    // Not inside any block — look for open tags
    // Check for tool_call open
    if (state.buffer.startsWith(TOOL_CALL_OPEN)) {
      state.buffer = state.buffer.slice(TOOL_CALL_OPEN.length);
      state.inToolCall = true;
      state.toolCallContent = "";
      continue;
    }

    // Check for thinking open tags
    let matchedThinkOpen: string | undefined;
    for (const tag of THINKING_OPEN_TAGS) {
      if (state.buffer.startsWith(tag)) {
        matchedThinkOpen = tag;
        break;
      }
    }

    if (matchedThinkOpen) {
      state.buffer = state.buffer.slice(matchedThinkOpen.length);
      state.inThinking = true;
      state.thinkingTagName = matchedThinkOpen;
      state.thinkingContent = "";
      continue;
    }

    // Check if buffer might start with a partial tag
    if (state.buffer.startsWith("<")) {
      const allTags = [TOOL_CALL_OPEN, ...THINKING_OPEN_TAGS];
      let mightBePartial = false;
      for (const tag of allTags) {
        if (tag.startsWith(state.buffer)) {
          mightBePartial = true;
          break;
        }
      }
      if (mightBePartial) {
        break; // Wait for more data to confirm or reject
      }
    }

    // Find next potential tag start
    const nextLt = state.buffer.indexOf("<", state.buffer[0] === "<" ? 1 : 0);
    if (nextLt === -1) {
      // Check if buffer ends with partial '<'
      if (state.buffer.endsWith("<")) {
        const plainText = state.buffer.slice(0, -1);
        if (plainText) {
          result.textDelta += plainText;
          state.text += plainText;
        }
        state.buffer = "<";
        break;
      }
      // All plain text
      result.textDelta += state.buffer;
      state.text += state.buffer;
      state.buffer = "";
      break;
    }

    // Emit text before the '<'
    const plainText = state.buffer.slice(0, nextLt);
    if (plainText) {
      result.textDelta += plainText;
      state.text += plainText;
    }
    state.buffer = state.buffer.slice(nextLt);
    // Loop back to check what this '<' starts
  }

  return result;
}

/**
 * Finalize the streaming parser, flushing any remaining buffer content.
 *
 * Returns the final accumulated parse result.
 */
export function finalizeHermesStream(state: HermesStreamState): HermesParseResult {
  // Flush any remaining buffer as text
  if (state.buffer) {
    state.text += state.buffer;
    state.buffer = "";
  }
  if (state.inToolCall && state.toolCallContent) {
    state.errors.push("Unclosed <tool_call> at end of stream");
    // Try to parse the incomplete tool call content anyway
    const parsed = parseToolCallJson(state.toolCallContent.trim());
    if (!parsed.error && parsed.toolCall) {
      state.toolCalls.push(parsed.toolCall);
    }
  }
  if (state.inThinking && state.thinkingContent) {
    // Already accumulated in state.thinking during streaming
  }

  return {
    text: state.text.trim(),
    thinking: state.thinking.trim(),
    toolCalls: state.toolCalls,
    errors: state.errors,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the buffer ends with a partial match of the given tag.
 *
 * For example, if tag is `"</tool_call>"` and buffer ends with `"</tool"`,
 * this returns true — the caller should wait for more data.
 */
function hasPartialTag(buffer: string, tag: string): boolean {
  for (let len = 1; len < tag.length && len <= buffer.length; len++) {
    if (buffer.endsWith(tag.slice(0, len))) {
      return true;
    }
  }
  return false;
}

/**
 * Parse the JSON content of a `<tool_call>` block.
 *
 * Hermes format expects:
 * ```json
 * {"name": "tool_name", "arguments": {"key": "value"}}
 * ```
 *
 * Also accepts the flat format where top-level keys other than
 * "name" and "arguments" are treated as arguments:
 * ```json
 * {"name": "tool_name", "path": "file.txt"}
 * ```
 */
function parseToolCallJson(content: string): {
  toolCall?: HermesToolCall;
  error?: string;
} {
  if (!content) {
    return { error: "Empty <tool_call> content" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Try to extract JSON from surrounding text (some models add explanations)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return { error: `Invalid JSON in <tool_call>: ${content.slice(0, 200)}` };
      }
    } else {
      return { error: `Invalid JSON in <tool_call>: ${content.slice(0, 200)}` };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `<tool_call> content is not a JSON object: ${content.slice(0, 200)}` };
  }

  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : undefined;

  if (!name) {
    return { error: `<tool_call> missing "name" field: ${content.slice(0, 200)}` };
  }

  // Extract arguments — either from explicit "arguments" field or from
  // remaining top-level keys (flat format)
  let args: Record<string, unknown>;
  if (obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)) {
    args = obj.arguments as Record<string, unknown>;
  } else if (typeof obj.arguments === "string") {
    // Some models stringify the arguments
    try {
      const parsedArgs = parseToolArgumentsJson(obj.arguments);
      args = parsedArgs;
    } catch {
      args = { raw: obj.arguments };
    }
  } else {
    // Flat format: everything except "name" is arguments
    const { name: _name, ...rest } = obj;
    args = rest;
  }

  return { toolCall: { name, arguments: args } };
}

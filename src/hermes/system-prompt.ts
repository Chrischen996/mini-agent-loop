/**
 * Hermes-format system prompt generator.
 *
 * When the model uses Hermes tool-calling format, tool definitions must be
 * injected into the system prompt as XML rather than passed via the OpenAI
 * `tools` API parameter.
 *
 * This module builds the system prompt with embedded tool descriptions and
 * Hermes-specific instructions for structured output.
 */

import type { Tool } from "../tools/types.ts";

/**
 * Serialize a single tool into the Hermes XML format.
 *
 * Output format:
 * ```xml
 * <tool>
 * {"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}
 * </tool>
 * ```
 */
function toolToHermesXml(tool: Tool): string {
  const definition = {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
  return `<tool>\n${JSON.stringify(definition, null, 2)}\n</tool>`;
}

/**
 * Build the Hermes tool-calling instruction block.
 *
 * This is appended to the system prompt when the model uses Hermes format.
 */
function buildToolInstructions(tools: Tool[]): string {
  if (tools.length === 0) return "";

  const toolXml = tools.map(toolToHermesXml).join("\n");

  return [
    "",
    "You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags.",
    "You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions.",
    "Here are the available tools:",
    "<tools>",
    toolXml,
    "</tools>",
    "",
    "For each function call, return a JSON object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": "<function-name>", "arguments": <args-json-object>}',
    "</tool_call>",
    "",
    "You may use <think></think> tags to reason through your approach before responding or calling tools.",
    "You may make multiple tool calls in a single response. Wait for tool results before making conclusions about the results.",
  ].join("\n");
}

/**
 * Build the tool result context for Hermes format.
 *
 * When tool results are injected back into the conversation, Hermes models
 * expect them in a specific format within the user/system turn.
 */
export function formatToolResultForHermes(
  toolName: string,
  result: string,
  isError: boolean,
): string {
  const tag = isError ? "tool_error" : "tool_response";
  return `<${tag}>\nTool: ${toolName}\n${result}\n</${tag}>`;
}

export type BuildHermesSystemPromptOptions = {
  /** Base system prompt (agent instructions). */
  basePrompt: string;
  /** Available tools to embed in the prompt. */
  tools: Tool[];
  /** Optional additional instructions to append. */
  additionalInstructions?: string;
};

/**
 * Build a complete system prompt for a Hermes-format model.
 *
 * Combines the base agent instructions with Hermes tool-calling format
 * instructions and embedded tool definitions.
 */
export function buildHermesSystemPrompt(options: BuildHermesSystemPromptOptions): string {
  const parts = [options.basePrompt];

  if (options.tools.length > 0) {
    parts.push(buildToolInstructions(options.tools));
  }

  if (options.additionalInstructions) {
    parts.push(options.additionalInstructions);
  }

  return parts.join("\n");
}

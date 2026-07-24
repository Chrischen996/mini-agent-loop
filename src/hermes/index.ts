/**
 * Hermes Agent format support — barrel export.
 */

// Types
export type {
  ToolCallFormat,
  HermesToolCall,
  HermesParseResult,
  HermesStreamState,
} from "./types.ts";

// Parser
export {
  parseHermesResponse,
  createHermesStreamState,
  feedHermesChunk,
  finalizeHermesStream,
  type HermesStreamChunkResult,
} from "./parser.ts";

// System prompt
export {
  buildHermesSystemPrompt,
  formatToolResultForHermes,
  type BuildHermesSystemPromptOptions,
} from "./system-prompt.ts";

// Format adapter
export {
  shouldEmbedToolsInPrompt,
  prepareSystemPrompt,
  convertHermesResponse,
  postProcessAssistantResponse,
} from "./format-adapter.ts";

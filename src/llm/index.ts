/**
 * Barrel re-export — preserves backward compatibility for all consumers
 * that previously imported from the monolithic `llm.ts`.
 */

// ── config ───────────────────────────────────────────────────────────────────
export {
  type LlmConfig,
  type ChatFn,
  type ModelSwitchOverrides,
  DEFAULT_OUTPUT_TOKEN_CAP,
  loadDotEnvFile,
  loadLlmConfigFromEnv,
  makeLlmConfig,
  resolveOutputTokenLimit,
  switchLlmModel,
  resolveEffectiveApiKey,
} from "./config.ts";

// ── hermes format ────────────────────────────────────────────────────────────
export type { ToolCallFormat } from "../hermes/types.ts";

// ── retry / errors / abort ───────────────────────────────────────────────────
export {
  type StreamChatUsage,
  type StreamChatEvent,
  type RetryableErrorType,
  type RetryStrategy,
  isContextOverflowError,
  classifyError,
  getRetryStrategy,
  calculateBackoff,
  isAbortError,
  throwIfAborted,
  // ── unified LLM event contract ──
  type LlmStreamEvent,
  type ToolCallDelta,
  // ── typed incomplete-response errors ──
  IncompleteLlmResponseError,
  OutputTruncatedError,
  ProtocolError,
  LlmTimeoutError,
} from "./retry.ts";

// ── vision ───────────────────────────────────────────────────────────────────
export { prepareMessagesForModel } from "./vision.ts";

// ── wire format ──────────────────────────────────────────────────────────────
export { toOpenAIMessages } from "./wire.ts";

// ── chat ─────────────────────────────────────────────────────────────────────
export { completeChat, streamChat, streamLlmEvents } from "./chat.ts";

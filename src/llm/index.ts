/**
 * Barrel re-export — preserves backward compatibility for all consumers
 * that previously imported from the monolithic `llm.ts`.
 */

// ── config ───────────────────────────────────────────────────────────────────
export {
  type LlmConfig,
  type ChatFn,
  type ModelSwitchOverrides,
  loadDotEnvFile,
  loadLlmConfigFromEnv,
  makeLlmConfig,
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
} from "./retry.ts";

// ── vision ───────────────────────────────────────────────────────────────────
export { prepareMessagesForModel } from "./vision.ts";

// ── wire format ──────────────────────────────────────────────────────────────
export { toOpenAIMessages } from "./wire.ts";

// ── chat ─────────────────────────────────────────────────────────────────────
export { completeChat, streamChat } from "./chat.ts";

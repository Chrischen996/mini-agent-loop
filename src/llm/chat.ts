/**
 * LLM request execution: completeChat, streamChat, SSE parsing.
 * Orchestrates config, wire-format, vision, retry, and Hermes format modules.
 */
import { supportsImageInput } from "../models.ts";
import { getPiModels } from "../models.ts";
import {
  postProcessAssistantResponse,
  shouldEmbedToolsInPrompt,
} from "../hermes/format-adapter.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../types.ts";
import type { ThinkingLevel } from "../pi-ai/types.ts";
import {
  type LlmConfig,
  requestTimeout,
  firstResponseTimeout,
  streamIdleTimeout,
  timeoutLimitForPhase,
  createRequestSignal,
  resolveEffectiveApiKey,
} from "./config.ts";
import {
  type OpenAIToolCall,
  toOpenAITool,
  toOpenAIMessages,
  mapToolCalls,
  piAssistantHasReasoning,
  toPiContext,
  fromPiAssistant,
} from "./wire.ts";
import { prepareMessagesForModel } from "./vision.ts";
import { clampThinkingLevelForModel } from "../think-intensity.ts";
import {
  isAbortError,
  throwIfAborted,
  type StreamChatEvent,
  type StreamChatUsage,
  type LlmStreamEvent,
  type ToolCallDelta,
  IncompleteLlmResponseError,
  LlmTimeoutError,
  ProtocolError,
  OutputTruncatedError,
} from "./retry.ts";

function reasoningOption(config: LlmConfig): ThinkingLevel | undefined {
  const level = config.thinkingLevel ?? (config.reasoning ? "medium" : "off");
  if (!config.reasoning || level === "off") return undefined;
  const clamped = clampThinkingLevelForModel(config, level);
  return clamped === "off" ? undefined : clamped;
}

function addReasoningOption(body: Record<string, unknown>, config: LlmConfig): void {
  const effort = reasoningOption(config);
  if (!effort) return;

  // Some provider model definitions explicitly reject OpenAI's generic
  // reasoning_effort field (notably xAI/Grok). Sending it through a custom
  // OpenAI-compatible gateway can produce reasoning-only responses.
  if (config.compat?.supportsReasoningEffort === false) return;

  if (config.compat?.thinkingFormat === "openrouter") {
    body.reasoning = { effort };
    return;
  }
  body.reasoning_effort = effort;
}

// ─── Pi-AI chat (internal) ───────────────────────────────────────────────────

async function completePiChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const model = config.piModel;
  if (!model) throw new Error("Pi model configuration is missing");
  const requestModel = config.baseUrl && config.baseUrl !== model.baseUrl
    ? { ...model, baseUrl: config.baseUrl }
    : model;
  const result = await getPiModels().completeSimple(requestModel, toPiContext(messages, tools), {
    maxTokens: config.maxTokens,
    timeoutMs: requestTimeout(config),
    signal,
    apiKey: config.apiKey,
    reasoning: reasoningOption(config),
    sessionId: config.sessionId,
    cacheRetention: config.cacheRetention,
  });
  if (piAssistantHasReasoning(result) && !result.content.some((part) => part.type === "text" && part.text.trim()) && !result.content.some((part) => part.type === "toolCall")) {
    throw new IncompleteLlmResponseError("reasoning_only");
  }
  return fromPiAssistant(result).message;
}

async function* streamPiChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  const model = config.piModel;
  if (!model) throw new Error("Pi model configuration is missing");
  const requestModel = config.baseUrl && config.baseUrl !== model.baseUrl
    ? { ...model, baseUrl: config.baseUrl }
    : model;
  const stream = getPiModels().streamSimple(requestModel, toPiContext(messages, tools), {
    maxTokens: config.maxTokens,
    timeoutMs: requestTimeout(config),
    signal,
    apiKey: config.apiKey,
    reasoning: reasoningOption(config),
    sessionId: config.sessionId,
    cacheRetention: config.cacheRetention,
  });
  for await (const event of stream) {
    if (event.type === "text_delta") {
      yield { type: "answer_delta", text: event.delta };
    } else if (event.type === "thinking_delta") {
      yield { type: "reasoning_delta", text: event.delta };
    } else if (event.type === "done") {
      if (event.reason === "length") {
        yield { type: "error", error: new OutputTruncatedError() };
        return;
      }
      const converted = fromPiAssistant(event.message);
      if (piAssistantHasReasoning(event.message) && !converted.message.content.trim() && !converted.message.toolCalls?.length) {
        yield { type: "error", error: new IncompleteLlmResponseError("reasoning_only") };
        return;
      }
      yield { type: "completed", message: converted.message, usage: converted.usage };
    } else if (event.type === "error") {
      if (event.reason === "aborted") {
        yield { type: "error", error: new DOMException("The operation was aborted", "AbortError") };
        return;
      }
      const errMsg = event.error.errorMessage || "Pi provider stream failed";
      // Normalize Pi provider timeout errors to LlmTimeoutError for consistent handling
      if (/timed? ?out|timeout|request timed/i.test(errMsg)) {
        yield { type: "error", error: new LlmTimeoutError(undefined, undefined, { phase: "total" }) };
      } else {
        yield { type: "error", error: new Error(errMsg) };
      }
    }
  }
}

// ─── SSE line iterator ───────────────────────────────────────────────────────

async function* iterateSseDataLines(
  response: Response,
  signal?: AbortSignal,
  onDone?: () => void,
  onActivity?: () => void,
): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error("LLM stream response missing body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        onDone?.();
        return;
      }
      yield data;
    }
  }

  // Flush a UTF-8 code point that may have been split across the final chunk.
  buffer += decoder.decode();
  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data === "[DONE]") onDone?.();
    else if (data) yield data;
  }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

// ─── Tool call accumulator ───────────────────────────────────────────────────

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

// ─── Public API ──────────────────────────────────────────────────────────────

export async function completeChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  if (config.piModel) return completePiChat(config, messages, tools, signal);
  const supportsImage = supportsImageInput(config.capabilities);
  const prepared = prepareMessagesForModel(messages, config);

  if (prepared.notices.length > 0) {
    console.error(`[llm] ${prepared.notices.join("; ")}`);
  }

  const isHermes = config.toolCallFormat === "hermes";
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
  };

  addReasoningOption(body, config);

  // Hermes format: tools are embedded in the system prompt, not in the API request
  if (!isHermes && tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
  const request = createRequestSignal(signal, requestTimeout(config));
  const effectiveKey = await resolveEffectiveApiKey(config);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${effectiveKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    request.cleanup();
    if (request.didTimeout()) {
      throw new LlmTimeoutError(undefined, undefined, {
        phase: request.timeoutPhase() ?? "total",
        timeoutMs: timeoutLimitForPhase(config, request.timeoutPhase()),
        elapsedMs: request.elapsedMs(),
      });
    }
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM network error: ${message}`);
  }

  const rawText = await response.text();
  request.cleanup();
  if (!response.ok) {
    throw new Error(
      `LLM HTTP ${response.status}: ${rawText.slice(0, 500) || response.statusText}`,
    );
  }

  let data: {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        reasoning_text?: string | null;
        tool_calls?: OpenAIToolCall[];
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      prompt_cache_hit_tokens?: number;
      prompt_cache_write_tokens?: number;
    };
  };

  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    throw new Error(`LLM response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  const choice = data.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("LLM response missing choices[0].message");
  }

  const finishReason = choice.finish_reason ?? null;
  if (finishReason === "length") {
    throw new Error(
      `LLM output reached max_tokens (${config.maxTokens}); increase maxTokens or continue the task.`,
    );
  }
  if (finishReason === "content_filter" || finishReason === "error") {
    throw new Error(`LLM response stopped with finish_reason=${finishReason}`);
  }

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content ?? "";
  const toolCalls = mapToolCalls(message.tool_calls);
  const hasReasoning = [message.reasoning_content, message.reasoning, message.reasoning_text]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  if (hasReasoning && !content.trim() && !toolCalls?.length) {
    throw new IncompleteLlmResponseError("reasoning_only");
  }

  // Extract usage from non-streaming response (mirrors streaming path in streamChat)
  const rawUsage = data.usage;
  let usage: StreamChatUsage | undefined;
  if (rawUsage) {
    const promptTokens = rawUsage.prompt_tokens ?? 0;
    const cacheReadTokens = (rawUsage.prompt_tokens_details?.cached_tokens as number | undefined)
      ?? rawUsage.prompt_cache_hit_tokens;
    const cacheWriteTokens = (rawUsage.prompt_tokens_details?.cache_write_tokens as number | undefined)
      ?? rawUsage.prompt_cache_write_tokens;
    const inputTokens = Math.max(0, promptTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
    usage = {
      promptTokens,
      inputTokens,
      completionTokens: rawUsage.completion_tokens ?? 0,
      totalTokens: rawUsage.total_tokens ?? 0,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    };
  }

  const assistant: AssistantMessage = {
    role: "assistant",
    content: content || "",
    ...(toolCalls ? { toolCalls } : {}),
  };

  // Post-process for Hermes format: extract <tool_call> and <think> from text
  const processed = postProcessAssistantResponse(assistant, config.toolCallFormat);
  if (processed.errors.length > 0) {
    console.error(`[hermes] parse errors: ${processed.errors.join("; ")}`);
  }
  return Object.assign(processed.message, usage ? { usage } : {});
}

/**
 * OpenAI-compatible streaming chat. Yields text deltas, then a final assistant
 * message (including aggregated tool calls).
 */
export async function* streamChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  if (config.piModel) {
    yield* streamPiChat(config, messages, tools, signal);
    return;
  }
  const supportsImage = supportsImageInput(config.capabilities);
  const prepared = prepareMessagesForModel(messages, config);

  if (prepared.notices.length > 0) {
    console.error(`[llm] ${prepared.notices.join("; ")}`);
  }

  const isHermes = config.toolCallFormat === "hermes";
  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    max_tokens: config.maxTokens,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
    // Only send stream_options for providers that support it (not all OpenAI-compatible gateways accept this field)
    ...(config.compat?.supportsUsageInStreaming !== false ? { stream_options: { include_usage: true } } : {}),
  };

  addReasoningOption(body, config);

  // Hermes format: tools are embedded in the system prompt, not in the API request
  if (!isHermes && tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
  const request = createRequestSignal(signal, requestTimeout(config), {
    firstResponseTimeoutMs: firstResponseTimeout(config),
    idleTimeoutMs: streamIdleTimeout(config),
  });
  const effectiveKey = await resolveEffectiveApiKey(config);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${effectiveKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    request.cleanup();
    if (request.didTimeout()) {
      throw new LlmTimeoutError(undefined, undefined, {
        phase: request.timeoutPhase() ?? "total",
        timeoutMs: timeoutLimitForPhase(config, request.timeoutPhase()),
        elapsedMs: request.elapsedMs(),
      });
    }
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM network error: ${message}`);
  }

  if (!response.ok) {
    const rawText = await response.text();
    request.cleanup();
    throw new Error(
      `LLM HTTP ${response.status}: ${rawText.slice(0, 500) || response.statusText}`,
    );
  }

  let content = "";
  let sawReasoning = false;
  const toolAcc = new Map<number, ToolCallAccumulator>();
  let usage: StreamChatUsage | undefined;

  let sawDoneMarker = false;
  let sawFinishReason = false;
  let sawTerminalMessage = false;
  let finishReason: string | null = null;
  try {
    request.markResponseStarted();
    for await (const data of iterateSseDataLines(
      response,
      request.signal,
      () => { sawDoneMarker = true; },
      () => { request.markActivity(); },
    )) {
    let parsed: {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | Array<{ type?: string; text?: string }> | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          reasoning_text?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        message?: {
          content?: string | Array<{ type?: string; text?: string }> | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          reasoning_text?: string | null;
          tool_calls?: OpenAIToolCall[];
        };
      }>;
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      continue;
    }

    // Capture usage whenever it appears (some providers send it mid-stream or at end)
    if (parsed.usage) {
      const promptTokens = parsed.usage.prompt_tokens ?? 0;
      const cacheReadTokens = (parsed.usage as any).prompt_tokens_details?.cached_tokens
        ?? (parsed.usage as any).prompt_cache_hit_tokens
        ?? undefined;
      const cacheWriteTokens = (parsed.usage as any).prompt_tokens_details?.cache_write_tokens
        ?? undefined;
      const inputTokens = Math.max(0, promptTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
      usage = {
        promptTokens,
        inputTokens,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      };
    }

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      sawFinishReason = true;
      finishReason = choice.finish_reason;
    }

    if (choice.message && !choice.delta) {
      sawTerminalMessage = true;
      const terminalContent = typeof choice.message.content === "string"
        ? choice.message.content
        : Array.isArray(choice.message.content)
          ? choice.message.content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("")
          : "";
      if (terminalContent && !content) {
        content = terminalContent;
        yield { type: "answer_delta", text: terminalContent };
      }
      for (const field of [choice.message.reasoning_content, choice.message.reasoning, choice.message.reasoning_text]) {
        if (typeof field === "string" && field.length > 0) {
          sawReasoning = true;
          yield { type: "reasoning_delta", text: field };
          break;
        }
      }
      if (choice.message.tool_calls) {
        for (const [index, tc] of choice.message.tool_calls.entries()) {
          toolAcc.set(index, {
            id: tc.id || `tool_call_${index}`,
            name: tc.function?.name || "unknown",
            arguments: tc.function?.arguments ?? "{}",
          });
        }
      }
      continue;
    }

    const delta = choice.delta;
    if (!delta) continue;

    // Emit reasoning_content as text deltas (DeepSeek reasoning models)
    for (const field of [delta.reasoning_content, delta.reasoning, delta.reasoning_text]) {
      if (typeof field === "string" && field.length > 0) {
        sawReasoning = true;
        yield { type: "reasoning_delta", text: field };
        break;
      }
    }

    const answerDelta = typeof delta.content === "string"
      ? delta.content
      : Array.isArray(delta.content)
        ? delta.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
        : "";
    if (answerDelta.length > 0) {
      content += answerDelta;
      yield { type: "answer_delta", text: answerDelta };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === "number" ? tc.index : 0;
        const current = toolAcc.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          current.arguments += tc.function.arguments;
        }
        toolAcc.set(index, current);
      }
    }
    }

    if (request.didTimeout()) {
      throw new LlmTimeoutError(undefined, undefined, {
        phase: request.timeoutPhase() ?? "total",
        timeoutMs: timeoutLimitForPhase(config, request.timeoutPhase()),
        elapsedMs: request.elapsedMs(),
      });
    }
    if (finishReason === "length") {
      yield { type: "error", error: new OutputTruncatedError() }; return;
    }
    if (finishReason === "content_filter" || finishReason === "error") {
      yield { type: "error", error: new ProtocolError(`stream stopped with finish_reason=${finishReason}`) }; return;
    }
    if (!sawDoneMarker && !sawFinishReason && !sawTerminalMessage) {
      throw new Error("LLM stream ended before completion (missing finish_reason, terminal message, or [DONE])");
    }
  } catch (err) {
    if (request.didTimeout()) {
      throw new LlmTimeoutError(undefined, undefined, {
        phase: request.timeoutPhase() ?? "total",
        timeoutMs: timeoutLimitForPhase(config, request.timeoutPhase()),
        elapsedMs: request.elapsedMs(),
      });
    }
    throw err;
  } finally {
    // Always clear the timeout and parent abort listener, including network
    // failures and malformed/incomplete provider streams.
    request.cleanup();
  }

  const rawToolCalls: OpenAIToolCall[] | undefined =
    toolAcc.size > 0
      ? [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, item]) => ({
            id: item.id || `tool_call_${index}`,
            type: "function" as const,
            function: {
              name: item.name || "unknown",
              arguments: item.arguments || "{}",
            },
          }))
      : undefined;

  const toolCalls = mapToolCalls(rawToolCalls);
  if (sawReasoning && !content.trim() && !toolCalls?.length) {
    yield { type: "error", error: new IncompleteLlmResponseError("reasoning_only") };
    return;
  }
  const assistant: AssistantMessage = {
    role: "assistant",
    content: content || "",
    ...(toolCalls ? { toolCalls } : {}),
  };

  // Post-process for Hermes format: extract <tool_call> and <think> from text
  const processed = postProcessAssistantResponse(assistant, config.toolCallFormat);
  if (processed.errors.length > 0) {
    console.error(`[hermes] parse errors: ${processed.errors.join("; ")}`);
  }
  // Emit reasoning as a separate delta if extracted from Hermes <think> blocks
  if (processed.reasoning) {
    yield { type: "reasoning_delta", text: processed.reasoning };
  }
  yield {
    type: "completed",
    message: processed.message,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Unified LLM stream event入口. Wraps streamChat to provide a consistent
 * LlmStreamEvent interface for the Agent Loop.
 */
export async function* streamLlmEvents(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  yield* streamChat(config, messages, tools, signal);
}

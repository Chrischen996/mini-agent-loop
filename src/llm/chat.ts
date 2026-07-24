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
import {
  type LlmConfig,
  requestTimeout,
  createRequestSignal,
  resolveEffectiveApiKey,
} from "./config.ts";
import {
  type OpenAIToolCall,
  toOpenAITool,
  toOpenAIMessages,
  mapToolCalls,
  toPiContext,
  fromPiAssistant,
} from "./wire.ts";
import { prepareMessagesForModel } from "./vision.ts";
import {
  isAbortError,
  throwIfAborted,
  type StreamChatEvent,
  type StreamChatUsage,
} from "./retry.ts";

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
    reasoning: config.reasoning ? "medium" : undefined,
  });
  return fromPiAssistant(result).message;
}

async function* streamPiChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChatEvent> {
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
    reasoning: config.reasoning ? "medium" : undefined,
  });
  for await (const event of stream) {
    if (event.type === "text_delta") {
      yield { type: "text_delta", text: event.delta, kind: "answer" };
    } else if (event.type === "thinking_delta") {
      yield { type: "text_delta", text: event.delta, kind: "reasoning" };
    } else if (event.type === "done") {
      const converted = fromPiAssistant(event.message);
      yield { type: "assistant", message: converted.message, usage: converted.usage };
    } else if (event.type === "error") {
      if (event.reason === "aborted") throw new DOMException("The operation was aborted", "AbortError");
      throw new Error(event.error.errorMessage || "Pi provider stream failed");
    }
  }
}

// ─── SSE line iterator ───────────────────────────────────────────────────────

async function* iterateSseDataLines(
  response: Response,
  signal?: AbortSignal,
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
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") return;
      yield data;
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
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
      throw new Error(`LLM request timed out after ${requestTimeout(config)}ms. Check the proxy URL and availability.`);
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
      message?: {
        content?: string | null;
        tool_calls?: OpenAIToolCall[];
      };
    }>;
  };

  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    throw new Error(`LLM response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error("LLM response missing choices[0].message");
  }

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content ?? "";
  const toolCalls = mapToolCalls(message.tool_calls);

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
  return processed.message;
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
): AsyncGenerator<StreamChatEvent> {
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
  };

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
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    request.cleanup();
    if (request.didTimeout()) {
      throw new Error(`LLM request timed out after ${requestTimeout(config)}ms. Check the proxy URL and availability.`);
    }
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM network error: ${message}`);
  }

  if (!response.ok) {
    const rawText = await response.text();
    throw new Error(
      `LLM HTTP ${response.status}: ${rawText.slice(0, 500) || response.statusText}`,
    );
  }

  let content = "";
  const toolAcc = new Map<number, ToolCallAccumulator>();
  let usage: StreamChatUsage | undefined;

  for await (const data of iterateSseDataLines(response, request.signal)) {
    let parsed: {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
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
      usage = {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      };
    }

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    if (choice.message && !choice.delta) {
      if (typeof choice.message.content === "string" && choice.message.content && !content) {
        content = choice.message.content;
        yield { type: "text_delta", text: content, kind: "answer" };
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
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { type: "text_delta", text: delta.reasoning_content, kind: "reasoning" };
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      yield { type: "text_delta", text: delta.content, kind: "answer" };
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
    request.cleanup();
    throw new Error(`LLM request timed out after ${requestTimeout(config)}ms. Check the proxy URL and availability.`);
  }

  request.cleanup();

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
    yield { type: "text_delta", text: processed.reasoning, kind: "reasoning" as const };
  }
  yield {
    type: "assistant",
    message: processed.message,
    ...(usage ? { usage } : {}),
  };
}

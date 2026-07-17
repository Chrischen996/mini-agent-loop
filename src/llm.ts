import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  extractImageParts,
  extractVisionAnalysisParts,
  hasImageParts,
  hasVisionAnalysisParts,
  normalizeToParts,
  partsToPlainText,
  replaceImagesWithPlaceholders,
  stripImages,
  textPart,
  visionAnalysisAsText,
} from "./content.ts";
import {
  getAvailableModels,
  getPiModels,
  parseImagePolicy,
  resolveModel,
  supportsImageInput,
  type ImagePolicy,
  type ModelCapabilities,
  type ModelRef,
} from "./models.ts";
import type { Tool } from "./tools/types.ts";
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  Tool as PiTool,
} from "./pi-ai/types.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ContentPart,
  ImagePart,
  MessageContent,
  ToolCall,
  UserMessage,
} from "./types.ts";
import { parseToolArgumentsJson } from "./validate.ts";

export type LlmConfig = {
  apiKey: string;
  provider: string;
  baseUrl: string;
  model: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  timeoutMs?: number;
  piModel?: ModelRef["piModel"];
  reasoning: boolean;
  imagePolicy: ImagePolicy;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function configuredTimeout(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function requestTimeout(config: LlmConfig): number {
  return config.timeoutMs ?? configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS);
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export type ChatFn = (
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
) => Promise<AssistantMessage>;

/**
 * Load KEY=VALUE pairs from a local .env file into process.env (no overwrite).
 * Teaching-friendly: avoids a dotenv dependency.
 */
export function loadDotEnvFile(
  filePath = path.join(process.cwd(), ".env"),
): void {
  if (!existsSync(filePath)) return;

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadLlmConfigFromEnv(): LlmConfig {
  loadDotEnvFile();

  const useDeepSeek =
    Boolean(process.env.DEEPSEEK_API_KEY) ||
    /deepseek/i.test(process.env.OPENAI_BASE_URL ?? "") ||
    /deepseek/i.test(process.env.OPENAI_MODEL ?? "");

  const available = getAvailableModels();
  const firstConfigured = available[0];
  const model = process.env.OPENAI_MODEL ||
    (useDeepSeek
      ? "deepseek/deepseek-v4-flash"
      : firstConfigured
        ? `${firstConfigured.provider}/${firstConfigured.id}`
        : "openai/gpt-4o-mini");

  const resolved = resolveModel(model, process.env.OPENAI_BASE_URL);
  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    resolved.baseUrl ||
    (useDeepSeek ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1")
  ).replace(/\/$/, "");

  const apiKeyNames = [
    ...resolved.apiKeyEnv,
    ...(process.env.OPENAI_BASE_URL ? ["OPENAI_API_KEY"] : []),
  ];
  const apiKey = apiKeyNames
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  if (!apiKey && !resolved.piModel) {
    throw new Error(
      [
        `Missing API key for model ${resolved.id}.`,
        `Set one of: ${apiKeyNames.join(", ")}.`,
      ].join("\n"),
    );
  }

  const imagePolicy = parseImagePolicy(process.env.IMAGE_POLICY);

  return {
    apiKey: apiKey ?? "",
    provider: resolved.provider,
    baseUrl,
    model: resolved.id,
    capabilities: resolved.capabilities,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    timeoutMs: configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS),
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
    imagePolicy,
  };
}

/** Test helper / explicit config builder. */
export function makeLlmConfig(
  partial: Pick<LlmConfig, "apiKey" | "baseUrl" | "model"> & {
    provider?: string;
    capabilities?: ModelCapabilities;
    contextWindow?: number;
    maxTokens?: number;
    timeoutMs?: number;
    reasoning?: boolean;
    imagePolicy?: ImagePolicy;
  },
): LlmConfig {
  const resolved = resolveModel(partial.model, partial.baseUrl);
  return {
    apiKey: partial.apiKey,
    provider: partial.provider ?? resolved.provider,
    baseUrl: partial.baseUrl.replace(/\/$/, ""),
    model: partial.model,
    capabilities: partial.capabilities ?? resolved.capabilities,
    contextWindow: partial.contextWindow ?? resolved.contextWindow,
    maxTokens: partial.maxTokens ?? resolved.maxTokens,
    timeoutMs: partial.timeoutMs,
    piModel: resolved.piModel,
    reasoning: partial.reasoning ?? resolved.reasoning,
    imagePolicy: partial.imagePolicy ?? "placeholder",
  };
}

export type ModelSwitchOverrides = {
  baseUrl?: string;
  apiKey?: string;
};

export function switchLlmModel(
  config: LlmConfig,
  model: ModelRef | string,
  overrides: ModelSwitchOverrides = {},
): LlmConfig {
  const requestedBaseUrl = overrides.baseUrl?.trim().replace(/\/$/, "");
  const resolved = typeof model === "string"
    ? resolveModel(model, requestedBaseUrl)
    : requestedBaseUrl
      ? resolveModel(`${model.provider}/${model.id}`, requestedBaseUrl)
      : model;
  const apiKey = resolved.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  // If no env var key found but the new model targets the same base URL as the
  // current config, reuse the existing API key. This covers the case where
  // DeepSeek (or any provider) is configured via OPENAI_API_KEY + OPENAI_BASE_URL
  // rather than the provider-specific env var name.
  const effectiveApiKey = overrides.apiKey?.trim()
    || apiKey
    || (resolved.baseUrl === config.baseUrl ? config.apiKey : undefined);

  if (!effectiveApiKey && !resolved.piModel) {
    throw new Error(
      `Missing API key for model ${resolved.id}. Set one of: ${resolved.apiKeyEnv.join(", ")}.`,
    );
  }
  return {
    ...config,
    apiKey: effectiveApiKey ?? "",
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    model: resolved.id,
    capabilities: resolved.capabilities,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
  };
}

type OpenAIToolCall = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

function toOpenAITool(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function imageToDataUrl(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}

function userContentToOpenAI(
  content: MessageContent,
  supportsImage: boolean,
): string | OpenAIContentPart[] {
  const parts = normalizeToParts(content);
  if (parts.length === 0) return "";

  const onlyText =
    parts.every((p) => p.type === "text") &&
    parts.length === 1 &&
    parts[0]?.type === "text";
  if (onlyText && parts[0]?.type === "text") {
    return parts[0].text;
  }

  const out: OpenAIContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "vision_analysis") {
      out.push({ type: "text", text: visionAnalysisAsText(part) });
    } else if (supportsImage) {
      out.push({
        type: "image_url",
        image_url: { url: imageToDataUrl(part) },
      });
    } else {
      // Should already be gated; defensive
      out.push({
        type: "text",
        text: `[Image omitted: model does not support vision; source=${part.source ?? "image"}]`,
      });
    }
  }
  return out;
}

/**
 * Capability gate: degrade or reject images before wire mapping.
 * For vision models, tool messages with images become text-only tool rows
 * plus a synthetic user message carrying the images (API copy only).
 */
export function prepareMessagesForModel(
  messages: AgentMessage[],
  config: LlmConfig,
): { messages: AgentMessage[]; notices: string[] } {
  const supportsImage = supportsImageInput(config.capabilities);
  const notices: string[] = [];
  const policy = config.imagePolicy;

  if (!supportsImage) {
    if (policy === "fail" && messages.some((m) => {
      if (m.role === "user" || m.role === "tool") return hasImageParts(m.content);
      return false;
    })) {
      throw new Error(
        `Model ${config.model} does not support vision, but the conversation contains image content. Set IMAGE_POLICY=placeholder or use a vision model (e.g. gpt-4o-mini).`,
      );
    }

    const analyzedSources = new Set(
      messages.flatMap((message) =>
        message.role === "user" || message.role === "tool"
          ? extractVisionAnalysisParts(message.content).flatMap(
              (analysis) => analysis.sources,
            )
          : [],
      ),
    );

    const degraded: AgentMessage[] = messages.map((m) => {
      if (m.role !== "user" && m.role !== "tool") return m;
      if (!hasImageParts(m.content)) return m;

      const imageParts = extractImageParts(m.content);
      const coveredByBatchAnalysis = imageParts.every(
        (image) => image.source && analyzedSources.has(image.source),
      );
      if (hasVisionAnalysisParts(m.content) || coveredByBatchAnalysis) {
        const analyzed = stripImages(m.content);
        notices.push(
          `Images replaced by vision analysis for model ${config.model}`,
        );
        const nextContent: MessageContent =
          analyzed.length === 1 && analyzed[0]?.type === "text"
            ? analyzed[0].text
            : analyzed;
        return { ...m, content: nextContent };
      }

      notices.push(
        `Images degraded for model ${config.model} (policy=${policy})`,
      );

      if (policy === "strip") {
        const texts = stripImages(m.content);
        const nextContent: MessageContent =
          texts.length === 0
            ? ""
            : texts.length === 1
              ? texts[0]!.text
              : texts;
        return { ...m, content: nextContent };
      }

      // placeholder (default)
      const parts = replaceImagesWithPlaceholders(m.content, config.model);
      const nextContent: MessageContent =
        parts.length === 1 && parts[0]?.type === "text"
          ? parts[0].text
          : parts;
      return { ...m, content: nextContent };
    });

    return { messages: degraded, notices };
  }

  // Vision model: elevate tool images into synthetic user messages (API copy).
  // Flush only after a consecutive tool-result block so tool-call protocol
  // ordering remains assistant -> all tool results -> user attachment.
  const elevated: AgentMessage[] = [];
  let pendingToolImages: ContentPart[] = [];
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]!;
    if (m.role !== "tool" || !hasImageParts(m.content)) {
      elevated.push(m);
    } else {
      const images = extractImageParts(m.content);
      const textBody =
        partsToPlainText(stripImages(m.content)) ||
        `Tool ${m.name} returned ${images.length} image(s).`;

      elevated.push({
        ...m,
        content: `${textBody}\n[Image content attached after the tool result block for vision models.]`,
      });
      pendingToolImages.push(
        textPart(
          `Image(s) from tool "${m.name}" (tool_call_id=${m.toolCallId}):`,
        ),
        ...images,
      );
      notices.push(
        `Elevated ${images.length} tool image(s) from ${m.name} for vision model`,
      );
    }

    const next = messages[index + 1];
    if (m.role === "tool" && next?.role !== "tool" && pendingToolImages.length > 0) {
      const syntheticUser: UserMessage = {
        role: "user",
        content: pendingToolImages,
      };
      elevated.push(syntheticUser);
      pendingToolImages = [];
    }
  }

  return { messages: elevated, notices };
}

export function toOpenAIMessages(
  messages: AgentMessage[],
  supportsImage: boolean,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user":
        out.push({
          role: "user",
          content: userContentToOpenAI(message.content, supportsImage),
        });
        break;
      case "assistant": {
        const row: OpenAIMessage = {
          role: "assistant",
          content: message.content || null,
        };
        if (message.toolCalls && message.toolCalls.length > 0) {
          row.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          }));
        }
        out.push(row);
        break;
      }
      case "tool":
        // Tool role is always string on the wire
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: partsToPlainText(message.content),
          name: message.name,
        });
        break;
      default: {
        const _exhaustive: never = message;
        return _exhaustive;
      }
    }
  }

  return out;
}

function mapToolCalls(
  raw: OpenAIToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;

  return raw.map((tc, index) => {
    const id = tc.id || `tool_call_${index}`;
    const name = tc.function?.name || "unknown";
    const rawArgs = tc.function?.arguments ?? "{}";

    try {
      const args = parseToolArgumentsJson(rawArgs);
      return { id, name, arguments: args };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id,
        name,
        arguments: {},
        argumentsParseError: message,
      };
    }
  });
}

function toPiContent(content: MessageContent): Array<PiTextContent | PiImageContent> {
  const result: Array<PiTextContent | PiImageContent> = [];
  for (const part of normalizeToParts(content)) {
    if (part.type === "text") result.push({ type: "text", text: part.text });
    else if (part.type === "vision_analysis") result.push({ type: "text", text: visionAnalysisAsText(part) });
    else result.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  return result;
}

function toPiMessages(messages: AgentMessage[]): { systemPrompt?: string; messages: PiMessage[] } {
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n") || undefined;
  const converted: PiMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      converted.push({ role: "user", content: toPiContent(message.content), timestamp: Date.now() });
    } else if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content } satisfies PiTextContent] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
        api: "openai-completions",
        provider: "mini-agent",
        model: "history",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
    } else {
      converted.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: toPiContent(message.content),
        isError: Boolean(message.isError),
        timestamp: Date.now(),
      });
    }
  }
  return { systemPrompt, messages: converted };
}

function toPiContext(messages: AgentMessage[], tools?: Tool[]): PiContext {
  const converted = toPiMessages(messages);
  return {
    systemPrompt: converted.systemPrompt,
    messages: converted.messages,
    tools: tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } as PiTool)),
  };
}

function fromPiAssistant(message: PiAssistantMessage): {
  message: AssistantMessage;
  usage: StreamChatUsage;
} {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const toolCalls = message.content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments }));
  return {
    message: {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    usage: {
      promptTokens: message.usage.input,
      completionTokens: message.usage.output,
      totalTokens: message.usage.totalTokens,
    },
  };
}

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

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
  };

  if (tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
  const request = createRequestSignal(signal, requestTimeout(config));
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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

  return {
    role: "assistant",
    content: content || "",
    ...(toolCalls ? { toolCalls } : {}),
  };
}

export type StreamChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(context length|context window|maximum context|max context|too many tokens|prompt is too long|token limit|input.*token)/i.test(message);
}

export type StreamChatEvent =
  | { type: "text_delta"; text: string; kind: "reasoning" | "answer" }
  | { type: "assistant"; message: AssistantMessage; usage?: StreamChatUsage };

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted|AbortError/i.test(message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

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

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    max_tokens: config.maxTokens,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
  };

  if (tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
  const request = createRequestSignal(signal, requestTimeout(config));
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: content || "",
      ...(toolCalls ? { toolCalls } : {}),
    },
    ...(usage ? { usage } : {}),
  };
}

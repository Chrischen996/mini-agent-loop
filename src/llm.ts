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
  parseImagePolicy,
  resolveModel,
  supportsImageInput,
  type ImagePolicy,
  type ModelCapabilities,
} from "./models.ts";
import type { Tool } from "./tools/types.ts";
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
  baseUrl: string;
  model: string;
  capabilities: ModelCapabilities;
  imagePolicy: ImagePolicy;
};

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

  const model =
    process.env.OPENAI_MODEL ||
    (useDeepSeek ? "deepseek-chat" : "gpt-4o-mini");

  const resolved = resolveModel(model, process.env.OPENAI_BASE_URL);
  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    resolved.baseUrl ||
    (useDeepSeek ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1")
  ).replace(/\/$/, "");

  const apiKey = resolved.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  if (!apiKey) {
    throw new Error(
      [
        `Missing API key for model ${resolved.id}.`,
        `Set one of: ${resolved.apiKeyEnv.join(", ")}.`,
      ].join("\n"),
    );
  }

  const imagePolicy = parseImagePolicy(process.env.IMAGE_POLICY);

  return {
    apiKey,
    baseUrl,
    model: resolved.id,
    capabilities: resolved.capabilities,
    imagePolicy,
  };
}

/** Test helper / explicit config builder. */
export function makeLlmConfig(
  partial: Omit<LlmConfig, "capabilities" | "imagePolicy"> & {
    capabilities?: ModelCapabilities;
    imagePolicy?: ImagePolicy;
  },
): LlmConfig {
  const resolved = resolveModel(partial.model, partial.baseUrl);
  return {
    apiKey: partial.apiKey,
    baseUrl: partial.baseUrl.replace(/\/$/, ""),
    model: partial.model,
    capabilities: partial.capabilities ?? resolved.capabilities,
    imagePolicy: partial.imagePolicy ?? "placeholder",
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

export async function completeChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const supportsImage = supportsImageInput(config.capabilities);
  const prepared = prepareMessagesForModel(messages, config);

  if (prepared.notices.length > 0) {
    console.error(`[llm] ${prepared.notices.join("; ")}`);
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
  };

  if (tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM network error: ${message}`);
  }

  const rawText = await response.text();
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

export type StreamChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "assistant"; message: AssistantMessage };

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
  const supportsImage = supportsImageInput(config.capabilities);
  const prepared = prepareMessagesForModel(messages, config);

  if (prepared.notices.length > 0) {
    console.error(`[llm] ${prepared.notices.join("; ")}`);
  }

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: toOpenAIMessages(prepared.messages, supportsImage),
  };

  if (tools && tools.length > 0 && config.capabilities.tools) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = "auto";
  }

  const url = `${config.baseUrl}/chat/completions`;
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
      signal,
    });
  } catch (err) {
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

  for await (const data of iterateSseDataLines(response, signal)) {
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        message?: {
          content?: string | null;
          tool_calls?: OpenAIToolCall[];
        };
      }>;
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      continue;
    }

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    if (choice.message && !choice.delta) {
      if (typeof choice.message.content === "string" && choice.message.content && !content) {
        content = choice.message.content;
        yield { type: "text_delta", text: content };
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

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      yield { type: "text_delta", text: delta.content };
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
  };
}


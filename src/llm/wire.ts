/**
 * Wire-format conversion: OpenAI and Pi-AI message serialization.
 */
import {
  normalizeToParts,
  partsToPlainText,
  visionAnalysisAsText,
} from "../content.ts";
import type { Tool } from "../tools/types.ts";
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  Tool as PiTool,
} from "../pi-ai/types.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ImagePart,
  MessageContent,
  ToolCall,
} from "../types.ts";
import { parseToolArgumentsJson } from "../validate.ts";
import type { StreamChatUsage } from "./retry.ts";

// ─── OpenAI wire types ───────────────────────────────────────────────────────

export type OpenAIToolCall = {
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

// ─── OpenAI serialization ────────────────────────────────────────────────────

export function toOpenAITool(tool: Tool): Record<string, unknown> {
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

export function userContentToOpenAI(
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

export function mapToolCalls(
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

// ─── Pi-AI wire conversion ───────────────────────────────────────────────────

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

export function toPiContext(messages: AgentMessage[], tools?: Tool[]): PiContext {
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

export function fromPiAssistant(message: PiAssistantMessage): {
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

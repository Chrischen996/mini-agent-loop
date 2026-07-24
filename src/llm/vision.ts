/**
 * Image/vision capability gating — degrade or reject images before wire mapping.
 */
import {
  extractImageParts,
  extractVisionAnalysisParts,
  hasImageParts,
  hasVisionAnalysisParts,
  partsToPlainText,
  replaceImagesWithPlaceholders,
  stripImages,
  textPart,
} from "../content.ts";
import { supportsImageInput } from "../models.ts";
import type {
  AgentMessage,
  ContentPart,
  MessageContent,
  UserMessage,
} from "../types.ts";
import type { LlmConfig } from "./config.ts";

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

import type {
  AgentMessage,
  ContentPart,
  ImagePart,
  MessageContent,
  TextPart,
  VisionAnalysisPart,
} from "./types.ts";

export function textPart(text: string): TextPart {
  return { type: "text", text };
}

export function imagePart(
  mimeType: string,
  data: string,
  source?: string,
): ImagePart {
  return { type: "image", mimeType, data, source };
}

export function visionAnalysisPart(
  text: string,
  model: string,
  sources: string[],
): VisionAnalysisPart {
  return { type: "vision_analysis", text, model, sources };
}

export function normalizeToParts(content: MessageContent): ContentPart[] {
  if (typeof content === "string") {
    return content ? [textPart(content)] : [];
  }
  return content;
}

export function hasImageParts(content: MessageContent): boolean {
  return normalizeToParts(content).some((p) => p.type === "image");
}

export function hasVisionAnalysisParts(content: MessageContent): boolean {
  return normalizeToParts(content).some((p) => p.type === "vision_analysis");
}

export function messagesHaveImages(messages: AgentMessage[]): boolean {
  for (const m of messages) {
    if (m.role === "user" || m.role === "tool") {
      if (hasImageParts(m.content)) return true;
    }
  }
  return false;
}

export function imageOmissionPlaceholder(
  part: ImagePart,
  modelId: string,
): string {
  const source = part.source ?? "image";
  return `[Image omitted: model ${modelId} does not support vision; source=${source} mime=${part.mimeType}]`;
}

/** Replace image parts with text placeholders (non-vision models). */
export function replaceImagesWithPlaceholders(
  content: MessageContent,
  modelId: string,
): ContentPart[] {
  return normalizeToParts(content).map((part) => {
    if (part.type === "image") {
      return textPart(imageOmissionPlaceholder(part, modelId));
    }
    return part;
  });
}

/** Drop image parts entirely. */
export function stripImages(
  content: MessageContent,
): Array<TextPart | VisionAnalysisPart> {
  return normalizeToParts(content).filter((p) => p.type !== "image");
}

export function visionAnalysisAsText(part: VisionAnalysisPart): string {
  return [
    `[Vision analysis: model=${part.model}; sources=${part.sources.join(", ")}]`,
    part.text,
    "[End vision analysis]",
  ].join("\n");
}

export function partsToPlainText(content: MessageContent): string {
  return normalizeToParts(content)
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "vision_analysis") return visionAnalysisAsText(p);
      return `[image:${p.source ?? p.mimeType}]`;
    })
    .join("\n");
}

export function extractImageParts(content: MessageContent): ImagePart[] {
  return normalizeToParts(content).filter(
    (p): p is ImagePart => p.type === "image",
  );
}

export function extractTextParts(content: MessageContent): TextPart[] {
  return normalizeToParts(content).filter(
    (p): p is TextPart => p.type === "text",
  );
}

export function extractVisionAnalysisParts(
  content: MessageContent,
): VisionAnalysisPart[] {
  return normalizeToParts(content).filter(
    (p): p is VisionAnalysisPart => p.type === "vision_analysis",
  );
}

/** Collapse parts to a single string (for tool wire format / tests). */
export function contentAsString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return partsToPlainText(content);
}

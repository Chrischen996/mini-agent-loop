import type { Request } from "express";
import type { AgentMessage, ContentPart, ImageMimeType } from "../types.ts";
import { sanitizeResumableMessages } from "../session-manager.ts";
import type { ModelThinkingLevel } from "../pi-ai/index.ts";
import type { ThinkingMode } from "../thinking-policy.ts";
import {
  parseThinkingIntensityPrompt,
  parseThinkingCommandMode,
  intensityToModelThinkingLevel,
} from "../think-intensity.ts";
import { imagePart, textPart } from "../content.ts";
import { documentTextPart } from "../attachments.ts";
import type { DocumentStore } from "../documents.ts";
import { validateReferencedPaths } from "../workspace.ts";

export function sniffImageMime(buffer: Buffer): ImageMimeType | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export const DEFAULT_IMAGE_PROMPT = "Please analyze the attached image(s).";
export const DEFAULT_REFERENCE_PROMPT = "请阅读引用的文件并说明要点";

export function parseReferencedPathsField(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  if (typeof raw !== "string") {
    throw new Error("referencedPaths must be a JSON string array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("referencedPaths must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("referencedPaths must be a JSON array");
  }
  return parsed.map((item) => String(item));
}

export function formatReferencedBlock(paths: string[]): string {
  return [
    "Referenced workspace files (use the read tool; do not invent contents):",
    ...paths.map((item) => `- ${item}`),
  ].join("\n");
}

export function truncateSessionMessages(messages: AgentMessage[], visibleCount: number): AgentMessage[] {
  return sanitizeResumableMessages(messages, visibleCount);
}

export function visibleMessageCount(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role !== "system").length;
}

export function resolveMessageBoundary(
  visibleMessages: AgentMessage[],
  body: { messageId?: unknown; messageIndex?: unknown } | undefined,
  defaultToEnd: boolean,
): { messageIndex: number } | { error: string } {
  if (body?.messageId !== undefined && body?.messageIndex !== undefined) {
    return { error: "messageId and messageIndex are mutually exclusive" };
  }
  if (body?.messageId !== undefined) {
    if (typeof body.messageId !== "string" || body.messageId.length === 0) {
      return { error: "messageId must be a non-empty string" };
    }
    const index = visibleMessages.findIndex((message) => message.id === body.messageId);
    if (index < 0) return { error: `messageId not found: ${body.messageId}` };
    // A message ID identifies the last message to retain, while the legacy
    // index API identifies the number of messages to retain.
    return { messageIndex: index + 1 };
  }
  if (body?.messageIndex === undefined && defaultToEnd) {
    return { messageIndex: visibleMessages.length };
  }
  const messageIndex = Number(body?.messageIndex);
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex > visibleMessages.length) {
    return { error: `messageIndex must be an integer between 0 and ${visibleMessages.length}` };
  }
  return { messageIndex };
}

export function messageIdAtBoundary(messages: AgentMessage[], visibleCount: number): string | undefined {
  return messages
    .filter((message) => message.role !== "system")
    .at(visibleCount - 1)?.id;
}

export function buildModelPrompt(input: {
  prompt: string;
  referencedPaths: string[];
  hasImages: boolean;
}): {
  displayPrompt: string;
  modelPrompt: string;
  thinkingLevel: ModelThinkingLevel | null;
  thinkingMode: ThinkingMode | null;
} {
  const thinking = parseThinkingIntensityPrompt(input.prompt.trim());
  const text = thinking.prompt;
  const refs = input.referencedPaths;

  let displayPrompt = text;
  if (!displayPrompt) {
    if (refs.length > 0) displayPrompt = DEFAULT_REFERENCE_PROMPT;
    else if (input.hasImages) displayPrompt = "分析图片";
    else displayPrompt = "";
  }

  let base = text;
  if (!base) {
    if (refs.length > 0) base = DEFAULT_REFERENCE_PROMPT;
    else if (input.hasImages) base = DEFAULT_IMAGE_PROMPT;
  }

  const modelPrompt = refs.length > 0
    ? `${base}\n\n${formatReferencedBlock(refs)}`
    : base;

  return {
    displayPrompt,
    modelPrompt,
    thinkingLevel: thinking.intensity
      ? intensityToModelThinkingLevel(thinking.intensity)
      : null,
    thinkingMode: thinking.intensity ? "fixed" : parseThinkingCommandMode(input.prompt) ?? null,
  };
}

export async function parseMessageRequest(
  request: Request,
  workspace: string,
  documentStore: DocumentStore,
  sessionId: string,
): Promise<{
  displayPrompt: string;
  modelPrompt: string;
  thinkingLevel: ModelThinkingLevel | null;
  thinkingMode: ThinkingMode | null;
  images: ContentPart[];
  imageNames: string[];
  documents: ContentPart[];
  documentNames: string[];
  referencedPaths: string[];
}> {
  const prompt = String(request.body?.prompt ?? "").trim();
  const fileFields = (request.files ?? {}) as Record<string, Express.Multer.File[]>;
  const imageFiles = fileFields.images ?? [];
  const documentFiles = fileFields.documents ?? [];
  const images: ContentPart[] = [];
  const imageNames: string[] = [];
  const documents: ContentPart[] = [];
  const documentNames: string[] = [];

  for (const file of imageFiles) {
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType) {
      throw new Error(`Unsupported or invalid image: ${file.originalname}`);
    }
    const source = file.originalname || `upload-${images.length + 1}`;
    images.push(imagePart(mimeType, file.buffer.toString("base64"), source));
    imageNames.push(source);
  }

  for (const file of documentFiles) {
    const parsed = await documentStore.addUpload(
      sessionId,
      file.originalname || "document",
      file.buffer,
      file.mimetype,
    );
    documents.push(textPart(documentTextPart(parsed, parsed.id)));
    documentNames.push(parsed.name);
  }

  const rawRefs = parseReferencedPathsField(request.body?.referencedPaths);
  const referencedPaths = await validateReferencedPaths(workspace, rawRefs);

  if (
    !parseThinkingIntensityPrompt(prompt).prompt &&
    images.length === 0 &&
    documents.length === 0 &&
    referencedPaths.length === 0
  ) {
    throw new Error("A prompt, image, document, or referenced path is required");
  }

  const built = buildModelPrompt({
    prompt,
    referencedPaths,
    hasImages: images.length > 0,
  });

  return {
    displayPrompt: built.displayPrompt,
    modelPrompt: built.modelPrompt,
    thinkingLevel: built.thinkingLevel,
    thinkingMode: built.thinkingMode,
    images,
    imageNames,
    documents,
    documentNames,
    referencedPaths,
  };
}

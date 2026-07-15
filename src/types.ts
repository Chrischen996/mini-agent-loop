export type TextPart = {
  type: "text";
  text: string;
};

export type ImagePart = {
  type: "image";
  mimeType: string; // image/png | image/jpeg | image/gif | image/webp
  /** Base64 payload without data: prefix */
  data: string;
  source?: string; // relative path, "cli", etc.
};

export type VisionAnalysisPart = {
  type: "vision_analysis";
  text: string;
  model: string;
  sources: string[];
};

export type ContentPart = TextPart | ImagePart | VisionAnalysisPart;

/** Plain string stays supported for teaching / backward compatibility. */
export type MessageContent = string | ContentPart[];

export type UserMessage = {
  role: "user";
  content: MessageContent;
};

export type AssistantMessage = {
  role: "assistant";
  /** Assistant stays text-only in this teaching cut. */
  content: string;
  toolCalls?: ToolCall[];
};

export type SystemMessage = {
  role: "system";
  content: string;
};

export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  name: string;
  content: MessageContent;
  isError?: boolean;
};

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage;

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export type ToolCall = {
  id: string;
  name: string;
  /** Already JSON-parsed arguments (may be empty if parse failed). */
  arguments: Record<string, unknown>;
  /** Set when the model returned invalid JSON for arguments. */
  argumentsParseError?: string;
};

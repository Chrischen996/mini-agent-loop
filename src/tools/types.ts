import type { MessageContent } from "../types.ts";

export type JsonSchema = Record<string, unknown>;

export type ToolResult = {
  /** Text and/or image parts (string still allowed). */
  content: MessageContent;
  isError?: boolean;
  files?: FileArtifact[];
};

export type FileArtifact = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  reused?: boolean;
};

export type Tool<TArgs = Record<string, unknown>> = {
  name: string;
  description: string;
  /** OpenAI function parameters object (JSON Schema). */
  parameters: JsonSchema;
  execute: (args: TArgs, signal?: AbortSignal) => Promise<ToolResult>;
};

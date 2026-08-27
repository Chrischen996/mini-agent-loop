export type RenderLineStyle = "assistant" | "thinking" | "muted" | "tool" | "todo" | "error";
export type RenderLineTone = "default" | "success" | "running" | "error";

/** A terminal-ready logical line shared by Ink and the incremental renderer. */
export type RenderLine = {
  key: string;
  text: string;
  prefix?: string;
  style: RenderLineStyle;
  tone?: RenderLineTone;
  indent?: number;
  dim?: boolean;
  bold?: boolean;
  strikethrough?: boolean;
};

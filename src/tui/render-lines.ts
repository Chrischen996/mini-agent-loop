export type RenderLineStyle = "assistant" | "thinking" | "muted" | "tool" | "todo" | "error" | "user" | "border";
export type RenderLineTone = "default" | "success" | "running" | "error";
export type RenderLineBackground = "user" | "selection" | "badge";

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
  italic?: boolean;
  strikethrough?: boolean;
  background?: RenderLineBackground;
  /** Optional terminal width to paint a background across the whole row. */
  fillWidth?: number;
};

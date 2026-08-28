export type RenderLineStyle = "assistant" | "thinking" | "muted" | "tool" | "todo" | "error" | "user" | "border";
export type RenderLineTone = "default" | "success" | "running" | "error";
export type RenderLineBackground = "user" | "selection" | "badge";

/** A terminal-ready logical line shared by Ink and the incremental renderer. */
export type RenderLine = {
  key: string;
  text: string;
  prefix?: string;
  /** Optional tone for the marker/prefix while the body keeps its own tone. */
  prefixTone?: RenderLineTone;
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
  /**
   * Main-screen mode keeps these rows in a small live region at the bottom.
   * They are redrawn while the current turn, prompt, or overlay changes;
   * completed transcript rows are appended to terminal scrollback instead.
   */
  ephemeral?: boolean;
};

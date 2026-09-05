export type RenderLineStyle = "assistant" | "thinking" | "muted" | "tool" | "todo" | "error" | "user" | "border";
export type RenderLineTone = "default" | "success" | "running" | "error";
export type RenderLineBackground = "user" | "selection" | "badge";

/**
 * One independently colored run inside a row.
 *
 * Chrome rows such as the status line need several colors on a single physical
 * row. Without inline segments the ANSI renderer had to flatten the whole row
 * to one color, which is why its status line could not match the Ink client.
 */
export type RenderSegment = {
  text: string;
  /**
   * Optional semantic tag (for example a status-row role such as `model` or
   * `mode`). Renderers ignore it; it keeps a segment identifiable for callers
   * that build the row and for tests that assert on its structure.
   */
  role?: string;
  /** Hex color; falls back to the owning line's resolved color. */
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
};

/** A terminal-ready logical line shared by Ink and the incremental renderer. */
export type RenderLine = {
  key: string;
  text: string;
  /** Optional inline color runs. When present, `text` stays the plain fallback. */
  segments?: RenderSegment[];
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

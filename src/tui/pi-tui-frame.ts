import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { RenderLine } from "./render-lines.ts";
import { formatRenderLine } from "./render-line-format.ts";

export type PiTuiFrameBuilder = (width: number, height: number) => readonly RenderLine[];

/**
 * Bridges the existing presentation model to pi-tui's physical-row component
 * contract. pi-tui owns the viewport and redraw policy; the application still
 * owns state, input actions, and message projection.
 */
export class PiTuiFrame implements Component {
  constructor(
    private readonly terminal: Pick<Terminal, "rows">,
    private readonly buildFrame: PiTuiFrameBuilder,
    private readonly onInput: (data: string) => void,
  ) {}

  render(width: number): string[] {
    const height = Math.max(1, this.terminal.rows || 24);
    return this.buildFrame(width, height).map((line) => {
      const formatted = formatRenderLine(line);
      return visibleWidth(formatted) > width
        ? truncateToWidth(formatted, width, "")
        : formatted;
    });
  }

  handleInput(data: string): void {
    // Ignore mouse selection / drag events (start with \x1b[M or contain mouse codes)
    // so that selecting text in the terminal doesn't send it as user input.
    if (data.startsWith("\x1b[M") || /\x1b\[[0-9;]*[Mm]/.test(data)) {
      return;
    }
    this.onInput(data);
  }

  invalidate(): void {
    // The frame is built from current application state on every render.
  }
}

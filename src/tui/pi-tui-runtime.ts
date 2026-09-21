import type { PiTuiFrameBuilder } from "./pi-tui-frame.ts";

type PiTuiComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
};

export type PiTuiTerminal = {
  readonly columns: number;
  readonly rows: number;
};

export type PiTuiController = {
  addChild(component: PiTuiComponent): void;
  setFocus(component: PiTuiComponent | null): void;
  start(): void;
  stop(): void;
  requestRender(force?: boolean): void;
};

export type PiTuiRuntime = {
  terminal: PiTuiTerminal;
  tui: PiTuiController;
};

/** Load pi-tui only when its runtime syntax is supported by the active Node. */
export async function createPiTuiRuntime(
  buildFrame: PiTuiFrameBuilder,
  onInput: (data: string) => void,
): Promise<PiTuiRuntime> {
  const [{ ProcessTerminal, TUI }, { PiTuiFrame }] = await Promise.all([
    import("@earendil-works/pi-tui"),
    import("./pi-tui-frame.ts"),
  ]);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const frame = new PiTuiFrame(terminal, buildFrame, onInput);
  tui.addChild(frame);
  tui.setFocus(frame);
  return { terminal, tui };
}

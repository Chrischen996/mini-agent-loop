import { useStdout } from "ink";
import { useEffect, useState } from "react";

export type TerminalSize = {
  columns: number;
  rows: number;
};

/**
 * Track the terminal size from Ink's stdout stream.
 *
 * Both the root `App` (dashboard layout) and the per-session view need the
 * same size, so the listener lives here instead of being duplicated in each
 * component. A missing stdout (tests, non-TTY) falls back to 80x24.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const syncTerminalSize = () => {
      const columns = stdout.columns || 80;
      const rows = stdout.rows || 24;
      setTerminalSize((current) =>
        current.columns === columns && current.rows === rows
          ? current
          : { columns, rows },
      );
    };
    stdout.on("resize", syncTerminalSize);
    syncTerminalSize();
    return () => {
      stdout.off("resize", syncTerminalSize);
    };
  }, [stdout]);

  return terminalSize;
}

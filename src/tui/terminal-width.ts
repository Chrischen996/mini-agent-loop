const ANSI_RE = /\u001B\[[0-?]*[ -\/]*[@-~]/g;

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfe0f ||
    codePoint === 0x200d
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function terminalStringWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) || isCombining(codePoint)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

export function countTerminalRows(value: string, columns: number): number {
  if (!value) return 0;
  const safeColumns = Math.max(1, columns);
  return value.split("\n").reduce((rows, line) => {
    return rows + Math.max(1, Math.ceil(terminalStringWidth(line) / safeColumns));
  }, 0);
}

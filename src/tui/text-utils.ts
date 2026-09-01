export type CompactTextOptions = {
  /** When true, max includes the ellipsis characters. */
  maxIncludesEllipsis?: boolean;
};

export function compactText(
  value: string,
  max: number,
  ellipsis = "...",
  options: CompactTextOptions = {},
): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const available = options.maxIncludesEllipsis
    ? Math.max(0, max - ellipsis.length)
    : max;
  return `${oneLine.slice(0, available)}${ellipsis}`;
}

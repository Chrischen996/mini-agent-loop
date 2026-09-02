export type CompactTextOptions = {
  /** When true, max includes the ellipsis characters. */
  maxIncludesEllipsis?: boolean;
};

/**
 * Keep the live streaming area bounded without discarding the final reply.
 * Completed messages are rendered in full; this helper is only for the
 * transient view while a model is still producing output.
 */
export function compactStreamingText(value: string, maxLines = 10): string {
  const lines = value.split("\n");
  const limit = Math.max(1, Math.floor(maxLines));
  if (lines.length <= limit) return value;
  const hidden = lines.length - limit;
  return [`… ${hidden} earlier lines`, ...lines.slice(-limit)].join("\n");
}

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

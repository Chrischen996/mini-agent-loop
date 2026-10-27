export type KittyScrollAction =
  | { type: "SCROLL_BY"; delta: number }
  | { type: "SCROLL_TO_BOTTOM" };

export function kittyScrollAction(input: string, feedHeight: number): KittyScrollAction | undefined {
  const kitty = /^\[(\d+)(?:;(\d+))?u$/.exec(input);
  if (!kitty) return undefined;

  const code = Number.parseInt(kitty[1]!, 10);
  const modifier = Math.max(0, Number.parseInt(kitty[2] ?? "1", 10) - 1);
  const ctrl = !!(modifier & 4);
  if (code === 9) return { type: "SCROLL_BY", delta: Math.max(1, feedHeight - 2) };
  if (code === 10) return { type: "SCROLL_BY", delta: -Math.max(1, feedHeight - 2) };
  if (ctrl && code === 12) return { type: "SCROLL_BY", delta: 1 };
  if (ctrl && code === 14) return { type: "SCROLL_BY", delta: -1 };
  if (ctrl && code === 103) return { type: "SCROLL_TO_BOTTOM" };
  return undefined;
}

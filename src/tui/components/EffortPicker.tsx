import React from "react";
import { Box, Text, useInput } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";

/**
 * Antigravity-style "Effort" slider.
 *
 * Layout mirrors the Antigravity CLI control:
 *   Effort   ◀ ════════●─────── ▶
 *   low                              high
 *        Deep reasoning for complex problems – slower but strongest
 *
 * The track fills up to the handle in the accent color, sits between tick
 * labels for the lowest and highest levels, and the human-readable
 * description of the selected level is centered beneath the track.
 * Left/Right (or h/l) move one level; Enter confirms; Esc cancels.
 */

const LEVEL_DESCRIPTIONS: Readonly<Record<ModelThinkingLevel, string>> = {
  off: "No reasoning – fastest responses for simple tasks",
  minimal: "A brief moment of reasoning – minimal latency overhead",
  low: "Light reasoning – quick answers with a little deliberation",
  medium: "Balanced reasoning – everyday coding tasks",
  high: "Deepest reasoning for complex problems – slower but strongest",
  xhigh: "Extra-deep reasoning – hardest multi-step problems",
  max: "Maximum reasoning effort the model exposes",
  ultra: "The deepest supported reasoning tier",
};

export type EffortPickerProps = {
  /** Ordered supported levels for the active model, lowest → highest. */
  levels: readonly ModelThinkingLevel[];
  /** Currently selected index into `levels` (pre-confirmation). */
  selectedIndex: number;
  /** Display labels per level (e.g. Off / Low / High). */
  labels: Readonly<Record<ModelThinkingLevel, string>>;
  width?: number;
  /** Called with the newly selected level when the user confirms. */
  onConfirm: (level: ModelThinkingLevel) => void;
  /** Called when the user dismisses without confirming. */
  onCancel: () => void;
  /** Called on every pre-confirmation selection change (live preview). */
  onPreview?: (level: ModelThinkingLevel) => void;
};

export function EffortPicker({
  levels,
  selectedIndex,
  labels,
  width = 64,
  onConfirm,
  onCancel,
  onPreview,
}: EffortPickerProps): React.ReactElement {
  const safeIndex = Math.min(Math.max(0, selectedIndex), levels.length - 1);
  const level = levels[safeIndex] ?? "medium";
  const accent = safeIndex === 0 ? C.muted : C.primary;

  const move = (delta: number) => {
    const nextIndex = Math.min(Math.max(0, safeIndex + delta), levels.length - 1);
    if (nextIndex !== safeIndex) onPreview?.(levels[nextIndex]!);
  };

  useInput((_ch: string, key) => {
    if (key.leftArrow || _ch === "h" || _ch === "H") {
      move(-1);
      return;
    }
    if (key.rightArrow || _ch === "l" || _ch === "L") {
      move(1);
      return;
    }
    if (key.return) {
      onConfirm(level);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  // Track is laid out by Ink's flexbox: a fixed "Effort" + arrow chrome on
  // each side, and a flexible middle segment split into filled/empty pieces.
  // We size the middle from the same fixed-chrome budget, with extra slack so
  // the single-line track never wraps onto a second row.
  const chromeBudget = 6 /*Effort*/ + 1 + 1 /*gap+◀*/ + 1 + 1 /*gap+▶*/ + 1;
  const innerWidth = Math.max(6, width - 2 /*border*/ - 4 /*padding*/ - chromeBudget - 3 /*slack*/);
  const filled = Math.round((safeIndex / Math.max(1, levels.length - 1)) * (innerWidth - 1));
  const empty = Math.max(0, innerWidth - 1 - filled);

  // Tick marks: one dot per level, the handle (●) sits on the active tick.
  const tickDots: string[] = [];
  for (let i = 0; i < levels.length; i++) {
    tickDots.push(i === safeIndex ? "●" : "·");
  }

  const lowestLabel = labels[levels[0] ?? "off"] ?? "low";
  const highestLabel = labels[levels.at(-1) ?? "high"] ?? "high";
  const currentLabel = labels[level] ?? level;
  const description = LEVEL_DESCRIPTIONS[level] ?? "";
  const hint = levels.length > 1
    ? "←/→ adjust · Enter apply · Esc cancel"
    : "This model exposes a single effort level · Enter apply · Esc cancel";

  return (
    <Box flexDirection="column" paddingX={2} borderStyle="round" borderColor={accent} width={width} minWidth={0} overflow="hidden">
      {/* Row 1 — title, left arrow, track, right arrow. */}
      <Box flexDirection="row" minWidth={0}>
        <Box flexShrink={0} marginRight={1}>
          <Text bold color={C.assistant}>Effort</Text>
        </Box>
        <Box flexShrink={0} marginRight={1}>
          <Text color={safeIndex > 0 ? accent : C.border}>◀</Text>
        </Box>
        <Box flexGrow={1} minWidth={0}>
          <Text>
            <Text color={accent}>{"━".repeat(filled)}</Text>
            <Text color={accent} bold>●</Text>
            <Text color={C.border}>{"─".repeat(empty)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={safeIndex < levels.length - 1 ? accent : C.border}>▶</Text>
        </Box>
      </Box>

      {/* Row 2 — tick dots, one per level, active one highlighted. */}
      <Box flexDirection="row" justifyContent="space-between" minWidth={0}>
        {tickDots.map((dot, i) => (
          <Text key={i} color={i === safeIndex ? accent : C.border}>{dot}</Text>
        ))}
      </Box>

      {/* Row 3 — lowest level label left, highest right. */}
      <Box flexDirection="row" justifyContent="space-between" minWidth={0}>
        <Text color={safeIndex === 0 ? accent : C.muted}>{lowestLabel}</Text>
        <Text color={safeIndex === levels.length - 1 ? accent : C.muted}>{highestLabel}</Text>
      </Box>

      {/* Row 4 — centered current level label in the accent color. */}
      {levels.length > 1 && (
        <Box flexDirection="row" justifyContent="center" minWidth={0}>
          <Text color={accent} bold>{currentLabel}</Text>
        </Box>
      )}

      {/* Row 5 — centered description; long text truncates gracefully. */}
      <Box flexDirection="row" justifyContent="center" minWidth={0}>
        <Text color={C.muted} wrap="truncate-end">{description}</Text>
      </Box>

      {/* Row 6 — centered key hints. */}
      <Box flexDirection="row" justifyContent="center" minWidth={0}>
        <Text color={C.border} wrap="truncate-end">{hint}</Text>
      </Box>
    </Box>
  );
}

/** Estimated frame rows the picker occupies (layout budgeting). */
export function effortPickerRows(): number {
  return 7;
}

/** Width helper for callers that need to size the overlay. */
export function effortPickerWidth(termWidth: number): number {
  return Math.max(44, Math.min(78, termWidth - 8));
}

import { Box, Text, useInput } from "ink";
import React, { useRef, useState } from "react";
import { GEMINI_BUILTIN_COLORS } from "../gemini-palettes.ts";
import { THEME_NAMES, TUI_COLORS as C, activeThemeName, applyTheme } from "../theme.ts";

/**
 * First-run / `/theme` theme picker, modeled on gemini-cli's ThemeDialog:
 * a radio list where highlighting previews the palette live across the whole
 * UI (our applyTheme mutates the shared palette singleton), Enter commits the
 * previewed theme, Escape reverts to the theme that was active on open.
 */
type ThemeDialogProps = {
  onSelect: (name: string) => void;
  onCancel: () => void;
};

const VISIBLE_ROWS = 10;

function themeKind(name: string): string {
  const builtin = GEMINI_BUILTIN_COLORS[name];
  if (builtin) return builtin.type === "light" ? "light" : builtin.type === "ansi" ? "ansi" : "dark";
  return "dark";
}

export function ThemeDialog({ onSelect, onCancel }: ThemeDialogProps): React.ReactElement {
  const start = Math.max(0, THEME_NAMES.indexOf(activeThemeName()));
  const [index, setIndex] = useState(start);
  const originalTheme = useRef(activeThemeName());

  const move = (delta: number) => {
    const next = (index + delta + THEME_NAMES.length) % THEME_NAMES.length;
    setIndex(next);
    applyTheme(THEME_NAMES[next]); // live preview, like gemini's onHighlight
  };

  useInput((_ch: string, key) => {
    if (key.upArrow || _ch === "k") {
      move(-1);
      return;
    }
    if (key.downArrow || _ch === "j" || _ch === " ") {
      move(1);
      return;
    }
    if (key.return) {
      onSelect(THEME_NAMES[index]);
      return;
    }
    if (key.escape) {
      applyTheme(originalTheme.current);
      onCancel();
    }
  });

  const windowStart = Math.max(0, Math.min(index - Math.floor(VISIBLE_ROWS / 2), THEME_NAMES.length - VISIBLE_ROWS));
  const visible = THEME_NAMES.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={C.primary}>Select a theme</Text>
      <Text color={C.muted}>↑↓ preview · enter apply · esc cancel · {index + 1}/{THEME_NAMES.length}</Text>
      <Box marginTop={1}>
        <Box flexDirection="column" width={28}>
          {visible.map((name, offset) => {
            const absolute = windowStart + offset;
            const selected = absolute === index;
            return (
              <Text key={name} color={selected ? C.user : C.muted} bold={selected} wrap="truncate-end">
                {selected ? "❯ " : "  "}{name}{selected ? `  (${themeKind(name)})` : ""}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" borderStyle="single" borderColor={C.border} paddingX={1}>
          <Text color={C.user} bold>{"❯ How do I sort a list in Python?"}</Text>
          <Text color={C.assistant}>
            {"Use "}
            <Text bold color={C.info}>sorted()</Text>
            {" — it returns a new list. For in-place ordering use "}
            <Text color={C.info}>.sort()</Text>
            .
          </Text>
          <Text color={C.thinking} italic>{"∴ considering comparison costs..."}</Text>
          <Text>
            <Text color={C.success}>✓ done</Text>
            {"  "}
            <Text color={C.running}>⟳ running</Text>
            {"  "}
            <Text color={C.error}>✗ failed</Text>
            {"  "}
            <Text color={C.muted}>⎿ muted metadata</Text>
          </Text>
        </Box>
      </Box>
      {windowStart > 0 ? <Text color={C.muted}>↑ {windowStart} more</Text> : null}
      {windowStart + VISIBLE_ROWS < THEME_NAMES.length ? <Text color={C.muted}>↓ {THEME_NAMES.length - windowStart - VISIBLE_ROWS} more</Text> : null}
    </Box>
  );
}
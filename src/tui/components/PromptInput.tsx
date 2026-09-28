import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { isSgrMouseEvent, parseSgrMouseWheel } from "../mouse-events.ts";
import { TUI_COLORS as C } from "../theme.ts";
import {
  clampCursor,
  moveToLineEnd,
  moveToLineStart,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  splitGraphemes,
} from "../input-editing.ts";
import type { TerminalInputHistory } from "../terminal-input-history.ts";

export function isPasteShortcut(input: string, key?: { ctrl?: boolean; meta?: boolean }): boolean {
  return Boolean((key?.ctrl || key?.meta) && (input === "v" || input === "V" || input === "\u0016"));
}

export const isImagePasteShortcut = isPasteShortcut;

export type PromptInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: (value: string) => void;
  onPasteImage?: () => unknown | Promise<unknown>;
  pasteEnabled?: boolean;
  focus?: boolean;
  mask?: string;
  placeholder?: string;
  attachments?: string[];
  /** Optional history instance for ↑/↓ history navigation in single-line mode */
  inputHistory?: TerminalInputHistory;
  /** Prevent prompt editing from consuming arrows owned by an overlay. */
  disableArrowNavigation?: boolean;
  /** Enable the migration's new word/Home/End editing behavior. */
  enhancedEditingEnabled?: boolean;
  /** Called when an empty single-line prompt has no history entry to navigate. */
  onScrollContext?: (direction: "up" | "down") => void;
};

const MAX_VISIBLE_LINES = 10;

function joinGraphemes(parts: string[]): string {
  return parts.join("");
}

function insertAt(parts: string[], cursor: number, text: string): { next: string; cursor: number } {
  const inserted = splitGraphemes(text);
  const nextParts = [...parts.slice(0, cursor), ...inserted, ...parts.slice(cursor)];
  return { next: joinGraphemes(nextParts), cursor: cursor + inserted.length };
}

function deleteBefore(parts: string[], cursor: number): { next: string; cursor: number } {
  if (cursor <= 0) return { next: joinGraphemes(parts), cursor };
  const nextParts = [...parts.slice(0, cursor - 1), ...parts.slice(cursor)];
  return { next: joinGraphemes(nextParts), cursor: cursor - 1 };
}

function renderInverse(text: string): React.ReactElement {
  return <Text inverse>{text || " "}</Text>;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onPasteImage,
  pasteEnabled = true,
  focus = true,
  mask,
  placeholder = "",
  attachments,
  inputHistory,
  disableArrowNavigation = false,
  enhancedEditingEnabled = false,
  onScrollContext,
}: PromptInputProps): React.ReactElement {
  const { internal_eventEmitter } = useStdin();
  const parts = useMemo(() => splitGraphemes(value), [value]);
  const [cursor, setCursor] = useState(() => parts.length);
  const cursorRef = useRef(cursor);
  const valueRef = useRef(value);
  const previousValueRef = useRef(value);
  const partsRef = useRef(parts);
  cursorRef.current = cursor;
  valueRef.current = value;
  partsRef.current = parts;

  useEffect(() => {
    const previousParts = splitGraphemes(previousValueRef.current);
    const nextCount = parts.length;
    setCursor((current) => {
      if (current >= previousParts.length) return nextCount;
      return clampCursor(current, nextCount);
    });
    previousValueRef.current = value;
  }, [value, parts.length]);

  const apply = (next: string, nextCursor: number) => {
    valueRef.current = next;
    cursorRef.current = nextCursor;
    partsRef.current = splitGraphemes(next);
    setCursor(nextCursor);
    if (next !== value) onChange(next);
  };

  useEffect(() => {
    const handleRawInput = (data: string) => {
      const direction = parseSgrMouseWheel(data);
      if (direction && onScrollContext) onScrollContext(direction);
    };
    internal_eventEmitter.on("input", handleRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleRawInput);
    };
  }, [internal_eventEmitter, onScrollContext]);

  useInput(
    (input, key) => {
      // Ink 5 does not expose wheel fields on Key. The raw listener above
      // handles SGR wheel events; keep the complete mouse sequence out of
      // the prompt value if Ink forwards it here as text.
      if (isSgrMouseEvent(input)) return;
      const currentParts = partsRef.current;
      const currentCursor = clampCursor(cursorRef.current, currentParts.length);

      if (key.tab && key.shift) {
        // Shift+Tab is handled by the global keyboard handler for permission mode cycling.
        // Return without consuming so the event propagates to the parent handler.
        return;
      }

      if (isPasteShortcut(input, key)) {
        if (pasteEnabled && onPasteImage) void onPasteImage();
        return;
      }

      if (key.tab) {
        onTab?.(valueRef.current);
        return;
      }

      if (key.return) {
        if (key.meta || key.ctrl) {
          const inserted = insertAt(currentParts, currentCursor, "\n");
          apply(inserted.next, inserted.cursor);
          return;
        }
        inputHistory?.resetNavigation();
        onSubmit(valueRef.current);
        return;
      }

      if (key.ctrl && (input === "j" || input === "J")) {
        const inserted = insertAt(currentParts, currentCursor, "\n");
        apply(inserted.next, inserted.cursor);
        return;
      }

      if (enhancedEditingEnabled && !disableArrowNavigation && key.ctrl && key.leftArrow) {
        setCursor(moveWordLeft(currentParts, currentCursor));
        return;
      }
      if (enhancedEditingEnabled && !disableArrowNavigation && key.ctrl && key.rightArrow) {
        setCursor(moveWordRight(currentParts, currentCursor));
        return;
      }

      // Leave other Ctrl/Meta chords to the app (thinking, scroll, exit).
      if (key.ctrl || key.meta) return;

      const navigationKey = key as typeof key & { home?: boolean; end?: boolean };
      if (enhancedEditingEnabled && navigationKey.home) {
        setCursor(moveToLineStart(currentParts, currentCursor));
        return;
      }
      if (enhancedEditingEnabled && navigationKey.end) {
        setCursor(moveToLineEnd(currentParts, currentCursor));
        return;
      }
      if (key.leftArrow) {
        setCursor(clampCursor(currentCursor - 1, currentParts.length));
        return;
      }
      if (key.rightArrow) {
        setCursor(clampCursor(currentCursor + 1, currentParts.length));
        return;
      }

      if (key.upArrow || key.downArrow) {
        // Modifier shortcuts and active overlays own vertical navigation.
        // Do not let prompt history or multiline editing consume arrows.
        if (disableArrowNavigation || key.shift) return;
        const isMultiLine = valueRef.current.includes("\n");
        if (isMultiLine) {
          // In multi-line mode: only use history navigation when cursor is
          // already at the very first character (can't go up further in text).
          const moved = moveVertical(currentParts, currentCursor, key.upArrow ? -1 : 1);
          if (moved.cursor !== currentCursor) {
            setCursor(moved.cursor);
            return;
          }
        }
        if (inputHistory) {
          const next = inputHistory.navigate(key.upArrow ? -1 : 1, valueRef.current);
          if (next !== undefined) {
            onChange(next);
            // Move cursor to end of the restored text
            setCursor(splitGraphemes(next).length);
            return;
          }
        }
        // An empty single-line prompt has no editing action left to consume.
        // Let the parent use the arrow for transcript/context navigation.
        if (!isMultiLine && valueRef.current === "") {
          onScrollContext?.(key.upArrow ? "up" : "down");
        }
        return;
      }

      // Ink reports terminal Backspace (\x7f) as `delete`. Treat both as
      // delete-before so CJK/emoji graphemes are removed in one stroke.
      if (key.backspace || key.delete || input === "\x7f") {
        const next = deleteBefore(currentParts, currentCursor);
        apply(next.next, next.cursor);
        return;
      }

      if (!input) return;
      if (input.length === 1 && input < " " && input !== "\t" && input !== "\n") return;

      const inserted = insertAt(currentParts, currentCursor, input);
      apply(inserted.next, inserted.cursor);
    },
    { isActive: focus },
  );

  const displayParts = mask
    ? currentMaskedParts(parts.length, mask)
    : parts;
  const safeCursor = clampCursor(cursor, displayParts.length);

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      {attachments && attachments.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap">
          {attachments.map((_, i) => (
            <Text key={`img-${i}`} color="cyan">[Image #{i + 1}] </Text>
          ))}
        </Box>
      )}
      <PromptLines
        parts={displayParts}
        cursor={safeCursor}
        focus={focus}
        placeholder={placeholder}
      />
    </Box>
  );
}

function currentMaskedParts(count: number, mask: string): string[] {
  const unit = mask || "*";
  return Array.from({ length: count }, () => unit);
}

function PromptLines({
  parts,
  cursor,
  focus,
  placeholder,
}: {
  parts: string[];
  cursor: number;
  focus: boolean;
  placeholder: string;
}): React.ReactElement {
  if (parts.length === 0) {
    if (!focus) return <Text dimColor>{placeholder}</Text>;
    if (!placeholder) return <Text>{renderInverse(" ")}</Text>;
    const placeholderParts = splitGraphemes(placeholder);
    return (
      <Text>
        <Text inverse>{placeholderParts[0] ?? " "}</Text>
        <Text dimColor>{placeholderParts.slice(1).join("")}</Text>
      </Text>
    );
  }

  const lines = splitDisplayLines(parts, cursor);
  // Keep the cursor in view when a multiline prompt grows beyond the fixed
  // input viewport. The old head-only slice made editing the later lines feel
  // broken because the active cell disappeared from the screen.
  const cursorLine = Math.max(0, lines.findIndex((line) =>
    line.cursorAtEnd || line.cells.some((cell) => cell.cursor),
  ));
  const start = Math.max(0, Math.min(cursorLine - MAX_VISIBLE_LINES + 1, lines.length - MAX_VISIBLE_LINES));
  const visible = lines.slice(start, start + MAX_VISIBLE_LINES);

  return (
    <Box flexDirection="column">
      {visible.map((line, index) => (
        <Text key={`${index}:${line.text}`}>
          {line.cells.map((cell, cellIndex) => (
            cell.cursor && focus
              ? <Text key={cellIndex} inverse>{cell.text || " "}</Text>
              : <Text key={cellIndex}>{cell.text}</Text>
          ))}
          {line.cursorAtEnd && focus ? renderInverse(" ") : null}
        </Text>
      ))}
    </Box>
  );
}

type DisplayCell = { text: string; cursor: boolean };
type DisplayLine = { text: string; cells: DisplayCell[]; cursorAtEnd: boolean };

function splitDisplayLines(parts: string[], cursor: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let cells: DisplayCell[] = [];
  let text = "";
  let cursorAtEnd = cursor === 0 && parts.length === 0;

  const flush = () => {
    lines.push({ text, cells, cursorAtEnd });
    cells = [];
    text = "";
    cursorAtEnd = false;
  };

  parts.forEach((part, index) => {
    if (part === "\n") {
      cursorAtEnd = cursor === index;
      flush();
      if (cursor === index + 1 && index === parts.length - 1) cursorAtEnd = true;
      return;
    }
    cells.push({ text: part, cursor: cursor === index });
    text += part;
    if (cursor === index + 1 && index === parts.length - 1) cursorAtEnd = true;
  });
  flush();
  if (lines.length === 0) lines.push({ text: "", cells: [], cursorAtEnd: cursor === 0 });
  return lines;
}

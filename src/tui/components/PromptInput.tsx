import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

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
};

const COLLAPSE_THRESHOLD = 3;
const MAX_VISIBLE_LINES = 10;

const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function splitGraphemes(value: string): string[] {
  if (!value) return [];
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

function joinGraphemes(parts: string[]): string {
  return parts.join("");
}

function clampCursor(index: number, count: number): number {
  return Math.max(0, Math.min(index, count));
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

function lineBounds(parts: string[], cursor: number): { start: number; end: number } {
  let start = cursor;
  while (start > 0 && parts[start - 1] !== "\n") start--;
  let end = cursor;
  while (end < parts.length && parts[end] !== "\n") end++;
  return { start, end };
}

function moveVertical(parts: string[], cursor: number, direction: -1 | 1): number {
  const { start, end } = lineBounds(parts, cursor);
  const column = cursor - start;
  if (direction < 0) {
    if (start === 0) return cursor;
    const prevEnd = start - 1;
    let prevStart = prevEnd;
    while (prevStart > 0 && parts[prevStart - 1] !== "\n") prevStart--;
    return Math.min(prevStart + column, prevEnd);
  }
  if (end >= parts.length) return cursor;
  const nextStart = end + 1;
  let nextEnd = nextStart;
  while (nextEnd < parts.length && parts[nextEnd] !== "\n") nextEnd++;
  return Math.min(nextStart + column, nextEnd);
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
}: PromptInputProps): React.ReactElement {
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

  useInput(
    (input, key) => {
      const currentParts = partsRef.current;
      const currentCursor = clampCursor(cursorRef.current, currentParts.length);

      if (key.tab && key.shift) return;

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
        onSubmit(valueRef.current);
        return;
      }

      if (key.ctrl && (input === "j" || input === "J")) {
        const inserted = insertAt(currentParts, currentCursor, "\n");
        apply(inserted.next, inserted.cursor);
        return;
      }

      // Leave other Ctrl/Meta chords to the app (thinking, scroll, exit).
      if (key.ctrl || key.meta) return;

      if (key.leftArrow) {
        setCursor(clampCursor(currentCursor - 1, currentParts.length));
        return;
      }
      if (key.rightArrow) {
        setCursor(clampCursor(currentCursor + 1, currentParts.length));
        return;
      }

      if (key.upArrow || key.downArrow) {
        if (!valueRef.current.includes("\n")) return;
        setCursor(moveVertical(currentParts, currentCursor, key.upArrow ? -1 : 1));
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
  const lineCount = value.split("\n").length;
  const collapsed = lineCount > COLLAPSE_THRESHOLD;
  const charCount = parts.length;
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
      {collapsed && (
        <Text color={C.muted}>[已折叠 {lineCount} 行 / {charCount} 字]</Text>
      )}
      <PromptLines
        parts={displayParts}
        cursor={safeCursor}
        focus={focus}
        placeholder={placeholder}
        collapsed={collapsed}
      />
      {collapsed && (
        <Text dimColor>Enter 提交 · Alt+Enter 换行</Text>
      )}
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
  collapsed,
}: {
  parts: string[];
  cursor: number;
  focus: boolean;
  placeholder: string;
  collapsed: boolean;
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
  const visible = collapsed ? lines.slice(-1) : lines.slice(0, MAX_VISIBLE_LINES);

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

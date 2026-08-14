import React, { useCallback, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

// ─── helpers ─────────────────────────────────────────────────────────────────

export function isImagePasteShortcut(input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && (input === "v" || input === "V" || input === "\u0016");
}

/** Number of visible lines before we auto-collapse into a summary. */
const COLLAPSE_THRESHOLD = 3;
const MAX_VISIBLE_LINES = 10;

function splitLines(text: string): string[] {
  return text === "" ? [""] : text.split("\n");
}

type PasteAwareTextInputProps = React.ComponentProps<typeof TextInput> & {
  onPasteImage: () => unknown | Promise<unknown>;
  pasteEnabled?: boolean;
};

export function PasteAwareTextInput({
  value,
  onChange,
  onPasteImage,
  pasteEnabled = true,
  focus = true,
  ...props
}: PasteAwareTextInputProps): React.ReactElement {
  const valueRef = useRef(value);
  valueRef.current = value;

  // Track multi-line state for display
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [collapsedSummary, setCollapsedSummary] = useState<string | undefined>();

  // Local editing state: when true, show ink-text-input for editing;
  // when false (and isMultiLine), show the collapsed summary card.
  const [isEditing, setIsEditing] = useState(false);

  // Update multi-line tracking when value changes
  React.useEffect(() => {
    const lineCount = value.split("\n").length;
    setIsMultiLine(lineCount > COLLAPSE_THRESHOLD);
    if (lineCount > COLLAPSE_THRESHOLD) {
      setCollapsedSummary(`${lineCount} 行 / ${[...value].length} 字`);
    } else {
      setCollapsedSummary(undefined);
      setIsEditing(false);
    }
  }, [value]);

  // Image paste shortcut — intercept before ink-text-input sees it
  useInput(
    (input, key) => {
      if (!isImagePasteShortcut(input, key)) return;
      const valueBeforePaste = valueRef.current;
      // ink-text-input receives this event too and treats Ctrl+V as the letter
      // "v". Restore the controlled value after all listeners have run.
      queueMicrotask(() => onChange(valueBeforePaste));
      void onPasteImage();
    },
    { isActive: pasteEnabled && focus },
  );

  // Handle arrow keys for editing mode on the summary card
  useInput(
    (input, key) => {
      if (!isMultiLine || isEditing) return;
      if (key.upArrow) {
        setIsEditing(true);
      }
    },
    { isActive: focus },
  );

  // Show collapsed summary for multi-line pastes (only when not in editing mode)
  if (isMultiLine && !isEditing) {
    return (
      <Box flexDirection="column">
        <Text color="white">[已复制 {collapsedSummary}]</Text>
        <Text dimColor>按 ↑ 展开编辑</Text>
      </Box>
    );
  }

  // For single-line or editing state, use ink-text-input
  return (
    <TextInput
      {...props}
      value={value}
      onChange={onChange}
      focus={true}
    />
  );
}

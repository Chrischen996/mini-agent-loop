import React from "react";
import { Box, Text } from "ink";
import { PromptInput } from "./PromptInput.tsx";
import type { TodoEditorState } from "../todo-editor.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { todoIcon } from "../todo-format.ts";
import { terminalStringWidth } from "../terminal-width.ts";
import { PICKER_SELECTED_MARKER, PICKER_UNSELECTED_MARKER, TODO_EDITOR_DRAFT_HINT, TODO_EDITOR_SELECT_HINT } from "../claude-style.ts";

/**
 * Interactive Todo overlay.
 *
 * Status glyphs, selection markers, and key hints come from shared presentation
 * modules. The selected row is amber-on-default like every other picker: it previously used
 * `C.selection`, which is a dark background blue and rendered almost
 * invisibly as foreground text.
 */
export function TodoEditor({ state, onCancel, onStateChange, onConfirm, width }: {
  state: TodoEditorState;
  onCancel: () => void;
  onStateChange: (value: string) => void;
  onConfirm: () => void;
  width?: number;
}): React.ReactElement {
  const rowWidth = width === undefined ? undefined : Math.max(1, width - 6);

  return (
    <Box flexDirection="column" paddingX={2} borderStyle="round" borderColor={C.primary} width={width} minWidth={0} overflow="hidden">
      <Text color={C.primary} bold>── Todo editor ──</Text>
      {state.todos.length === 0 && <Text dimColor>No todos yet — press a to add one.</Text>}
      {state.todos.map((todo, index) => {
        const selected = index === state.selectedIndex;
        const rowText = `${selected ? `${PICKER_SELECTED_MARKER} ` : `${PICKER_UNSELECTED_MARKER} `}${todoIcon(todo.status)} ${todo.content}`;
        const paddedRow = rowWidth === undefined
          ? rowText
          : `${rowText}${" ".repeat(Math.max(0, rowWidth - terminalStringWidth(rowText)))}`;
        return (
          <Text
            key={todo.id}
            color={selected ? C.assistant : C.muted}
            backgroundColor={selected ? C.selection : undefined}
            bold={selected}
            dimColor={!selected && todo.status === "completed"}
            strikethrough={todo.status === "completed"}
            wrap="truncate-end"
          >
            {paddedRow}
          </Text>
        );
      })}
      {state.mode !== "select" && (
        <PromptInput
          value={state.draft}
          onChange={onStateChange}
          onSubmit={onConfirm}
          onPasteImage={undefined}
          focus
        />
      )}
      {state.error && <Text color={C.error}>{state.error}</Text>}
      <Text dimColor wrap="truncate-end">{state.mode === "select" ? TODO_EDITOR_SELECT_HINT : TODO_EDITOR_DRAFT_HINT}</Text>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import { PromptInput } from "./PromptInput.tsx";
import type { TodoEditorState } from "../todo-editor.ts";
import { TUI_COLORS as C } from "../theme.ts";

function statusSymbol(status: TodoEditorState["todos"][number]["status"]): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "▶";
    case "failed": return "✗";
    case "skipped": return "-";
    default: return "○";
  }
}

export function TodoEditor({ state, onCancel, onStateChange, onConfirm }: {
  state: TodoEditorState;
  onCancel: () => void;
  onStateChange: (value: string) => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} borderStyle="round" borderColor={C.primary}>
      <Text color={C.primary} bold>── Todo editor ──</Text>
      {state.todos.length === 0 && <Text dimColor>No todos</Text>}
      {state.todos.map((todo, index) => (
        <Text key={todo.id} color={index === state.selectedIndex ? C.selection : undefined}>
          {index === state.selectedIndex ? "▶ " : "  "}{statusSymbol(todo.status)} {todo.id}: {todo.content}
        </Text>
      ))}
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
      <Text dimColor>Enter confirm  Esc close  ↑↓ move</Text>
      <Text dimColor>S status  A add  E edit  D delete</Text>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import { PromptInput } from "./PromptInput.tsx";
import type { TodoEditorState } from "../todo-editor.ts";
import { TUI_COLORS as C } from "../theme.ts";

function symbol(status: string): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "▶" : "○";
}

export function TodoEditor({ state, onCommit, onCancel, onStateChange, onConfirm }: {
  state: TodoEditorState;
  onCommit: (todos: TodoEditorState["todos"]) => void;
  onCancel: () => void;
  onStateChange: (value: string) => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} borderStyle="round" borderColor={C.primary}>
      <Text color={C.primary} bold>── Todo 编辑器 ──</Text>
      {state.todos.length === 0 && <Text dimColor>暂无 Todo</Text>}
      {state.todos.map((todo, index) => (
        <Text key={todo.id} color={index === state.selectedIndex ? C.selection : undefined}>
          {index === state.selectedIndex ? "▶ " : "  "}{symbol(todo.status)} {todo.id}: {todo.content}
        </Text>
      ))}
      {state.mode !== "select" && (
        <PromptInput
          value={state.draft}
          onChange={onStateChange}
          onSubmit={onConfirm}
          focus
        />
      )}
      {state.error && <Text color={C.error}>{state.error}</Text>}
      <Text dimColor>↑↓ 选择  s 状态  a 新增  e 编辑  d 删除  Enter 确认  Esc 取消</Text>
    </Box>
  );
}

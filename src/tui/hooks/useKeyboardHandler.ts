import { useInput, type Key } from "ink";
import { resolvePendingPermissionDecision } from "../pending-permission.ts";
import { nextPermissionMode, switchPermissionMode } from "../permission-utils.ts";
import { applyPermissionModePrompt } from "../../loop.ts";
import type { Dispatch } from "react";
import type { TuiAction } from "../state.ts";
import type { PermissionDecision, PermissionManager, PermissionTurnContext } from "../../permissions.ts";
import type { AcMode } from "../input-utils.ts";

export type TodoEditorKeyRoute =
  | "none"
  | "permission"
  | "open"
  | "close"
  | "prompt"
  | "move-up"
  | "move-down"
  | "add"
  | "edit"
  | "status"
  | "delete"
  | "confirm"
  | "thinking";

/** Resolve Todo editor keys before the normal prompt or autocomplete routes. */
export function routeTodoEditorKey(input: {
  editorOpen: boolean;
  mode: "select" | "add" | "edit";
  acMode: AcMode;
  busy: boolean;
  pendingPermission: boolean;
  ch: string;
  key: Key;
}): TodoEditorKeyRoute {
  const { editorOpen, mode, acMode, busy, pendingPermission, ch, key } = input;
  if (pendingPermission) return "permission";

  if (!editorOpen) {
    if (!acMode && !busy && key.ctrl && key.shift && (ch === "t" || ch === "T" || ch === "\u0014")) return "open";
    if (!acMode && !busy && key.ctrl && !key.shift && (ch === "t" || ch === "T" || ch === "\u0014")) return "thinking";
    return "none";
  }

  if (key.escape) return "close";
  if (mode !== "select") return "prompt";
  if (key.upArrow) return "move-up";
  if (key.downArrow) return "move-down";
  if (key.return) return "confirm";
  if (ch === "a" || ch === "A") return "add";
  if (ch === "e" || ch === "E") return "edit";
  // Both clients accept `space` and `s` so the shared hint is truthful.
  if (ch === "s" || ch === "S" || ch === " ") return "status";
  if (ch === "d" || ch === "D") return "delete";
  return "prompt";
}

export type UseKeyboardHandlerDeps = {
  exit: () => void;
  abortRef: React.MutableRefObject<AbortController>;
  copyResolvedText: (target?: import("../copy-text.ts").CopyTarget) => Promise<void>;
  pasteImage: () => Promise<boolean>;
  getPermissionManager: () => PermissionManager;
  historyRef: React.MutableRefObject<import("../../types.ts").AgentMessage[]>;
  adjustThinkingLevel: (direction: "increase" | "decrease", wrap?: boolean) => void;
  resolvePendingPermission: (decision: PermissionDecision) => boolean;
  dispatch: Dispatch<TuiAction>;
  acMode: AcMode;
  state: { busy: boolean; pendingPermission?: unknown; phase: string; currentPlan?: { id: string } };
  feedHeight: number;
  handleAutocompleteKey: (key: Key) => boolean;
  suppressInputEchoRef: React.MutableRefObject<boolean>;
  pendingPermissionRef: React.MutableRefObject<boolean>;
  todoEditorOpen: boolean;
  todoEditorMode: "select" | "add" | "edit";
  openTodoEditor: () => void;
  closeTodoEditor: () => void;
  todoEditorAction: (action: import("../todo-editor.ts").TodoEditorAction) => void;
  commitTodoEditor: () => void;
};

export function useKeyboardHandler(deps: UseKeyboardHandlerDeps): void {
  const {
    exit, abortRef, copyResolvedText, pasteImage, getPermissionManager, historyRef,
    adjustThinkingLevel, resolvePendingPermission, dispatch,
    acMode, state, feedHeight, handleAutocompleteKey,
    suppressInputEchoRef, pendingPermissionRef,
    todoEditorOpen, todoEditorMode, openTodoEditor, closeTodoEditor, todoEditorAction, commitTodoEditor,
  } = deps;

  useInput((_ch: string, key: Key) => {
    // Ctrl+C: abort and exit
    if (key.ctrl && (_ch === "c" || _ch === "C")) {
      abortRef.current.abort();
      exit();
      return;
    }

    // ESC: cancel current LLM generation
    if (key.escape && state.busy && !acMode) {
      abortRef.current.abort();
      abortRef.current = new AbortController();
      dispatch({ type: "CANCEL_GENERATION" });
      return;
    }

    // Ctrl+Y: copy resolved text
    if (!acMode && key.ctrl && (_ch === "y" || _ch === "Y" || _ch === "\u0019")) {
      suppressInputEchoRef.current = true;
      void copyResolvedText("auto");
      return;
    }

    // Ctrl+Shift+C: copy focused message to clipboard (iTerm2-compatible)
    if (!acMode && key.ctrl && key.shift && (_ch === "c" || _ch === "C" || _ch === "\u0003")) {
      suppressInputEchoRef.current = true;
      void copyResolvedText("auto");
      return;
    }

    // Ctrl+V: paste image from clipboard
    if (!acMode && key.ctrl && (_ch === "v" || _ch === "V" || _ch === "\u0016")) {
      suppressInputEchoRef.current = true;
      void pasteImage();
      return;
    }

    // Shift+Tab: cycle permission mode
    if (key.shift && key.tab) {
      suppressInputEchoRef.current = true;
      const permissionManager = getPermissionManager();
      const next = nextPermissionMode(permissionManager.getMode());
      switchPermissionMode(permissionManager, next);
      // Always sync React state so the StatusBar reflects the new mode.
      dispatch({ type: "SET_PERMISSION_MODE", mode: next });
      // Rewrite only the [MODE] suffix on the existing system prompt so the
      // conversation history (user/assistant/tool messages) is preserved.
      if (historyRef?.current && historyRef.current.length > 0) {
        applyPermissionModePrompt(historyRef.current, next);
      }
      return;
    }

    // Pending permission handling
    if (state.pendingPermission) {
      pendingPermissionRef.current = true;
      const decision = resolvePendingPermissionDecision(_ch, key);
      if (decision) {
        resolvePendingPermission(decision);
        return;
      }
      return;
    }
    pendingPermissionRef.current = false;

    const todoRoute = routeTodoEditorKey({
      editorOpen: todoEditorOpen,
      mode: todoEditorMode,
      acMode,
      busy: state.busy,
      pendingPermission: false,
      ch: _ch,
      key,
    });
    switch (todoRoute) {
      case "close":
        closeTodoEditor();
        return;
      case "open":
        suppressInputEchoRef.current = true;
        openTodoEditor();
        return;
      case "move-up":
        todoEditorAction({ type: "MOVE", delta: -1 });
        return;
      case "move-down":
        todoEditorAction({ type: "MOVE", delta: 1 });
        return;
      case "add":
        todoEditorAction({ type: "BEGIN_ADD" });
        return;
      case "edit":
        todoEditorAction({ type: "BEGIN_EDIT" });
        return;
      case "status":
        todoEditorAction({ type: "CYCLE_STATUS" });
        return;
      case "delete":
        todoEditorAction({ type: "DELETE" });
        return;
      case "confirm":
        commitTodoEditor();
        return;
      case "prompt":
        if (todoEditorOpen) return;
        break;
      case "thinking":
        suppressInputEchoRef.current = true;
        dispatch({ type: "TOGGLE_THINKING_MODE" });
        return;
    }

    // Plan approval shortcuts
    if (!acMode && !state.busy && state.phase === "review" && state.currentPlan) {
      if (_ch === "a" || _ch === "A") {
        suppressInputEchoRef.current = true;
        dispatch({ type: "APPROVE_PLAN", planId: state.currentPlan.id });
        return;
      }
      if (_ch === "r" || _ch === "R") {
        suppressInputEchoRef.current = true;
        dispatch({ type: "REJECT_PLAN", planId: state.currentPlan.id });
        return;
      }
    }

    // Codex-compatible effort shortcuts
    if (!acMode && !state.busy) {
      if (key.shift && key.upArrow) {
        suppressInputEchoRef.current = true;
        adjustThinkingLevel("increase");
        return;
      }
      if (key.shift && key.downArrow) {
        suppressInputEchoRef.current = true;
        adjustThinkingLevel("decrease");
        return;
      }
      if (key.meta && (_ch === "." || _ch === ",") && !key.ctrl) {
        suppressInputEchoRef.current = true;
        adjustThinkingLevel(_ch === "." ? "increase" : "decrease");
        return;
      }
      if (key.ctrl && (_ch === "r" || _ch === "R" || _ch === "\u0012")) {
        suppressInputEchoRef.current = true;
        adjustThinkingLevel("increase", true);
        return;
      }
    }

    // Ctrl+T: cycle thinking mode
    if (key.ctrl && !key.shift && (_ch === "t" || _ch === "T" || _ch === "\u0014")) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_THINKING_MODE" });
      return;
    }

    // Alt+T: toggle message thinking
    if (key.meta && (_ch === "t" || _ch === "T") && !key.ctrl) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_MESSAGE_THINKING" });
      return;
    }

    // Alt+↑/↓: move focus among reasoning messages
    if (!acMode && key.meta && key.upArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: -1 });
      return;
    }
    if (!acMode && key.meta && key.downArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: 1 });
      return;
    }

    // Scrolling
    if (!acMode) {
      if (key.pageUp) {
        dispatch({ type: "SCROLL_BY", delta: Math.max(1, feedHeight - 2) });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: "SCROLL_BY", delta: -Math.max(1, feedHeight - 2) });
        return;
      }
      if (key.ctrl && key.upArrow) {
        dispatch({ type: "SCROLL_BY", delta: 1 });
        return;
      }
      if (key.ctrl && key.downArrow) {
        dispatch({ type: "SCROLL_BY", delta: -1 });
        return;
      }
      if (key.ctrl && (_ch === "g" || _ch === "G")) {
        suppressInputEchoRef.current = true;
        dispatch({ type: "SCROLL_TO_BOTTOM" });
        return;
      }
    }

    if (handleAutocompleteKey(key)) return;
  });
}

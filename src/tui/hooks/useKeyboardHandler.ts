import { useInput, type Key } from "ink";
import { resolvePendingPermissionDecision } from "../pending-permission.ts";
import { nextPermissionMode, switchPermissionMode } from "../permission-utils.ts";
import { buildSystemPrompt, createAgentHistory } from "../../loop.ts";
import type { Dispatch } from "react";
import type { TuiAction } from "../state.ts";
import type { PermissionDecision, PermissionManager, PermissionTurnContext } from "../../permissions.ts";

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
  acMode: string | null;
  state: { busy: boolean; pendingPermission?: unknown; phase: string; currentPlan?: { id: string } };
  feedHeight: number;
  handleAutocompleteKey: (key: Key) => boolean;
  suppressInputEchoRef: React.MutableRefObject<boolean>;
  pendingPermissionRef: React.MutableRefObject<boolean>;
  /** Background live-panel open/close; Esc closes the panel before other work. */
  bgPanelOpen?: boolean;
  onCloseBgPanel?: () => void;
};

export function useKeyboardHandler(deps: UseKeyboardHandlerDeps): void {
  const {
    exit, abortRef, copyResolvedText, pasteImage, getPermissionManager, historyRef,
    adjustThinkingLevel, resolvePendingPermission, dispatch,
    acMode, state, feedHeight, handleAutocompleteKey,
    suppressInputEchoRef, pendingPermissionRef, bgPanelOpen, onCloseBgPanel,
  } = deps;

  useInput((_ch: string, key: Key) => {
    // Ctrl+C: abort and exit
    if (key.ctrl && (_ch === "c" || _ch === "C")) {
      abortRef.current.abort();
      exit();
      return;
    }

    // ESC: close the background live panel (it disables the prompt input)
    if (key.escape && bgPanelOpen) {
      onCloseBgPanel?.();
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
      if (historyRef?.current && historyRef.current.length > 0) {
        const newPrompt = buildSystemPrompt(next);
        historyRef.current = createAgentHistory(newPrompt, next);
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
    if (key.ctrl && (_ch === "t" || _ch === "T" || _ch === "\u0014")) {
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
      // Kitty keyboard protocol terminals report function/modified keys as
      // `ESC [ <keycode>[;<mods>]u` (Ink delivers them ESC-stripped). Map the
      // scroll keys so PgUp/PgDn, Ctrl+Up/Down and Ctrl+G keep working there.
      // Kitty keycodes: Page up = 9, Page down = 10, Up = 12, Down = 14, 'g' = 103;
      // mods: shift = 1, ctrl = 4.
      const kitty = /^\[(\d+)(?:;(\d+))?u$/.exec(_ch);
      if (kitty) {
        const code = Number.parseInt(kitty[1]!, 10);
        const ctrl = !!(Number.parseInt(kitty[2] ?? "1", 10) & 4);
        if (code === 9) {
          dispatch({ type: "SCROLL_BY", delta: Math.max(1, feedHeight - 2) });
          return;
        }
        if (code === 10) {
          dispatch({ type: "SCROLL_BY", delta: -Math.max(1, feedHeight - 2) });
          return;
        }
        if (ctrl && code === 12) {
          dispatch({ type: "SCROLL_BY", delta: 1 });
          return;
        }
        if (ctrl && code === 14) {
          dispatch({ type: "SCROLL_BY", delta: -1 });
          return;
        }
        if (ctrl && code === 103) {
          suppressInputEchoRef.current = true;
          dispatch({ type: "SCROLL_TO_BOTTOM" });
          return;
        }
      }
    }

    if (handleAutocompleteKey(key)) return;
  });
}

import { useInput, type Key } from "ink";
import { useCallback } from "react";
import { resolvePendingPermissionDecision } from "../pending-permission.ts";
import { nextPermissionMode, switchPermissionMode } from "../permission-utils.ts";
import { buildSystemPrompt, createAgentHistory } from "../../loop.ts";
import type { Dispatch } from "react";
import type { TuiAction } from "../state.ts";
import type { PermissionDecision, PermissionManager, PermissionTurnContext } from "../../permissions.ts";
import type { AcMode } from "../input-utils.ts";

export type UseKeyboardHandlerDeps = {
  exit: () => void;
  abortRef: React.MutableRefObject<AbortController>;
  copyResolvedText: (target?: import("../copy-text.ts").CopyTarget) => Promise<void>;
  getPermissionManager: () => PermissionManager;
  historyRef: React.MutableRefObject<import("../../types.ts").AgentMessage[]>;
  adjustThinkingLevel: (direction: "increase" | "decrease", wrap?: boolean) => void;
  resolvePendingPermission: (decision: PermissionDecision) => boolean;
  dispatch: Dispatch<TuiAction>;
  acMode: AcMode;
  setAcMode: (mode: AcMode) => void;
  state: { busy: boolean; pendingPermission?: unknown; phase: string; currentPlan?: { id: string } };
  feedHeight: number;
  handleAutocompleteKey: (key: Key) => boolean;
  suppressInputEchoRef: React.MutableRefObject<boolean>;
  pendingPermissionRef: React.MutableRefObject<boolean>;
};

export function useKeyboardHandler(deps: UseKeyboardHandlerDeps): void {
  const {
    exit, abortRef, copyResolvedText, getPermissionManager, historyRef,
    adjustThinkingLevel, resolvePendingPermission, dispatch,
    acMode, setAcMode, state, feedHeight, handleAutocompleteKey,
    suppressInputEchoRef, pendingPermissionRef,
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

    // Shift+Tab: cycle permission mode (works even during autocomplete)
    if (key.shift && key.tab) {
      suppressInputEchoRef.current = true;
      const permissionManager = getPermissionManager();
      const next = nextPermissionMode(permissionManager.getMode());
      if (switchPermissionMode(permissionManager, next)) {
        dispatch({ type: "SET_PERMISSION_MODE", mode: next });
      }
      if (historyRef.current.length > 0) {
        const newPrompt = buildSystemPrompt(next);
        historyRef.current = createAgentHistory(newPrompt, next);
      }
      setAcMode(null);
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
    }

    if (handleAutocompleteKey(key)) return;
  });
}

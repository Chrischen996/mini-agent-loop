// Layout metrics for the Ink session view.
//
// Every vertical budget in the TUI (feed height, picker height, prompt rows)
// has to agree, otherwise the frame overflows and Ink clears the screen. This
// hook computes them from one set of inputs so a new panel only has to be
// added in one place.

import { useMemo } from "react";
import type { TuiState } from "../state.ts";
import type { AcMode } from "../input-utils.ts";
import type { ModelSetupState, ProfileListState } from "../types.ts";
import type { ModelPickerSection } from "../model-picker.ts";
import { getMessageFeedHeight, getPickerLayout } from "../layout.ts";
import { getWelcomeHeaderHeight } from "../welcome-panel.ts";
import { getTodoPanelRows } from "../todo-format.ts";
import { terminalStringWidth } from "../terminal-width.ts";
import { estimatePromptInputRows } from "../components/PromptInput.tsx";

export type SessionLayoutInput = {
  state: TuiState;
  acMode: AcMode;
  modelSetup: ModelSetupState | undefined;
  modelPickerSection: ModelPickerSection;
  cmdCandidateCount: number;
  fileCandidateCount: number;
  modelCandidateCount: number;
  configuredModelCandidateCount: number;
  profileListState: ProfileListState | null;
  input: string;
  /** Pending `/tasks run` confirmation panel, when the user must decide. */
  pendingTodoRunPlan: boolean;
  queuedCount: number;
  foregroundCommandWaiting: boolean;
  sendableWaitWaiting: boolean;
  termWidth: number;
  termRows: number;
  /** Document layout renders no Header component. */
  isDocumentLayout: boolean;
  hasInputBorder: boolean;
};

export type SessionLayout = {
  showWelcome: boolean;
  promptPlaceholder: string;
  promptWidth: number;
  promptRows: number;
  todoRows: number;
  permissionRows: number;
  planApprovalRows: number;
  pickerLayout: ReturnType<typeof getPickerLayout>;
  feedHeight: number;
};

/**
 * Placeholder text for the prompt row. Busy and picker states take precedence
 * over the idle hint because they explain what Enter will do right now.
 */
function resolvePromptPlaceholder(input: Pick<SessionLayoutInput,
  "state" | "acMode" | "modelSetup" | "queuedCount" | "foregroundCommandWaiting" | "sendableWaitWaiting"
>): string {
  const { state, acMode, modelSetup, queuedCount, foregroundCommandWaiting, sendableWaitWaiting } = input;
  if (state.busy && queuedCount > 0) return "Working; Enter sends the next queued message";
  if (state.busy && (foregroundCommandWaiting || sendableWaitWaiting)) return "Waiting; Enter sends now · Ctrl+Enter interrupts";
  if (state.busy) return "Working; Enter queues · Ctrl+Enter sends now";
  if (acMode === "model-picker") return "Search models";
  if (acMode === "model-setup" && modelSetup?.field === "baseUrl") return "Enter Base URL";
  if (acMode === "model-setup" && modelSetup?.field === "deleteConfirm") return "y to delete this model, n to cancel";
  if (acMode === "model-setup") return "Enter API key (or leave blank to use an environment variable)";
  if (acMode === "profile-name") return "Enter a profile name (for example coding-fast)";
  if (acMode === "profile-list") return "↑↓ select profile, Enter activate";
  return "Message, /command, or @file reference";
}

/** Rows the open picker wants, capped per mode so it never eats the feed. */
function resolveRequestedPickerItems(input: Pick<SessionLayoutInput,
  "acMode" | "cmdCandidateCount" | "fileCandidateCount" | "modelCandidateCount"
  | "configuredModelCandidateCount" | "modelPickerSection" | "profileListState"
>): number {
  const { acMode, cmdCandidateCount, fileCandidateCount, modelCandidateCount, configuredModelCandidateCount, modelPickerSection, profileListState } = input;
  if (acMode === "command") return Math.min(6, cmdCandidateCount);
  if (acMode === "file") return Math.min(8, fileCandidateCount);
  if (acMode === "model" || acMode === "model-picker") {
    return Math.min(12, modelPickerSection === "configured" ? configuredModelCandidateCount : modelCandidateCount);
  }
  if (acMode === "profile-list") return Math.min(10, profileListState?.profiles.length ?? 0);
  return acMode ? 4 : 0;
}

export function useSessionLayout(input: SessionLayoutInput): SessionLayout {
  const {
    state,
    acMode,
    input: promptInput,
    pendingTodoRunPlan,
    queuedCount,
    foregroundCommandWaiting,
    sendableWaitWaiting,
    modelSetup,
    modelPickerSection,
    cmdCandidateCount,
    fileCandidateCount,
    modelCandidateCount,
    configuredModelCandidateCount,
    profileListState,
    termWidth,
    termRows,
    isDocumentLayout,
    hasInputBorder,
  } = input;

  return useMemo(() => {
    // While a picker overlay is open the welcome panel yields its rows so the
    // picker, prompt, and status chrome all stay visible.
    const showWelcome = state.messages.length === 0 && !state.busy && !state.pendingPermission && !acMode;
    const promptPlaceholder = resolvePromptPlaceholder({
      state, acMode, modelSetup, queuedCount, foregroundCommandWaiting, sendableWaitWaiting,
    });
    const promptWidth = Math.max(
      1,
      termWidth - 4 - (hasInputBorder ? 2 : 0)
        - (state.busy && queuedCount > 0 ? terminalStringWidth(`Queue ${queuedCount}`) : 0),
    );
    const promptRows = estimatePromptInputRows(promptInput, promptWidth, promptPlaceholder);
    const todoRows = getTodoPanelRows(
      { plan: state.todoPlan, todos: state.todoItems },
      state.todoViewMode,
    );
    // Approval chrome: the permission card / plan approval bar render between
    // the feed and the input row; reserve their rows in every height budget.
    const permissionRows = (state.pendingPermission ? 4 : 0) + (pendingTodoRunPlan ? 5 : 0);
    const planApprovalRows = state.phase === "review" && state.currentPlan ? 3 : 0;
    const headerRows = showWelcome ? getWelcomeHeaderHeight(termWidth, true) : undefined;
    const pickerLayout = getPickerLayout({
      termRows,
      requestedItems: resolveRequestedPickerItems({
        acMode, cmdCandidateCount, fileCandidateCount, modelCandidateCount,
        configuredModelCandidateCount, modelPickerSection, profileListState,
      }),
      inputRows: promptRows,
      hasHeader: !isDocumentLayout,
      ...(headerRows !== undefined ? { headerRows } : {}),
      hasPendingImages: state.pendingImages.length > 0,
      todoRows,
      extraRows: acMode === "model-picker" ? 4 : acMode === "model" || acMode === "file" ? 3 : 2,
      permissionRows,
      planApprovalRows,
      hasInputBorder,
    });
    const feedHeight = getMessageFeedHeight({
      termRows,
      inputRows: promptRows,
      hasHeader: !isDocumentLayout,
      ...(headerRows !== undefined ? { headerRows } : {}),
      hasPendingImages: state.pendingImages.length > 0,
      todoRows,
      pickerRows: pickerLayout.totalRows,
      permissionRows,
      planApprovalRows,
      hasInputBorder,
    });

    return {
      showWelcome,
      promptPlaceholder,
      promptWidth,
      promptRows,
      todoRows,
      permissionRows,
      planApprovalRows,
      pickerLayout,
      feedHeight,
    };
    // Primitive deps only: `input` is rebuilt on every parent render, so
    // depending on the object would defeat the memo.
  }, [
    state,
    acMode,
    modelSetup,
    modelPickerSection,
    cmdCandidateCount,
    fileCandidateCount,
    modelCandidateCount,
    configuredModelCandidateCount,
    profileListState,
    promptInput,
    pendingTodoRunPlan,
    queuedCount,
    foregroundCommandWaiting,
    sendableWaitWaiting,
    termWidth,
    termRows,
    isDocumentLayout,
    hasInputBorder,
  ]);
}

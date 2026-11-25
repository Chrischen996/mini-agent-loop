// Slash-command dispatch for the Ink session view.
//
// `handleSubmit` used to inline this cascade. The routing logic now lives in
// command-domains.ts (one handler per command family); this file keeps the
// public surface — `CommandCascadeContext`, `CascadeResult`, `HANDLED` — and
// the dispatcher that preserves the original family ordering.
//
// Contract: return `HANDLED` when the input was fully consumed by a local
// command. Returning `undefined` means "not a command" — the caller continues
// with a normal agent turn.

import type { LlmConfig, ModelSwitchOverrides } from "../../llm/index.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import type { Tool, ToolProvider } from "../../tools/types.ts";
import type { AgentMessage } from "../../types.ts";
import type { McpServerStatus } from "../../mcp/types.ts";
import type { BgTaskManager } from "../../bg-tasks/manager.js";
import type { PermissionManager } from "../../permissions.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { Dispatch, MutableRefObject } from "react";
import type { ImageAttachment, TuiAction, TuiState } from "../state.ts";
import type { AcMode } from "../input-utils.ts";
import type { ModelPickerSection } from "../model-picker.ts";
import type { SlashCommand } from "../slash-commands.ts";
import type { CopyTarget } from "../copy-text.ts";
import type { ModelSelectOptions } from "../model-switcher.ts";
import type { PlanOverrideResult } from "../plan-commands.ts";
import type { TuiSystemPromptContext } from "../system-prompt.ts";
import type { ThinkingMode } from "../../thinking-policy.ts";
import {
  handleBackgroundCommands,
  handleLocalCommands,
  handlePlanAndModelCommands,
  handleSessionCommands,
  handleWorkspaceCommands,
} from "./command-domains.ts";

/** The input was consumed locally; no agent turn should run. */
export type CascadeResult =
  | { handled: true }
  | { handled: false; planTurnOverride: PlanOverrideResult | null | undefined };

/** Sentinel returned when a local command consumed the input. */
export const HANDLED: CascadeResult = { handled: true };

export type CommandCascadeContext = {
  cwd: string;
  state: TuiState;
  dispatch: Dispatch<TuiAction>;
  setInput: (value: string) => void;
  llm: LlmConfig;
  llmRef: MutableRefObject<LlmConfig>;
  historyRef: MutableRefObject<AgentMessage[]>;
  activeTodosRef: MutableRefObject<TuiState["todoItems"]>;
  localRoleLlmConfigsRef: MutableRefObject<Record<string, LlmConfig>>;
  pendingImagesRef: MutableRefObject<ImageAttachment[]>;
  skillNamesRef: MutableRefObject<string[]>;
  thinkingPolicyModeRef: MutableRefObject<ThinkingMode>;
  sessionProvenanceRef: MutableRefObject<Record<string, unknown>>;
  planCaptureRef: MutableRefObject<{ prompt: string } | null>;
  execCaptureRef: MutableRefObject<{ mode: "run" | "retry" } | null>;
  diffFilesRef: MutableRefObject<string[]>;
  resizeRefreshRef: MutableRefObject<number>;
  sessionManagerRef: MutableRefObject<SessionManager | null>;
  acModeRef: MutableRefObject<AcMode>;
  modelPickerSectionRef: MutableRefObject<ModelPickerSection>;
  allToolsRef: MutableRefObject<ToolProvider>;
  mcpStatuses?: () => readonly McpServerStatus[];
  mcpTools?: () => readonly Tool[];
  modelContextWindows: Record<string, number>;
  systemPromptContext: TuiSystemPromptContext;
  getBgManager: () => BgTaskManager | null;
  getPermissionManager: () => PermissionManager;
  getSessionManager: () => SessionManager;
  refreshBgTaskCount: () => Promise<void>;
  persistSessionSnapshot: (messages: AgentMessage[], modelConfig?: LlmConfig) => Promise<void>;
  resumeSession: (prefix: string) => Promise<boolean>;
  importForeign: (source: "claude" | "codex", reference: string) => Promise<void>;
  copyResolvedText: (target?: CopyTarget) => Promise<void>;
  addPendingImageRef: (image: ImageAttachment) => boolean;
  handlePasteImageRef: () => Promise<boolean>;
  runDirectToolRef: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  runTodosCommand: (input: string, parsed: SlashCommand, confirmed?: boolean) => Promise<void>;
  selectModelRef: (reference: string, overrides?: ModelSwitchOverrides, options?: ModelSelectOptions) => void;
  openProfileListRef: (profileNames?: string[]) => Promise<unknown>;
  openModelPicker: (query?: string) => void;
  openEffortPicker: () => void;
  handleEffortConfirm: (level: ModelThinkingLevel) => void;
  setSkillNames: (names: string[]) => void;
  setConversationId: (id: string) => void;
  setAcMode: (mode: AcMode) => void;
  setAcIndex: (index: number) => void;
  setBgPanelOpen: (open: boolean) => void;
  setTasksPaneOpen: (open: boolean) => void;
  setThemeDialogOpen: (open: boolean) => void;
  setDiffFileCandidates: (files: string[]) => void;
  exit: () => void;
};

/**
 * Run the local slash-command cascade for `trimmed`.
 *
 * The cascade used to be one ~500-line `if` chain in this function; it is now
 * dispatched through the domain handlers in command-domains.ts, in exactly the
 * original order (session -> background -> local -> plan/model -> workspace).
 * Each handler returns `undefined` for "not mine", so the sequence below is a
 * faithful reproduction of the inline early-return chain.
 *
 * Returns `HANDLED` when a command consumed the input. Returns a plan-turn
 * override when the input must run as an agent turn (see `parsePlanTurnOverride`),
 * and `undefined` when the input is an ordinary prompt.
 */
export async function runCommandCascade(
  ctx: CommandCascadeContext,
  trimmed: string,
): Promise<CascadeResult> {
  const session = await handleSessionCommands(ctx, trimmed);
  if (session) return session;

  const background = await handleBackgroundCommands(ctx, trimmed);
  if (background) return background;

  const local = await handleLocalCommands(ctx, trimmed);
  if (local) return local;

  // The plan/model family either consumes the input or produces a plan-turn
  // override that the workspace family's unknown-command guard must respect
  // (a `/plan ...` prompt must not be rejected as a typo).
  const planModel = await handlePlanAndModelCommands(ctx, trimmed);
  if (planModel.handled) return planModel.handled;

  const workspace = await handleWorkspaceCommands(ctx, trimmed, planModel.planTurnOverride);
  if (workspace) return workspace;

  return { handled: false, planTurnOverride: planModel.planTurnOverride };
}

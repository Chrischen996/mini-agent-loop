import type { ChatMessage, PendingPermissionState } from "./state.ts";
import { statusLabel } from "./claude-style.ts";
import { toolVisualName } from "./tool-lines.ts";

export const LOADING_GLYPHS = ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"] as const;
export const LOADING_FRAME_MS = 120;
export const STREAM_STALL_NOTICE_MS = 5_000;
export const STREAM_STALL_WARNING_MS = 15_000;

export type ActivityPhase =
  | "requesting"
  | "thinking"
  | "responding"
  | "tool"
  | "retrying"
  | "permission"
  | "continuing"
  | "working";

export type ActivityPresentation = {
  phase: ActivityPhase;
  label: string;
  details: string[];
  stalled: boolean;
};

export type ActivityState = {
  busy: boolean;
  status: string;
  streamingText: string;
  streamingReasoning: string;
  messages: ChatMessage[];
  pendingPermission?: PendingPermissionState;
  turnStartedAt?: number;
  lastStreamAt?: number;
};

export type ActivityOptions = {
  now?: number;
  queuedCount?: number;
};

/** Fixed-width, terminal-safe animation used by both TUI renderers. */
export function loadingGlyph(now: number, startedAt = now): string {
  const elapsed = Math.max(0, now - startedAt);
  return LOADING_GLYPHS[Math.floor(elapsed / LOADING_FRAME_MS) % LOADING_GLYPHS.length]!;
}

/** Derive one coherent live status from reducer state without changing loop behavior. */
export function activityPresentation(
  state: ActivityState,
  options: ActivityOptions = {},
): ActivityPresentation | undefined {
  if (!state.busy && !state.pendingPermission) return undefined;

  const now = options.now ?? Date.now();
  const startedAt = state.turnStartedAt ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const streamLength = state.streamingReasoning.length + state.streamingText.length;
  const lastProgressAt = state.lastStreamAt ?? startedAt;
  const stalledForMs = streamLength > 0 ? Math.max(0, now - lastProgressAt) : 0;
  const stalled = stalledForMs >= STREAM_STALL_NOTICE_MS;
  let runningTool: Extract<ChatMessage, { kind: "tool_call" }> | undefined;
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message?.kind === "tool_call" && message.status === "running") {
      runningTool = message;
      break;
    }
  }

  let phase: ActivityPhase;
  let label: string;
  if (state.pendingPermission) {
    phase = "permission";
    label = `Waiting for permission · ${toolVisualName(state.pendingPermission.tool)}`;
  } else if (/重试|retry|连接中断|超时/i.test(state.status)) {
    phase = "retrying";
    label = "Retrying model request…";
  } else if (runningTool) {
    phase = "tool";
    label = `Running ${toolVisualName(runningTool.name)}…`;
  } else if (state.streamingText) {
    phase = "responding";
    label = stalled ? "Waiting for response tokens…" : "Responding…";
  } else if (state.streamingReasoning) {
    phase = "thinking";
    label = stalled ? "Waiting for reasoning tokens…" : "Thinking…";
  } else if (/自动续跑|续跑|continu/i.test(state.status)) {
    phase = "continuing";
    label = "Continuing…";
  } else if (/整理回复|finaliz/i.test(state.status)) {
    phase = "working";
    label = "Finalizing response…";
  } else {
    const visibleStatus = statusLabel(state.status, true);
    if (visibleStatus === "Delegating…" || visibleStatus === "Updating todos…") {
      phase = "working";
      label = visibleStatus;
    } else {
      phase = "requesting";
      label = elapsedMs >= STREAM_STALL_NOTICE_MS ? "Still waiting for model…" : "Waiting for model…";
    }
  }

  const details: string[] = [];
  if (elapsedMs >= 1_000) details.push(formatElapsed(elapsedMs));
  if (streamLength > 0) details.push(`~${estimateVisibleTokens(`${state.streamingReasoning}${state.streamingText}`)} tokens`);
  if ((options.queuedCount ?? 0) > 0) details.push(`${options.queuedCount} queued`);
  return { phase, label, details, stalled: stalledForMs >= STREAM_STALL_WARNING_MS };
}

export function formatActivity(presentation: ActivityPresentation): string {
  return [presentation.label, ...presentation.details].join(" · ");
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function estimateVisibleTokens(value: string): number {
  // This is intentionally a cheap display estimate. Provider usage remains
  // authoritative once the assistant event arrives.
  return Math.max(1, Math.ceil(value.length / 4));
}

import type { PermissionMode } from "../permissions.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import type { LlmConfig } from "../llm/config.ts";
import { getThinkingLevelChoices } from "../think-intensity.ts";
import { permissionModeLabel, statusLabel, thinkingLevelLabel } from "./claude-style.ts";
import { TUI_COLORS as C } from "./theme.ts";
import { terminalStringWidth, truncateTerminalPath } from "./terminal-width.ts";

/**
 * One shared description of the stable status chrome.
 *
 * The Ink client and the standalone ANSI renderer used to compose this row
 * independently and drifted apart: Ink omitted the separator between model and
 * cwd, moved the permission mode behind the context counter, and converted the
 * context window with 1024-based units (`128000 -> 125K`). Both paths now
 * consume the same segments, so ordering, separators, truncation, and colors
 * cannot diverge again.
 */

export type StatusSegmentRole =
  | "marker"
  | "sep"
  | "model"
  | "cwd"
  | "mode"
  | "thinking"
  | "context"
  | "status"
  | "queued"
  | "cache";

export type StatusSegment = {
  role: StatusSegmentRole;
  text: string;
  color: string;
  dim?: boolean;
  bold?: boolean;
};

export type StatusLineInput = {
  modelName: string;
  cwd?: string;
  permissionMode: PermissionMode;
  thinkingLevel?: ModelThinkingLevel | string;
  contextTokens: number;
  contextWindow?: number;
  busy: boolean;
  status?: string;
  queuedCount?: number;
  cacheReadTokens?: number;
  promptTokens?: number;
  /** Total row budget. Optional segments are dropped when the row would not fit. */
  width?: number;
};

export const STATUS_SEPARATOR = " · ";
/** Smallest terminal width that still shows the path segment. */
export const STATUS_CWD_MIN_WIDTH = 52;
/** Smallest terminal width that still shows the reasoning level segment. */
export const STATUS_THINKING_MIN_WIDTH = 68;
/** Smallest terminal width that still shows the cache hit segment. */
export const STATUS_CACHE_MIN_WIDTH = 100;

/**
 * Decimal context-window formatting.
 *
 * Model catalogs publish decimal windows (128000, 200000, 1000000). The
 * previous 1024-based conversion reported a 128k window as `125K` and a 200k
 * window as `195K`.
 */
export function formatContextWindow(value: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (safe >= 1_000_000) {
    const millions = safe / 1_000_000;
    return `${Number(millions.toFixed(millions >= 10 ? 0 : 1))}M`;
  }
  if (safe >= 1_000) {
    const thousands = safe / 1_000;
    return `${Number(thousands.toFixed(thousands >= 100 ? 0 : 1))}k`;
  }
  return String(safe);
}

/** Compact token counter shared by the status row and the context notice. */
export function formatTokenCount(value: number): string {
  return formatContextWindow(value);
}

export function permissionModeColor(mode: PermissionMode): string {
  return mode === "plan" ? C.planMode : mode === "bypass" ? C.error : C.info;
}

/** Labels that describe live work and must not be echoed on an idle prompt. */
const ACTIVITY_ONLY_LABELS = new Set([
  "Working…",
  "Thinking…",
  "Retrying…",
  "Continuing…",
  "Delegating…",
  "Updating todos…",
  "Waiting for permission",
]);

/**
 * Resolve the trailing outcome label for an idle prompt.
 *
 * Returns `undefined` when the status is empty, already represented by another
 * pinned segment, or describes activity that is not happening. Cycling the
 * permission mode used to render "… · Default permissions · … · Default
 * permissions", and cycling the reasoning level used to leave a stale
 * "Thinking…" on an idle prompt.
 */
export function idleStatusTail(status: string | undefined, busy: boolean, pinned: readonly string[] = []): string | undefined {
  if (busy) return undefined;
  const label = statusLabel(status ?? "", false);
  if (!label || label === "Ready") return undefined;
  if (ACTIVITY_ONLY_LABELS.has(label)) return undefined;
  if (pinned.includes(label)) return undefined;
  return label;
}

type ContentSegment = StatusSegment & { role: Exclude<StatusSegmentRole, "marker" | "sep"> };

/** Separators carry their own padding so the joined text is the visible row. */
function separatorSegment(): StatusSegment {
  return { role: "sep", text: STATUS_SEPARATOR, color: C.muted, dim: true };
}

function segmentWidth(segments: readonly StatusSegment[]): number {
  return segments.reduce((total, segment) => total + terminalStringWidth(segment.text), 0);
}

function withSeparators(segments: readonly StatusSegment[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) out.push(separatorSegment());
    out.push(segment);
  }
  return out;
}

const STATUS_ELLIPSIS = "…";

/** Truncate a segment label to a width budget, always leaving room for `…`. */
function truncateSegmentText(text: string, budget: number): string {
  if (terminalStringWidth(text) <= budget) return text;
  if (budget <= 1) return budget === 1 ? STATUS_ELLIPSIS : "";
  let result = "";
  let used = 0;
  for (const character of text) {
    const characterWidth = Math.max(1, terminalStringWidth(character));
    if (used + characterWidth > budget - 1) break;
    result += character;
    used += characterWidth;
  }
  return `${result}${STATUS_ELLIPSIS}`;
}

/**
 * Fit a segment list into a row budget.
 *
 * Optional metadata lives at the end of the list, so dropping from the tail
 * removes the least useful segments first. If a single pinned segment still
 * does not fit (a long model name on a 20-column terminal), it is truncated
 * rather than allowed to wrap the status row and push the prompt off-screen.
 */
function fitSegments(content: readonly ContentSegment[], budget: number): ContentSegment[] {
  let kept = content.length;
  while (kept > 1 && segmentWidth(withSeparators(content.slice(0, kept))) > budget) kept--;
  const trimmed = content.slice(0, kept);
  const width = segmentWidth(withSeparators(trimmed));
  if (width <= budget || trimmed.length === 0) return [...trimmed];
  const overflow = width - budget;
  const last = trimmed[trimmed.length - 1]!;
  const lastBudget = Math.max(1, terminalStringWidth(last.text) - overflow);
  return [...trimmed.slice(0, -1), { ...last, text: truncateSegmentText(last.text, lastBudget) }];
}

/**
 * Build the status row as colored segments.
 *
 * Segment order matches the Claude Code footer: identity, workspace,
 * permission mode, reasoning level, context budget, then transient outcome and
 * queue metadata. Optional trailing segments are dropped first, the path is
 * truncated next, so the row never wraps or pushes the prompt off-screen.
 */
export function buildStatusSegments(input: StatusLineInput): StatusSegment[] {
  const marker: StatusSegment = { role: "marker", text: "· ", color: C.success };
  const model: ContentSegment = { role: "model", text: input.modelName, color: C.info };
  const modeLabel = permissionModeLabel(input.permissionMode);
  const mode: ContentSegment = { role: "mode", text: modeLabel, color: permissionModeColor(input.permissionMode), dim: true };

  const thinking = input.thinkingLevel === undefined ? undefined : thinkingLevelLabel(String(input.thinkingLevel));
  const showThinking = Boolean(thinking) && (input.width === undefined || input.width >= STATUS_THINKING_MIN_WIDTH);
  const thinkingSegment: ContentSegment | undefined = showThinking && thinking
    ? { role: "thinking", text: thinking, color: C.thinking }
    : undefined;

  const contextUsage = input.contextWindow
    ? `Context ${formatTokenCount(input.contextTokens)}/${formatContextWindow(input.contextWindow)}`
    : input.contextTokens > 0
      ? `Context ${formatTokenCount(input.contextTokens)}`
      : undefined;
  const contextSegment: ContentSegment | undefined = contextUsage
    ? { role: "context", text: contextUsage, color: C.muted, dim: true }
    : undefined;

  const cacheLabel = input.cacheReadTokens !== undefined && input.cacheReadTokens > 0
    ? input.promptTokens !== undefined && input.promptTokens > 0
      ? `Cache ${Math.round((input.cacheReadTokens / input.promptTokens) * 100)}% (${formatTokenCount(input.cacheReadTokens)})`
      : `Cache ${formatTokenCount(input.cacheReadTokens)}`
    : undefined;
  const showCache = Boolean(cacheLabel) && (input.width === undefined || input.width >= STATUS_CACHE_MIN_WIDTH);

  const tailLabel = idleStatusTail(input.status, input.busy, [modeLabel, ...(thinking ? [thinking] : [])]);

  // Ordered from most to least important; the fitter drops from the end.
  const optional: ContentSegment[] = [
    ...(tailLabel ? [{ role: "status", text: tailLabel, color: C.muted, dim: true } satisfies ContentSegment] : []),
    ...((input.queuedCount ?? 0) > 0 ? [{ role: "queued", text: `${input.queuedCount} queued`, color: C.running, dim: true } satisfies ContentSegment] : []),
    ...(showCache && cacheLabel ? [{ role: "cache", text: cacheLabel, color: C.info, dim: true } satisfies ContentSegment] : []),
  ];

  const showCwd = Boolean(input.cwd) && (input.width === undefined || input.width >= STATUS_CWD_MIN_WIDTH);
  const pinned: ContentSegment[] = [model, mode, ...(thinkingSegment ? [thinkingSegment] : []), ...(contextSegment ? [contextSegment] : [])];

  if (!showCwd || input.width === undefined) {
    const content = showCwd
      ? [model, { role: "cwd", text: input.cwd!, color: C.muted, dim: true } satisfies ContentSegment, mode, ...(thinkingSegment ? [thinkingSegment] : []), ...(contextSegment ? [contextSegment] : []), ...optional]
      : [...pinned, ...optional];
    const rowBudget = input.width === undefined ? undefined : Math.max(1, input.width - terminalStringWidth(marker.text));
    return [marker, ...withSeparators(rowBudget === undefined ? content : fitSegments(content, rowBudget))];
  }

  const width = input.width;
  const budget = Math.max(1, width - terminalStringWidth(marker.text));

  // Drop the least important trailing metadata until the pinned row fits.
  let kept = optional.length;
  while (kept > 0 && segmentWidth(withSeparators([...pinned, ...optional.slice(0, kept)])) > budget) kept--;
  const tail = optional.slice(0, kept);

  const withoutCwd = [...pinned, ...tail];
  const spare = budget - segmentWidth(withSeparators(withoutCwd)) - STATUS_SEPARATOR.length;
  if (spare < 12) return [marker, ...withSeparators(fitSegments(withoutCwd, budget))];

  const cwdSegment: ContentSegment = {
    role: "cwd",
    text: truncateTerminalPath(input.cwd!, Math.max(8, spare)),
    color: C.muted,
    dim: true,
  };
  // The path sits between the model and the permission mode.
  const withCwd = [model, cwdSegment, ...withoutCwd.slice(1)];
  if (segmentWidth(withSeparators(withCwd)) > budget) return [marker, ...withSeparators(fitSegments(withoutCwd, budget))];
  return [marker, ...withSeparators(withCwd)];
}

/** Flatten segments into the plain row text used by tests and narrow frames. */
export function formatStatusLine(input: StatusLineInput): string {
  return buildStatusSegments(input).map((segment) => segment.text).join("");
}

/**
 * What the status row reports after a reasoning-level keypress.
 *
 * `Ctrl+R` cycles the effort levels the active model supports. A model without
 * reasoning has a single level, so the cycle clamps to `off` and the previous
 * `Thinking level: off` read as though the keypress had changed something.
 * Both clients now say plainly that the model has no levels to cycle.
 */
export function thinkingLevelStatusText(
  config: Pick<LlmConfig, "reasoning" | "piModel"> & { model?: string },
  nextLevel: ModelThinkingLevel,
): string {
  if (getThinkingLevelChoices(config).length <= 1) {
    return `Thinking levels are not supported by ${config.model ?? "this model"}`;
  }
  return `Thinking level: ${nextLevel}`;
}

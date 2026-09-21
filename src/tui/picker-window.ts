import { PICKER_SELECTED_MARKER } from "./claude-style.ts";

/**
 * One windowing policy for every picker overlay.
 *
 * The Ink client and the standalone ANSI renderer each decided how many
 * candidates to list, whether the selection stayed on screen, and how a
 * clipped list was announced. The same `/` therefore showed six commands in
 * Ink and twelve in ANSI, the ANSI palette stopped scrolling after its twelfth
 * row (arrowing further moved the marker off screen behind a footer that still
 * read `Showing 12 / 20`), and Ink's history picker listed every candidate it
 * was given, which could push the prompt past the last terminal row.
 *
 * Both clients now ask this module how many rows a picker gets, which slice is
 * visible, and what the surrounding chrome says.
 */

/** Candidate rows each picker shows before it clips. */
export const PICKER_MAX_VISIBLE_ITEMS: Readonly<Record<string, number>> = {
  command: 6,
  file: 8,
  model: 12,
  "model-picker": 12,
  "session-list": 8,
  "resume-messages": 8,
  "profile-list": 10,
};

/** Row budget for pickers outside the table above, such as argument palettes. */
export const PICKER_DEFAULT_MAX_VISIBLE_ITEMS = 4;

/** Pickers that always keep at least one candidate row on screen. */
const PICKER_MIN_ONE_ROWS: ReadonlySet<string> = new Set(["session-list", "resume-messages"]);

/** Pickers that print a `Showing 1-6 / 20` row once they clip. */
const PICKER_RANGE_ROW_MODES: ReadonlySet<string> = new Set([
  "command",
  "file",
  "model",
  "model-picker",
  "session-list",
  "resume-messages",
  "profile-list",
]);

/** Rows the picker itself may show for `mode`. */
export function pickerMaxVisibleItems(mode?: string): number {
  if (!mode) return 0;
  return PICKER_MAX_VISIBLE_ITEMS[mode] ?? PICKER_DEFAULT_MAX_VISIBLE_ITEMS;
}

/**
 * Rows a picker requests from the layout: its cap, bounded by how many
 * candidates actually exist. `count` defaults to the cap for overlays whose
 * rows do not depend on a candidate list.
 */
export function pickerRequestedItems(mode: string | undefined, count = Number.POSITIVE_INFINITY): number {
  if (!mode) return 0;
  const cap = Math.min(pickerMaxVisibleItems(mode), Math.max(0, count));
  return PICKER_MIN_ONE_ROWS.has(mode) ? Math.max(1, cap) : cap;
}

/** Chrome rows around the candidate list: title, optional range row, hint. */
export function pickerChromeRows(mode: string | undefined): number {
  return mode && PICKER_RANGE_ROW_MODES.has(mode) ? 3 : 2;
}

/** Candidate-list pickers, i.e. the overlays that can be dropped when the frame is full. */
const PICKER_LIST_MODES: ReadonlySet<string> = new Set([
  "command",
  "file",
  "model",
  "model-picker",
  "session-list",
  "resume-messages",
  "profile-list",
]);

/**
 * Whether a picker is a candidate list.
 *
 * List pickers are dropped entirely when the frame has no spare rows, so a
 * short terminal keeps the welcome panel and the prompt instead of squeezing a
 * single candidate between them. Setup-style overlays (model setup, profile
 * name, Todo editor) always render: they hold state the user is typing into.
 */
export function pickerIsListMode(mode: string | undefined): boolean {
  return Boolean(mode) && PICKER_LIST_MODES.has(mode as string);
}

/** Candidate rows a picker gets once the frame budget is known. */
export function pickerPageItems(mode: string | undefined, count: number, maxItems?: number): number {
  const requested = pickerRequestedItems(mode, count);
  if (maxItems === undefined) return requested;
  return Math.max(0, Math.min(requested, maxItems));
}

/**
 * Tail-anchored window: rows scroll only when the selection would otherwise
 * leave the page, so the highlighted candidate is always visible.
 */
export function pickerVisibleWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  maxVisible: number,
): { visible: T[]; start: number } {
  const count = Math.max(0, maxVisible);
  if (count === 0) return { visible: [], start: 0 };
  const start = Math.max(0, Math.min(selectedIndex - count + 1, items.length - count));
  return { visible: items.slice(start, start + count), start };
}

/** `Showing 11-16 / 20`, printed under a clipped picker in both clients. */
export function pickerRangeText(start: number, visibleCount: number, total: number): string {
  const end = Math.min(start + Math.max(0, visibleCount), total);
  const from = Math.min(start + 1, Math.max(1, end));
  return `Showing ${from}-${end} / ${total}`;
}

/** Palette heading, without the per-client decoration (`──` in Ink, `⌘` in ANSI). */
export function pickerTitleText(
  mode: string,
  context?: { filter?: string; query?: string; fragment?: string; argumentPrefix?: string },
): string {
  if (context?.argumentPrefix) return `${context.argumentPrefix.trim()} arguments`;
  switch (mode) {
    case "command":
      return `Commands /${context?.filter ?? ""}`;
    case "file":
      return `Files ${context?.fragment ?? ""}`;
    case "model":
    case "model-picker":
      return `Models ${context?.query || "all"}`;
    case "resume-messages":
      return "Choose history point";
    default:
      return "Commands";
  }
}

/** Navigation hint under a picker; identical wording in both clients. */
export function pickerHintText(mode: string, options?: { argumentPalette?: boolean }): string {
  if (options?.argumentPalette) return "Tab/Enter select  ↑↓ navigate  Esc close";
  switch (mode) {
    case "file":
      return "Tab/→ complete  ↑↓ navigate  Esc close";
    case "model":
    case "model-picker":
      return "Enter select  ↑↓ navigate  Esc cancel";
    case "resume-messages":
      return "Enter rewind here  ↑↓ navigate  Esc back";
    case "profile-list":
      return "↑↓ select  ·  Enter activate  ·  Esc cancel  ·  /profiles delete <name>";
    default:
      return "Tab/Enter select  ↑↓ navigate  Esc close";
  }
}

/** Longest session preview a palette row carries before it is clipped. */
export const SESSION_PREVIEW_MAX = 48;

/** Column at which a model row's context size starts, measured after the marker. */
export function modelNameColumn(visibleModels: readonly string[]): number {
  return Math.min(40, Math.max(0, ...visibleModels.map((model) => model.length)) + 4);
}

/**
 * `✓ provider/model` — the label both clients pad into the shared name column.
 * Ink pads to `column - 1` because its `Box gap={1}` supplies the last column;
 * the ANSI renderer pads to `column`. The active model is marked in both
 * clients; the ANSI picker used to list bare references with no way to tell
 * which one was in use.
 */
export function modelNameLabel(model: string, active: boolean): string {
  return `${active ? "✓ " : "  "}${model}`;
}

/**
 * One saved-session row after the selection marker: a short id, the message
 * count, and a bounded preview. Ink truncates by terminal width, the ANSI
 * renderer used to clip the preview itself, so the two disagreed on long
 * previews; both now print this string verbatim.
 */
export function sessionRowContent(session: { id: string; messageCount: number; preview: string }): string {
  const preview = session.preview.replace(/\s+/g, " ").trim();
  const detail = [
    `${session.messageCount} msgs`,
    preview ? preview.slice(0, SESSION_PREVIEW_MAX) : undefined,
  ].filter(Boolean).join("  ");
  return `${session.id.slice(0, 12)}  ${detail}`;
}

/** One model-profile row, identical in both clients. */
export function profileRowText(
  profile: { name: string; model: string; baseUrl?: string; active?: boolean },
  selected: boolean,
): string {
  const marker = selected ? `${PICKER_SELECTED_MARKER} ` : "  ";
  const detail = profile.baseUrl
    ? `${profile.name} (${profile.model}) — ${profile.baseUrl}`
    : `${profile.name} (${profile.model})`;
  return `${marker}${profile.active ? "✓ " : "  "}${detail}`;
}

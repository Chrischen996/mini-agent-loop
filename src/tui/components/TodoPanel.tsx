import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PlanDocument } from "../../plan/document.ts";
import type { TodoItem, TodoViewMode } from "../../todo.ts";
import { todoSummary } from "../../todo.ts";
import {
  resolveTodoItems,
  todoProgressMeter,
  todoText,
  TODO_PANEL_MAX_VISIBLE_ITEMS,
  TODO_PLAN_STATUS_LABELS,
} from "../todo-format.ts";
import { LOADING_FRAME_MS } from "../activity.ts";

// ─── Spinner frames for in_progress items ─────────────────────────────────

const TODO_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function getSpinnerChar(now: number): string {
  const idx = Math.floor(now / LOADING_FRAME_MS) % TODO_SPINNER_FRAMES.length;
  return TODO_SPINNER_FRAMES[idx] ?? "⠋";
}

// ─── Single todo row (pure, no hooks) ─────────────────────────────────────

type TodoRowProps = {
  item: TodoItem;
  index: number;
  showIndex: boolean;
  now: number;
};

function TodoRow({ item, index, showIndex, now }: TodoRowProps): React.ReactElement {
  // For in_progress, prefer activeForm if it differs from content
  const displayText =
    item.status === "in_progress" && item.activeForm !== item.content
      ? item.activeForm
      : item.content;
  const label = `${showIndex ? `${index + 1}. ` : ""}${todoText(displayText)}`;

  if (item.status === "in_progress") {
    return (
      <Box gap={1} minWidth={0}>
        <Text color={C.running} bold>{getSpinnerChar(now)}</Text>
        <Text color={C.running} wrap="truncate-end">{label}</Text>
      </Box>
    );
  }

  if (item.status === "completed") {
    return (
      <Box gap={1} minWidth={0}>
        <Text color={C.success} dimColor>{"✓"}</Text>
        <Text color={C.success} dimColor strikethrough wrap="truncate-end">{label}</Text>
      </Box>
    );
  }

  if (item.status === "failed") {
    return (
      <Box gap={1} minWidth={0}>
        <Text color={C.error}>{"✗"}</Text>
        <Text color={C.error} wrap="truncate-end">{label}</Text>
      </Box>
    );
  }

  if (item.status === "skipped") {
    return (
      <Box gap={1} minWidth={0}>
        <Text color={C.muted} dimColor>{"-"}</Text>
        <Text color={C.muted} dimColor wrap="truncate-end">{label}</Text>
      </Box>
    );
  }

  // pending
  return (
    <Box gap={1} minWidth={0}>
      <Text color={C.muted}>{"☐"}</Text>
      <Text color={C.muted} wrap="truncate-end">{label}</Text>
    </Box>
  );
}

// ─── Separator row ─────────────────────────────────────────────────────────

function SeparatorRow(): React.ReactElement {
  return (
    <Box paddingLeft={2} minWidth={0}>
      <Text color={C.muted} dimColor>{"─────"}</Text>
    </Box>
  );
}

// ─── Pure render body (no hooks — safe to call in tests) ──────────────────

export type TodoPanelProps = {
  plan?: PlanDocument;
  todos?: readonly TodoItem[];
  viewMode?: TodoViewMode;
  maxVisibleItems?: number;
  width?: number;
  /** Injected timestamp for spinner frame; when omitted the panel uses useState. */
  now?: number;
};

/**
 * Pure (no-hooks) panel body. Exported so test code can call it directly
 * without needing a React rendering context.
 */
export function TodoPanelStatic({
  plan,
  todos,
  viewMode = "expanded",
  maxVisibleItems = TODO_PANEL_MAX_VISIBLE_ITEMS,
  width,
  now = Date.now(),
}: TodoPanelProps): React.ReactElement | null {
  const items = resolveTodoItems({ plan, todos });
  if (viewMode === "hidden" || (!plan && !todos)) return null;
  if (!items.length) return null;

  const summary = todoSummary(items);
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const planStatus = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";
  const meter = todoProgressMeter(summary.completed, summary.total);
  const headerText = [
    `Todos  ${meter}  ${summary.completed}/${summary.total} completed`,
    summary.inProgress ? `  ${summary.inProgress} in progress` : "",
    summary.failed ? `  ${summary.failed} failed` : "",
    skippedCount ? `  ${skippedCount} skipped` : "",
    planStatus,
  ].join("");

  // ── compact mode: one line ──────────────────────────────────────────────
  if (viewMode === "compact") {
    const active = items.find((item) => item.status === "in_progress");
    const activeLabel =
      active?.activeForm ??
      (summary.total > 0 && summary.completed === summary.total
        ? "All tasks completed"
        : "No active task");

    const labelBudget = Math.max(20, (width ?? 120) - headerText.length - 10);

    return (
      <Box paddingX={1} flexShrink={0} width={width} minWidth={0} overflow="hidden">
        <Text color={C.info} bold>{"☷ "}</Text>
        {active ? (
          <>
            <Text color={C.muted}>{headerText}  ▸  ·  </Text>
            <Text color={C.running}>{getSpinnerChar(now)} </Text>
            <Text color={C.running} wrap="truncate-end">{todoText(activeLabel, labelBudget)}</Text>
          </>
        ) : (
          <Text color={C.muted} dimColor wrap="truncate-end">
            {headerText}  ▸  ·  {todoText(activeLabel, labelBudget)}
          </Text>
        )}
      </Box>
    );
  }

  // ── expanded mode ────────────────────────────────────────────────────────
  // Group items by status priority
  const inProgressItems = items.filter((item) => item.status === "in_progress");
  const pendingItems = items.filter((item) => item.status === "pending");
  const doneItems = items.filter(
    (item) => item.status === "completed" || item.status === "failed" || item.status === "skipped",
  );

  // Build ordered list respecting maxVisibleItems (separators don't count)
  type VisibleEntry =
    | { kind: "item"; item: TodoItem; originalIndex: number }
    | { kind: "sep"; key: string };

  const ordered: Array<{ item: TodoItem; originalIndex: number }> = [];
  for (const item of [...inProgressItems, ...pendingItems, ...doneItems]) {
    const originalIndex = items.indexOf(item);
    ordered.push({ item, originalIndex });
  }

  const visibleItems = ordered.slice(0, maxVisibleItems);

  // Reconstruct groups from visible items to insert separators
  const visibleInProgress = visibleItems.filter((e) => e.item.status === "in_progress");
  const visiblePending = visibleItems.filter((e) => e.item.status === "pending");
  const visibleDone = visibleItems.filter(
    (e) =>
      e.item.status === "completed" ||
      e.item.status === "failed" ||
      e.item.status === "skipped",
  );

  const entries: VisibleEntry[] = [];
  let sepIndex = 0;

  if (visibleInProgress.length > 0) {
    for (const e of visibleInProgress) entries.push({ kind: "item", ...e });
  }
  if (visiblePending.length > 0) {
    if (entries.length > 0) entries.push({ kind: "sep", key: `todo-sep-${sepIndex++}` });
    for (const e of visiblePending) entries.push({ kind: "item", ...e });
  }
  if (visibleDone.length > 0) {
    if (entries.length > 0) entries.push({ kind: "sep", key: `todo-sep-${sepIndex++}` });
    for (const e of visibleDone) entries.push({ kind: "item", ...e });
  }

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0} width={width} minWidth={0} overflow="hidden">
      {/* Header */}
      <Box gap={1} minWidth={0}>
        <Text color={C.info} bold>{"☷"}</Text>
        <Text color={C.info} bold wrap="truncate-end">{headerText}  ▾</Text>
      </Box>

      {/* Item rows */}
      {visibleItems.length === 0 ? (
        <Text color={C.muted} dimColor>{"  No todos"}</Text>
      ) : (
        entries.map((entry) => {
          if (entry.kind === "sep") {
            return <SeparatorRow key={entry.key} />;
          }
          const { item, originalIndex } = entry;
          return (
            <Box key={item.id} paddingLeft={2} minWidth={0}>
              <TodoRow item={item} index={originalIndex} showIndex={item.source === "plan"} now={now} />
            </Box>
          );
        })
      )}

      {/* overflow */}
      {items.length > maxVisibleItems && (
        <Text color={C.muted} dimColor>{`  … ${items.length - maxVisibleItems} more`}</Text>
      )}
    </Box>
  );
}

// ─── Animated wrapper (uses hooks — must be inside a React tree) ───────────

/**
 * Live TodoPanel with built-in spinner animation for `in_progress` items.
 * Use `TodoPanelStatic` in tests.
 */
export function TodoPanel(props: TodoPanelProps): React.ReactElement | null {
  const items = resolveTodoItems({ plan: props.plan, todos: props.todos });
  const hasInProgress = items.some((item) => item.status === "in_progress");

  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!hasInProgress) return;
    const timer = setInterval(() => setNow(Date.now()), LOADING_FRAME_MS);
    return () => clearInterval(timer);
  }, [hasInProgress]);

  return <TodoPanelStatic {...props} now={now} />;
}

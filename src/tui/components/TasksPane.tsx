/**
 * TasksPane — per-session parallel-tasks pane (Grok Build `tasks_pane.rs`
 * semantics): aggregates the CURRENT session's tasks (subagents, background
 * tasks), grouped by GroupKind with running-first order. It is NOT a
 * cross-session dashboard (that is AgentDashboard).
 *
 * The fixed group order mirrors Grok's GroupKind enum. The "workflows" and
 * "watchers" slots stay empty today: the TUI exposes no live workflow
 * (JobManager) instance or watcher service, so those groups render here
 * once such a source is wired in — no fake data in the meantime.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { SubagentTaskRegistry, SubagentTaskRecord, SubagentTaskStatus } from "../../subagent/task-registry.ts";
import type { BgTaskManager, BgTaskSummary } from "../../bg-tasks/manager.js";
import { TUI_COLORS as C } from "../theme.ts";
import { panelBorderStyle } from "../pixel-glyphs.ts";
import { bgTaskStatusColor, bgTaskStatusGlyph, isBgTaskActive } from "../bg-task-status-color.ts";
import { compactText } from "../text-utils.ts";

export type TasksPaneGroupKind = "workflows" | "subagents" | "bgtasks" | "watchers";

/** Fixed group order, mirroring Grok Build's tasks_pane GroupKind list. */
const GROUP_KINDS: readonly TasksPaneGroupKind[] = ["workflows", "subagents", "bgtasks", "watchers"];
const GROUP_TITLES: Record<TasksPaneGroupKind, string> = {
  workflows: "Workflows",
  subagents: "Subagents",
  bgtasks: "Background tasks",
  watchers: "Watchers",
};

type PaneGroup = Extract<TasksPaneGroupKind, "subagents" | "bgtasks">;

export type TasksPaneRow = {
  key: string;
  group: PaneGroup;
  status: string;
  active: boolean;
  createdAt: string;
  shortId: string;
  label: string;
  subagent?: SubagentTaskRecord;
  bgTask?: BgTaskSummary;
};

export type TasksPaneProps = {
  /** The current conversation/session id the pane filters on. */
  sessionId: string;
  subagentRegistry: SubagentTaskRegistry;
  /** Null when background tasks are disabled/unavailable; subagents still show. */
  bgManager: BgTaskManager | null;
  onClose: () => void;
  width: number;
  /** Viewport height; caps the detail block so the pane stays inside the frame. */
  height: number;
};

function isSubagentActive(status: SubagentTaskStatus): boolean {
  return status === "queued" || status === "running";
}

function subagentStatusGlyph(status: SubagentTaskStatus): string {
  switch (status) {
    case "queued": return "☐";
    case "running": return "⟳";
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled":
    case "interrupted": return "−";
  }
}

function subagentStatusColor(status: SubagentTaskStatus): string {
  if (isSubagentActive(status)) return C.running;
  if (status === "completed") return C.success;
  if (status === "failed") return C.error;
  return C.muted;
}

function rowColor(row: TasksPaneRow): string {
  if (row.group === "bgtasks") return bgTaskStatusColor(row.status);
  return subagentStatusColor(row.status as SubagentTaskStatus);
}

function rowGlyph(row: TasksPaneRow): string {
  if (row.group === "bgtasks") return bgTaskStatusGlyph(row.status);
  return subagentStatusGlyph(row.status as SubagentTaskStatus);
}

/** Same comparator style as BgTaskLivePanel: active rows first, then newest-first. */
function compareRows(left: TasksPaneRow, right: TasksPaneRow): number {
  const activityOrder = Number(right.active) - Number(left.active);
  if (activityOrder !== 0) return activityOrder;
  return right.createdAt.localeCompare(left.createdAt);
}

/** Last `max` non-empty lines of a block, with a skip marker when truncated. */
function tailLines(text: string, max: number): string[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const tail = lines.slice(-max);
  const skipped = lines.length - tail.length;
  return skipped > 0 ? [`… ${skipped} earlier lines`, ...tail] : tail;
}

export function TasksPane({ sessionId, subagentRegistry, bgManager, onClose, width, height }: TasksPaneProps): React.ReactElement {
  const [rows, setRows] = useState<TasksPaneRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const rowsRef = useRef<TasksPaneRow[]>([]);
  rowsRef.current = rows;
  const selectedKeyRef = useRef<string | undefined>(undefined);
  // Log cursors belong to one task; reset them whenever the selection moves
  // so another task's output never splices into the panel.
  const logOffsetRef = useRef(0);
  const stoppingRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const bgList = bgManager
        ? (async () => {
            await bgManager.initialize();
            return bgManager.list();
          })()
        : Promise.resolve([] as BgTaskSummary[]);
      const [subagentRecords, bgTasks] = await Promise.all([
        subagentRegistry.list(sessionId),
        bgList,
      ]);

      const subagentRows: TasksPaneRow[] = subagentRecords.map((record) => {
        const branch = record.worktreeBranch ? ` ⎇ ${record.worktreeBranch}` : "";
        const profile = record.profile ? ` · ${record.profile}` : "";
        return {
          key: `sub:${record.taskId}`,
          group: "subagents" as const,
          status: record.status,
          active: isSubagentActive(record.status),
          createdAt: record.createdAt,
          shortId: record.taskId.slice(0, 8),
          label: `${compactText(record.task, Math.max(12, width - 40), "…", { maxIncludesEllipsis: true })}${profile}${branch}`,
          subagent: record,
        };
      });
      // This pane is "this session's pane": background tasks owned by this
      // session plus legacy tasks without an owner marker. Tasks owned by
      // another session belong to that session's pane.
      const ownedBgTasks = bgTasks.filter((task) => task.ownerSessionId === undefined || task.ownerSessionId === sessionId);
      const bgRows: TasksPaneRow[] = ownedBgTasks.map((task) => ({
        key: `bg:${task.taskId}`,
        group: "bgtasks" as const,
        status: task.status,
        active: isBgTaskActive(task.status),
        createdAt: task.createdAt,
        shortId: task.taskId.slice(0, 8),
        label: task.name,
        bgTask: task,
      }));

      // Fixed group order: subagents block first, then background tasks.
      const nextRows = [...subagentRows.sort(compareRows), ...bgRows.sort(compareRows)];
      const previousSelected = selectedKeyRef.current;
      const selection = nextRows.some((row) => row.key === previousSelected) ? previousSelected : nextRows[0]?.key;
      if (selection !== previousSelected) {
        logOffsetRef.current = 0;
        setLogTail([]);
      }
      selectedKeyRef.current = selection;
      rowsRef.current = nextRows;
      setRows(nextRows);
      setSelectedKey(selection);
      setRefreshError(null);

      const selected = nextRows.find((row) => row.key === selection);
      if (selected?.bgTask && bgManager) {
        const chunk = await bgManager.logs(selected.bgTask.taskId, logOffsetRef.current, 2048);
        logOffsetRef.current = chunk.nextOffset;
        // Keep a short bounded buffer; the render slices it to the pane's height.
        if (chunk.text) setLogTail(chunk.text.split("\n").filter((line) => line.length > 0).slice(-16));
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId, subagentRegistry, bgManager, width]);

  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const anyActive = rowsRef.current.some((row) => row.active);
      timer = setTimeout(() => void tick(), anyActive ? 1000 : 5000);
      timer.unref?.();
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === "r" || input === "R") {
      setRefreshKey((k) => k + 1);
      return;
    }
    const current = rowsRef.current;
    const selectedIdx = current.findIndex((row) => row.key === selectedKeyRef.current);
    if (key.downArrow) {
      const next = current[selectedIdx + 1]?.key;
      if (next && next !== selectedKeyRef.current) {
        selectedKeyRef.current = next;
        logOffsetRef.current = 0;
        setLogTail([]);
        setSelectedKey(next);
      }
      return;
    }
    if (key.upArrow) {
      const next = current[Math.max(0, selectedIdx - 1)]?.key;
      if (next && next !== selectedKeyRef.current) {
        selectedKeyRef.current = next;
        logOffsetRef.current = 0;
        setLogTail([]);
        setSelectedKey(next);
      }
      return;
    }
    if (input === "x" || input === "X") {
      const selected = current[selectedIdx];
      // Termination is only offered for active background tasks, via the
      // existing manager API; subagents stay read/observe-only.
      if (selected?.bgTask && selected.active && bgManager && stoppingRef.current === null) {
        stoppingRef.current = selected.key;
        setStoppingKey(selected.key);
        void bgManager.terminate(selected.bgTask.taskId)
          .then(() => setRefreshKey((k) => k + 1))
          .catch((error: unknown) => setRefreshError(error instanceof Error ? error.message : String(error)))
          .finally(() => {
            stoppingRef.current = null;
            setStoppingKey(null);
          });
      }
      return;
    }
    const enter = key.return || input === "\r" || input === "\n";
    if (enter && current.length > 0) {
      setDetailOpen((open) => !open);
    }
  });

  const selectedRow = rows.find((row) => row.key === selectedKey);
  const runningCount = rows.filter((row) => row.active).length;
  // The detail block scales with the pane's height but stays bounded so the
  // panel never pushes the input chrome off the frame.
  const detailTailLines = Math.max(2, Math.min(4, Math.max(0, height - 14)));
  const subagentTailLines = Math.min(3, Math.max(2, detailTailLines));

  return (
    <Box flexDirection="column" borderStyle={panelBorderStyle()} borderColor={C.info} paddingX={1} width={width} minWidth={0}>
      <Text bold color={C.info}>▣ Tasks · this session ({sessionId.slice(0, 8)})</Text>
      <Text dimColor>{rows.length === 0
        ? "No tasks in this session."
        : `${runningCount} running · ${rows.length} total · ↑↓ navigate · Enter details · r refresh · Esc close`}</Text>
      {refreshError && <Text color={C.error}>⚠ Refresh failed: {refreshError}</Text>}
      {rows.length === 0 && <Text dimColor>No tasks in this session.</Text>}
      {GROUP_KINDS.map((kind) => {
        const groupRows = rows.filter((row) => row.group === kind);
        if (groupRows.length === 0) return null;
        const activeCount = groupRows.filter((row) => row.active).length;
        return (
          <React.Fragment key={kind}>
            <Text>
              <Text color={C.info} bold>▸ {GROUP_TITLES[kind]}</Text>
              {activeCount > 0 && <Text color={C.running}> · {activeCount} running</Text>}
              <Text dimColor> · {groupRows.length} total</Text>
            </Text>
            {groupRows.map((row) => {
              const selected = row.key === selectedKey;
              return (
                <Text key={row.key} color={rowColor(row)} bold={selected} wrap="truncate-end">
                  {selected ? "▶" : "·"} {rowGlyph(row)} {row.status.padEnd(11)} {row.shortId}  {row.label}{stoppingKey === row.key ? " · stopping" : ""}
                </Text>
              );
            })}
          </React.Fragment>
        );
      })}
      {detailOpen && selectedRow && (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>── detail ({selectedRow.shortId}) ──</Text>
          {selectedRow.subagent ? (
            <>
              {selectedRow.subagent.error ? (
                <Text color={C.error} wrap="truncate-end">
                  {tailLines(selectedRow.subagent.error, subagentTailLines).map((line) => compactText(line, Math.max(12, width - 12), "…", { maxIncludesEllipsis: true })).join("  ")}
                </Text>
              ) : selectedRow.subagent.result ? (
                <Text dimColor wrap="truncate-end">
                  {tailLines(selectedRow.subagent.result, subagentTailLines).map((line) => compactText(line, Math.max(12, width - 12), "…", { maxIncludesEllipsis: true })).join("  ")}
                </Text>
              ) : selectedRow.active ? (
                <Text dimColor>(in progress)</Text>
              ) : null}
              {selectedRow.subagent.worktreePath && selectedRow.subagent.worktreeBranch && (
                <Text dimColor wrap="truncate-end">⎇ {selectedRow.subagent.worktreeBranch} @ {selectedRow.subagent.worktreePath}</Text>
              )}
            </>
          ) : selectedRow.bgTask ? (
            <>
              <Text dimColor wrap="truncate-end">
                Session {selectedRow.bgTask.sessionName}{selectedRow.bgTask.tags && selectedRow.bgTask.tags.length > 0 ? ` · ${selectedRow.bgTask.tags.join(", ")}` : ""}
              </Text>
              {logTail.length > 0
                ? logTail.slice(-detailTailLines).map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">{compactText(line, Math.max(12, width - 12), "…", { maxIncludesEllipsis: true })}</Text>
                ))
                : <Text dimColor>(no log output yet)</Text>}
            </>
          ) : null}
        </Box>
      )}
      <Text dimColor>↑↓ navigate · Enter details · x stop · r refresh · Esc close</Text>
    </Box>
  );
}

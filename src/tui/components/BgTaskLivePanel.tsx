/**
 * BgTaskLivePanel — persistent floating panel for background tasks (Live panel B).
 * Arrow-key selection, inline log tail, `r` refresh.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { BgTaskSummary, LogChunk } from "../../bg-tasks/manager.js";
import { TUI_COLORS as C } from "../theme.ts";

export type BgTaskLivePanelProps = {
  manager: {
    list(): Promise<BgTaskSummary[]>;
    logs(taskId: string, offset?: number, limitBytes?: number): Promise<LogChunk>;
    terminate(taskId: string, force?: boolean): Promise<BgTaskSummary>;
    initialize(): Promise<void>;
  };
  width?: number;
  maxLogLines?: number;
  onClose?: () => void;
};

/** Tail limit for the in-panel log buffer; older bytes scroll out of view. */
const MAX_LOG_BUFFER_CHARS = 32 * 1024;

function isTaskActive(task: BgTaskSummary): boolean {
  return task.status === "starting" || task.status === "running" || task.status === "unknown";
}

type TaskState = Pick<BgTaskSummary, "taskId" | "status" | "exitCode" | "durationMs" | "name">;
const taskStates = new Map<string, TaskState>();

function compareTaskStates(previous: TaskState[] | undefined, current: BgTaskSummary[]): boolean {
  if (!previous || previous.length !== current.length) return true;
  const map = new Map(previous.map((task) => [task.taskId, task]));
  return current.some((task) => {
    const prev = map.get(task.taskId);
    return !prev || prev.status !== task.status || prev.exitCode !== task.exitCode || prev.name !== task.name;
  });
}

export function BgTaskLivePanel({ manager, width = 80, maxLogLines = 8, onClose }: BgTaskLivePanelProps): React.ReactElement {
  const [tasks, setTasks] = useState<BgTaskSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [logText, setLogText] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const stoppingTaskIdRef = useRef<string | null>(null);

  const selectedIndexRef = useRef(selectedIndex);
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);
  // Log cursors belong to one task. Tracking them per selected task keeps the
  // inline tail from splicing another task's output into the panel.
  const logOffsetRef = useRef(0);
  const tasksRef = useRef<BgTaskSummary[]>([]);
  tasksRef.current = tasks;

  const refresh = useCallback(async () => {
    try {
      await manager.initialize();
      const list = await manager.list();
      list.sort((left, right) => {
        const activityOrder = Number(isTaskActive(right)) - Number(isTaskActive(left));
        return activityOrder || right.createdAt.localeCompare(left.createdAt);
      });
      setTasks(list);
      setRefreshError(null);

      if (list.length === 0) {
        selectedTaskIdRef.current = undefined;
        logOffsetRef.current = 0;
        setLogText("");
        return;
      }

      const selectedIndexById = selectedTaskIdRef.current
        ? list.findIndex((task) => task.taskId === selectedTaskIdRef.current)
        : -1;
      const idx = selectedIndexById >= 0
        ? selectedIndexById
        : Math.min(selectedIndexRef.current, list.length - 1);
      selectedIndexRef.current = idx;
      setSelectedIndex(idx);
      const selectedTask = list[idx];
      const taskChanged = selectedTask.taskId !== selectedTaskIdRef.current;
      if (taskChanged) {
        logOffsetRef.current = 0;
        setLogText("");
      }
      selectedTaskIdRef.current = selectedTask.taskId;

      const chunk = await manager.logs(selectedTask.taskId, logOffsetRef.current, 4 * 1024);
      logOffsetRef.current = chunk.nextOffset;
      if (chunk.text) {
        setLogText((previous) => (previous + chunk.text).slice(-MAX_LOG_BUFFER_CHARS));
      } else if (taskChanged) {
        // The new task has not produced log output yet; keep the panel clear
        // instead of showing the previously selected task's tail.
        setLogText("");
      } else if (chunk.endOfLog) {
        // The log has reached the tail and nothing new was appended.
        setLogText("");
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }, [manager]);

  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const active = tasksRef.current.some((t) => t.status === "running" || t.status === "starting");
      timer = setTimeout(() => void tick(), active ? 1000 : 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  useInput((input, key) => {
    if (key.escape && onClose) {
      onClose();
      return;
    }
    if (input === "r" || input === "R") {
      setRefreshKey((k) => k + 1);
      return;
    }
    const currentSelectedTask = tasksRef.current[selectedIndexRef.current];
    if ((input === "x" || input === "X") && currentSelectedTask && isTaskActive(currentSelectedTask)) {
      if (stoppingTaskIdRef.current) return;
      stoppingTaskIdRef.current = currentSelectedTask.taskId;
      setStoppingTaskId(currentSelectedTask.taskId);
      setRefreshError(null);
      void manager.terminate(currentSelectedTask.taskId)
        .then(() => refresh())
        .catch((error: unknown) => {
          setRefreshError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          stoppingTaskIdRef.current = null;
          setStoppingTaskId(null);
        });
      return;
    }
    if (key.downArrow) {
      const next = Math.min(selectedIndexRef.current + 1, Math.max(0, tasksRef.current.length - 1));
      selectedIndexRef.current = next;
      selectedTaskIdRef.current = tasksRef.current[next]?.taskId;
      setSelectedIndex(next);
      void refresh();
      return;
    }
    if (key.upArrow) {
      const next = Math.max(selectedIndexRef.current - 1, 0);
      selectedIndexRef.current = next;
      selectedTaskIdRef.current = tasksRef.current[next]?.taskId;
      setSelectedIndex(next);
      void refresh();
      return;
    }
  });

  const selectedTask = tasks[selectedIndex];
  const runningCount = tasks.filter(isTaskActive).length;
  const finishedCount = tasks.length - runningCount;
  const logLines = logText.split("\n").slice(-maxLogLines);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.info} paddingX={1} width={width} minWidth={0}>
      <Text bold color={C.info}>▣ Background task dashboard</Text>
      <Text dimColor>{runningCount} running · {finishedCount} finished · ↑↓ select · x stop · r refresh · Esc close</Text>
      {refreshError && <Text color={C.error}>⚠ Refresh failed: {refreshError}</Text>}
      {tasks.length === 0 && <Text dimColor>No background tasks.</Text>}
      {tasks.map((t, i) => (
        <Text key={t.taskId} color={i === selectedIndex ? C.running : C.muted} bold={i === selectedIndex}>
          {i === selectedIndex ? "▶" : " "} {t.status.padEnd(10)} {t.taskId.slice(0, 8)}  {t.name}{stoppingTaskId === t.taskId ? " · stopping" : ""}
        </Text>
      ))}
      {selectedTask && (
        <>
          <Text dimColor>── log tail ({selectedTask.taskId.slice(0, 8)}) ──</Text>
          {logLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </>
      )}
    </Box>
  );
}

/**
 * BgTaskLivePanel — persistent floating panel for background tasks (Live panel B).
 * Arrow-key selection, inline log tail, `r` refresh.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { BgTaskSummary, LogChunk } from "../../bg-tasks/manager.js";
import { TUI_COLORS as C } from "../theme.ts";
import { bgTaskStatusColor, bgTaskStatusGlyph, isBgTaskActive } from "../bg-task-status-color.ts";

export type BgTaskLivePanelProps = {
  manager: {
    list(): Promise<BgTaskSummary[]>;
    logs(taskId: string, offset?: number, limitBytes?: number): Promise<LogChunk>;
    screen?(taskId: string, lines?: number): Promise<LogChunk>;
    send?(taskId: string, input: { text?: string; enter?: boolean; key?: "ctrl_c" | "ctrl_d" | "ctrl_z" | "up" | "down" | "left" | "right" }): Promise<BgTaskSummary>;
    wait?(taskIds: string[], mode?: "any" | "all", timeoutSeconds?: number): Promise<unknown>;
    terminate(taskId: string, force?: boolean): Promise<BgTaskSummary>;
    initialize(): Promise<void>;
  };
  width?: number;
  maxLogLines?: number;
  onClose?: () => void;
};

/** Tail limit for the in-panel log buffer; older bytes scroll out of view. */
const MAX_LOG_BUFFER_CHARS = 32 * 1024;
const TASK_ACTIONS = ["View recent logs", "Capture screen", "Send input", "Wait for completion", "Terminate task"] as const;

function isTaskActive(task: BgTaskSummary): boolean {
  return isBgTaskActive(task.status);
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
  const [view, setView] = useState<"tasks" | "actions" | "send">("tasks");
  const [actionIndex, setActionIndex] = useState(0);
  const [sendDraft, setSendDraft] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
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
      timer.unref?.();
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  useInput((input, key) => {
    const enter = key.return || input === "\r" || input === "\n";
    if (view === "send") {
      if (key.escape) {
        setSendDraft("");
        setView("actions");
        return;
      }
      if (enter) {
        const task = tasksRef.current[selectedIndexRef.current];
        if (!task || !manager.send || !sendDraft.trim()) return;
        setActionStatus("Sending input…");
        void manager.send(task.taskId, { text: sendDraft, enter: true })
          .then(() => {
            setSendDraft("");
            setActionStatus("Input sent.");
            setView("tasks");
          })
          .catch((error: unknown) => setActionStatus(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (key.backspace || key.delete) {
        setSendDraft((value) => value.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) setSendDraft((value) => value + input);
      return;
    }
    if (key.escape) {
      if (view === "actions") {
        setView("tasks");
        setActionStatus(null);
      } else {
        onClose?.();
      }
      return;
    }
    if (view === "actions") {
      if (key.upArrow) {
        setActionIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setActionIndex((index) => Math.min(TASK_ACTIONS.length - 1, index + 1));
        return;
      }
      if (!enter) return;
      const task = tasksRef.current[selectedIndexRef.current];
      const action = TASK_ACTIONS[actionIndex];
      if (!task || !action) return;
      setActionStatus(null);
      if (action === "View recent logs") {
        setView("tasks");
        void refresh();
      } else if (action === "Capture screen") {
        if (!manager.screen) {
          setActionStatus("Screen capture is unavailable.");
          return;
        }
        setActionStatus("Capturing screen…");
        void manager.screen(task.taskId)
          .then((chunk) => {
            logOffsetRef.current = chunk.nextOffset;
            setLogText(chunk.text);
            setActionStatus("Screen captured.");
            setView("tasks");
          })
          .catch((error: unknown) => setActionStatus(error instanceof Error ? error.message : String(error)));
      } else if (action === "Send input") {
        setSendDraft("");
        setView("send");
        setActionStatus("Type input and press Enter to send.");
      } else if (action === "Wait for completion") {
        if (!manager.wait) {
          setActionStatus("Waiting is unavailable.");
          return;
        }
        setActionStatus("Waiting for task completion…");
        void manager.wait([task.taskId], "all")
          .then(() => refresh())
          .then(() => setActionStatus("Task finished."))
          .catch((error: unknown) => setActionStatus(error instanceof Error ? error.message : String(error)));
      } else {
        setStoppingTaskId(task.taskId);
        setActionStatus("Terminating task…");
        void manager.terminate(task.taskId)
          .then(() => refresh())
          .then(() => setActionStatus("Task terminated."))
          .catch((error: unknown) => setActionStatus(error instanceof Error ? error.message : String(error)))
          .finally(() => setStoppingTaskId(null));
      }
      return;
    }
    if (input === "r" || input === "R") {
      setRefreshKey((k) => k + 1);
      return;
    }
    if (enter && tasksRef.current[selectedIndexRef.current]) {
      setView("actions");
      setActionIndex(0);
      setActionStatus(null);
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
      logOffsetRef.current = 0;
      setLogText("");
      setSelectedIndex(next);
      void refresh();
      return;
    }
    if (key.upArrow) {
      const next = Math.max(selectedIndexRef.current - 1, 0);
      selectedIndexRef.current = next;
      selectedTaskIdRef.current = tasksRef.current[next]?.taskId;
      logOffsetRef.current = 0;
      setLogText("");
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
      <Text dimColor>{runningCount} running · {finishedCount} finished · {view === "actions" ? "↑↓ select action · Enter run · Esc back" : "Select a task · ↑↓ navigate · Enter actions · x stop · r refresh · Esc close"}</Text>
      {refreshError && <Text color={C.error}>⚠ Refresh failed: {refreshError}</Text>}
      {actionStatus && <Text color={C.muted}>{actionStatus}</Text>}
      {tasks.length === 0 && <Text dimColor>No background tasks.</Text>}
      {tasks.map((t, i) => {
        const selected = i === selectedIndex;
        const rowColor = selected ? C.running : bgTaskStatusColor(t.status);
        return (
          <Text key={t.taskId} color={rowColor} bold={selected}>
            {selected ? "▶" : " "} {bgTaskStatusGlyph(t.status)} {t.status.padEnd(10)} {t.taskId.slice(0, 8)}  {t.name}{stoppingTaskId === t.taskId ? " · stopping" : ""}
          </Text>
        );
      })}
      {selectedTask && (
        <>
          <Text dimColor>── log tail ({selectedTask.taskId.slice(0, 8)}) ──</Text>
          {logLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </>
      )}
      {view === "actions" && (
        <>
          <Text bold>Task actions · {selectedTask?.name}</Text>
          {TASK_ACTIONS.map((action, index) => (
            <Text key={action} color={index === actionIndex ? C.running : C.muted} bold={index === actionIndex}>
              {index === actionIndex ? "▶" : " "} {action}
            </Text>
          ))}
        </>
      )}
      {view === "send" && <Text>Input: {sendDraft}▌</Text>}
    </Box>
  );
}

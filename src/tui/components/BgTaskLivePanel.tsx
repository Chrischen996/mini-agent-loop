/**
 * BgTaskLivePanel — persistent floating panel for background tasks (Live panel B).
 * Arrow-key selection, inline log tail, `r` refresh.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { BgTaskSummary, LogChunk } from "../../bg-tasks/manager.js";
import { TUI_COLORS as C } from "../theme.ts";

export type BgTaskLivePanelProps = {
  manager: { list(): Promise<BgTaskSummary[]>; logs(taskId: string, offset?: number, limitBytes?: number): Promise<LogChunk>; initialize(): Promise<void> };
  width?: number;
  maxLogLines?: number;
  onClose?: () => void;
};

export function BgTaskLivePanel({ manager, width = 80, maxLogLines = 8, onClose }: BgTaskLivePanelProps): React.ReactElement {
  const [tasks, setTasks] = useState<BgTaskSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [logText, setLogText] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const lastTaskStates = useRef<Map<string, string>>(new Map());

  const selectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  const [logOffset, setLogOffset] = useState(0);

  const refresh = useCallback(async () => {
    try {
      await manager.initialize();
      const list = await manager.list();
      setTasks(list);
      setRefreshError(null);

      // 增量刷新：仅处理状态变化的任务
      const changedIds = new Set<string>();
      for (const t of list) {
        const prevStatus = lastTaskStates.current.get(t.taskId);
        if (prevStatus !== t.status) {
          changedIds.add(t.taskId);
        }
        lastTaskStates.current.set(t.taskId, t.status);
      }
      // 清理已删除任务的状态
      for (const [id] of lastTaskStates.current) {
        if (!list.find(t => t.taskId === id)) {
          lastTaskStates.current.delete(id);
        }
      }

      if (list.length > 0) {
        const idx = Math.min(selectedIndexRef.current, list.length - 1);
        setSelectedIndex(idx);
        const selectedTask = list[idx];
        // 仅在选中任务变化时刷新日志
        if (changedIds.has(selectedTask.taskId) || !logText) {
          const chunk = await manager.logs(selectedTask.taskId, logOffset, 4 * 1024);
          setLogText(chunk.text);
          setLogOffset(chunk.nextOffset);
        }
      } else {
        setLogText("");
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }, [manager, logText]);

  useEffect(() => {
    void refresh();
    // 自适应刷新间隔：运行中 1s，空闲 5s
    const getInterval = () => tasks.some(t => t.status === "running") ? 1000 : 5000;
    const timer = setInterval(() => void refresh(), getInterval());
    return () => clearInterval(timer);
  }, [refresh, refreshKey, tasks]);

  useInput((input, key) => {
    if (key.escape && onClose) {
      onClose();
      return;
    }
    if (input === "r" || input === "R") {
      setRefreshKey((k) => k + 1);
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, tasks.length - 1)));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
  });

  const selectedTask = tasks[selectedIndex];
  const logLines = logText.split("\n").slice(-maxLogLines);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.info} paddingX={1} width={width} minWidth={0}>
      <Text bold color={C.info}>▣ Background tasks — live panel (↑↓ select · r refresh · Esc close)</Text>
      {refreshError && <Text color={C.error}>⚠ Refresh failed: {refreshError}</Text>}
      {tasks.length === 0 && <Text dimColor>No running tasks.</Text>}
      {tasks.map((t, i) => (
        <Text key={t.taskId} color={i === selectedIndex ? C.running : C.muted} bold={i === selectedIndex}>
          {i === selectedIndex ? "▶" : " "} {t.status.padEnd(10)} {t.taskId.slice(0, 8)}  {t.name}
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

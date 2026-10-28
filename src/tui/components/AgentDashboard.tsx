import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { compactText } from "../text-utils.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { PromptInput } from "./PromptInput.tsx";

export type DashboardAgent = {
  id: string;
  name: string;
  status: string;
  task: string;
  activity: string;
  active: boolean;
  failed: boolean;
  startedAt?: number;
  workspace?: string;
  branch?: string;
  setupError?: string;
};

export type AgentDashboardProps = {
  agents: DashboardAgent[];
  activeAgentId: string;
  width: number;
  height: number;
  onClose: () => void;
  onDispatch: (prompt: string, attach: boolean) => void;
  onOpenAgent: (id: string) => void;
  worktreeIsolation: boolean;
  onToggleWorktreeIsolation: () => void;
};

function rowColor(row: DashboardAgent): string {
  if (row.failed) return C.error;
  if (row.active || row.status === "Needs input") return C.running;
  if (row.status === "Completed") return C.success;
  return C.muted;
}

export function AgentDashboard({ agents, activeAgentId, width, height, onClose, onDispatch, onOpenAgent, worktreeIsolation, onToggleWorktreeIsolation }: AgentDashboardProps): React.ReactElement {
  const rows = [...agents].sort((left, right) => Number(right.active) - Number(left.active) || (right.startedAt ?? 0) - (left.startedAt ?? 0));
  const [selectedId, setSelectedId] = useState(activeAgentId);
  const [draft, setDraft] = useState("");
  const matchedIndex = rows.findIndex((row) => row.id === selectedId);
  const selectedIndex = Math.max(0, matchedIndex);
  const selected = rows[selectedIndex];
  const activeCount = rows.filter((row) => row.active).length;
  const visibleCount = Math.max(1, height - 12);
  const visibleStart = Math.min(
    Math.max(0, selectedIndex - visibleCount + 1),
    Math.max(0, rows.length - visibleCount),
  );
  const visibleRows = rows.slice(visibleStart, visibleStart + visibleCount);

  const selectedExists = matchedIndex >= 0;
  const handlePromptControlKey = (input: string, key: { ctrl?: boolean; meta?: boolean }): boolean => {
    if (input === "\u0013" || (key.ctrl && input.toLowerCase() === "s")) {
      if (draft.trim()) {
        onDispatch(draft.trim(), true);
        setDraft("");
      } else if (selected) {
        onOpenAgent(selected.id);
      }
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (!selectedExists) setSelectedId(activeAgentId);
  }, [activeAgentId, selectedExists]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === "\u001c") {
      onClose();
      return;
    }
    if (draft.length === 0 && key.upArrow) {
      setSelectedId(rows[Math.max(0, selectedIndex - 1)]?.id ?? activeAgentId);
      return;
    }
    if (draft.length === 0 && key.downArrow) {
      setSelectedId(rows[Math.min(rows.length - 1, selectedIndex + 1)]?.id ?? activeAgentId);
    }
  });

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      width={width}
      height={height}
      borderStyle="round"
      borderColor={C.info}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold color={C.info}>Agent dashboard</Text>
        <Text dimColor>{activeCount} active · {rows.length} total</Text>
      </Box>
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold color={C.running}>+ New Agent</Text>
        <Text dimColor>Workspace: {worktreeIsolation ? "Worktree" : "Shared"}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {visibleRows.map((row) => (
          <Text key={row.id} backgroundColor={row.id === selected?.id ? C.selection : undefined} color={rowColor(row)} bold={row.id === selected?.id} wrap="truncate-end">
            {row.id === selected?.id ? "▶" : " "} {row.status.padEnd(10)} {row.name}: {compactText(row.setupError ?? row.task, Math.max(12, width - 28), "…", { maxIncludesEllipsis: true })}
          </Text>
        ))}
      </Box>
      {selected && (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor wrap="truncate-end">Task: {compactText(selected.task, Math.max(12, width - 10), "…", { maxIncludesEllipsis: true })}</Text>
          <Text dimColor wrap="truncate-end">Activity: {compactText(selected.activity, Math.max(12, width - 14), "…", { maxIncludesEllipsis: true })}</Text>
          {selected.branch && <Text dimColor wrap="truncate-end">Branch: {compactText(selected.branch, Math.max(12, width - 10), "…", { maxIncludesEllipsis: true })}</Text>}
          {selected.workspace && <Text dimColor wrap="truncate-end">Workspace: {compactText(selected.workspace, Math.max(12, width - 12), "…", { maxIncludesEllipsis: true })}</Text>}
          {selected.setupError && <Text color={C.error} wrap="truncate-end">Setup failed: {compactText(selected.setupError, Math.max(12, width - 15), "…", { maxIncludesEllipsis: true })}</Text>}
        </Box>
      )}
      <Box borderStyle="round" borderColor={C.border} paddingX={1} flexShrink={0}>
        <Text color={C.user} bold>❯ </Text>
        <PromptInput
          value={draft}
          onChange={setDraft}
          onControlKey={handlePromptControlKey}
          onSubmit={(value) => {
            const prompt = value.trim();
            if (prompt.toLowerCase() === "/worktree") {
              onToggleWorktreeIsolation();
              setDraft("");
              return;
            }
            if (prompt) onDispatch(prompt, false);
            else if (selected) onOpenAgent(selected.id);
            setDraft("");
          }}
          disableArrowNavigation
          placeholder="Dispatch a new agent"
        />
      </Box>
      <Text dimColor>Enter dispatches / opens selected · Ctrl+S dispatch + open · /worktree toggles isolation · ↑/↓ select · Esc close</Text>
    </Box>
  );
}

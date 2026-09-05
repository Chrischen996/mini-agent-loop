import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import { TODO_COMMAND_USAGE } from "../todo-commands.ts";
import type { PersistedSessionMeta } from "../../session-store.ts";
import { SESSION_PICKER_HINT } from "../session-serialization.ts";

// ─── Command palette ─────────────────────────────────────────────────────────

export type CommandDef = {
  name: string;       // e.g. "read"
  usage: string;      // e.g. "/read <path>"
  description: string;
};

export const SLASH_COMMANDS: CommandDef[] = [
  { name: "model", usage: "/model [ref] [url] [key]", description: "Switch model and gateway" },
  { name: "profiles", usage: "/profiles", description: "List and activate model profiles" },
  { name: "image", usage: "/image <path>",            description: "Attach a local image" },
  { name: "paste-image", usage: "/paste-image",      description: "Attach an image from the clipboard" },
  { name: "read",  usage: "/read <path>",          description: "Read a file" },
  { name: "bash",  usage: "/bash <cmd>",            description: "Run a shell command" },
  { name: "ls",    usage: "/ls [path]",             description: "List a directory" },
  { name: "find",  usage: "/find <glob> [path]",   description: "Find files by glob" },
  { name: "grep",  usage: "/grep <pattern> [path]", description: "Search file contents" },
  { name: "clear", usage: "/clear",                 description: "Clear the conversation" },
  { name: "sessions", usage: "/sessions",           description: "List saved sessions" },
  { name: "resume", usage: "/resume [id]",          description: "Resume a saved session" },
  { name: "tasks", usage: TODO_COMMAND_USAGE, description: "Show or manage todos" },
  { name: "context", usage: "/context",             description: "Show context and token usage" },
  { name: "plan", usage: "/plan [task]",            description: "Generate an execution plan (plan mode)" },
  { name: "plan-show", usage: "/plan-show",         description: "Show the current plan" },
  { name: "plan-approve", usage: "/plan-approve",   description: "Approve the current plan" },
  { name: "plan-reject", usage: "/plan-reject",     description: "Reject the current plan" },
  { name: "plan-run", usage: "/plan-run",           description: "Run the approved plan" },
  { name: "plan-retry", usage: "/plan-retry",       description: "Retry a failed plan" },
  { name: "plan-history", usage: "/plan-history",   description: "List plan history" },
  { name: "plan-archive", usage: "/plan-archive",   description: "Archive the current plan" },
  { name: "copy", usage: "/copy [last|assistant|input|tool|thinking|user]", description: "Copy a message or transcript to the clipboard" },
  { name: "skill", usage: "/skill [on|off|list|clear] [name]", description: "Manage session skills" },
  { name: "skills", usage: "/skills [on|off|list|clear] [name]", description: "Manage session skills" },
  { name: "help",  usage: "/help",                  description: "Show help" },
  { name: "exit",  usage: "/exit",                  description: "Exit" },
  { name: "quit",  usage: "/quit",                  description: "Exit" },
];

type CommandPaletteProps = {
  filter: string;         // what the user typed after /
  selectedIndex: number;
  candidates: CommandDef[];
  maxVisible?: number;
  width?: number;
};

function visibleWindow<T>(items: T[], selectedIndex: number, maxVisible: number): { visible: T[]; start: number } {
  const count = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - count + 1, items.length - count));
  return { visible: items.slice(start, start + count), start };
}

export function CommandPalette({ filter, selectedIndex, candidates, maxVisible = 6, width }: CommandPaletteProps): React.ReactElement | null {
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Commands /{filter}</Text>
      {candidates.length === 0 && <Text color={C.running} wrap="truncate-end">No matching commands</Text>}
      {visible.map((cmd, i) => {
        const index = start + i;
        return (
        <Box key={cmd.name} gap={1} minWidth={0}>
          <Text color={index === selectedIndex ? C.running : undefined} bold={index === selectedIndex}>
            {index === selectedIndex ? "▶" : " "}
          </Text>
          <Text color={index === selectedIndex ? C.assistant : C.muted} bold={index === selectedIndex} wrap="truncate-end">
            {cmd.usage}
          </Text>
          <Text dimColor wrap="truncate-end">{cmd.description}</Text>
        </Box>
        );
      })}
      <Text dimColor wrap="truncate-end">Tab/Enter select  ↑↓ navigate  Esc close</Text>
    </Box>
  );
}

type SessionPaletteProps = {
  sessions: PersistedSessionMeta[];
  selectedIndex: number;
  command: "resume" | "sessions";
  loading: boolean;
  maxVisible?: number;
  width?: number;
};

export function SessionPalette({ sessions, selectedIndex, command, loading, maxVisible = 6, width }: SessionPaletteProps): React.ReactElement {
  const { visible, start } = visibleWindow(sessions, selectedIndex, maxVisible);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {command === "resume" ? "Resume sessions" : "Saved sessions"}</Text>
      {loading && <Text dimColor wrap="truncate-end">Loading saved sessions...</Text>}
      {!loading && sessions.length === 0 && <Text color={C.running} wrap="truncate-end">No saved sessions</Text>}
      {!loading && visible.map((session, index) => {
        const absoluteIndex = start + index;
        const preview = session.preview.replace(/\s+/g, " ").trim();
        return (
          <Box key={session.id} gap={1} minWidth={0}>
            <Text color={absoluteIndex === selectedIndex ? C.running : undefined} bold={absoluteIndex === selectedIndex}>
              {absoluteIndex === selectedIndex ? "▶" : " "}
            </Text>
            <Text color={absoluteIndex === selectedIndex ? C.assistant : C.muted} bold={absoluteIndex === selectedIndex} wrap="truncate-end">
              {session.id.slice(0, 12)}  {session.messageCount} msgs{preview ? `  ${preview}` : ""}
            </Text>
          </Box>
        );
      })}
      {!loading && sessions.length > visible.length && (
        <Text dimColor wrap="truncate-end">
          Showing {start + 1}-{start + visible.length} / {sessions.length}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {SESSION_PICKER_HINT}
      </Text>
    </Box>
  );
}

// ─── File autocomplete ────────────────────────────────────────────────────────

type FileAutocompleteProps = {
  candidates: string[];
  selectedIndex: number;
  prefix: string;
  maxVisible?: number;
  width?: number;
};

export function FileAutocomplete({ candidates, selectedIndex, prefix, maxVisible = 8, width }: FileAutocompleteProps): React.ReactElement | null {
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Files {prefix}</Text>
      {candidates.length === 0 && <Text color={C.running} wrap="truncate-end">No matching files</Text>}
      {visible.map((candidate, i) => {
        const index = start + i;
        return (
        <Box key={candidate} gap={1} minWidth={0}>
          <Text color={index === selectedIndex ? C.running : undefined} bold={index === selectedIndex}>
            {index === selectedIndex ? "▶" : " "}
          </Text>
          <Text
            color={index === selectedIndex ? C.assistant : C.muted}
            bold={index === selectedIndex}
            wrap="truncate-end"
          >
            {candidate}
          </Text>
        </Box>
        );
      })}
      {candidates.length > visible.length && <Text dimColor wrap="truncate-end">Showing {start + 1}-{start + visible.length} / {candidates.length}</Text>}
      <Text dimColor wrap="truncate-end">Tab/→ complete  ↑↓ navigate  Esc close</Text>
    </Box>
  );
}

type ModelPickerProps = {
  candidates: string[];
  contextWindows: Record<string, number>;
  selectedIndex: number;
  query: string;
  current: string;
  maxVisible?: number;
  width?: number;
};

export function formatContextWindow(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024) * 10) / 10}M`;
  if (value >= 1024) return `${Math.round(value / 1024)}K`;
  return String(value);
}

export function ModelPicker({ candidates, contextWindows, selectedIndex, query, current, maxVisible = 12, width }: ModelPickerProps): React.ReactElement | null {
  const pageSize = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, candidates.length - pageSize));
  const visible = candidates.slice(start, start + pageSize);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Models {query || "all"}</Text>
      {visible.length === 0 && <Text color={C.running} wrap="truncate-end">No matching models</Text>}
      {visible.map((model, i) => {
        const index = start + i;
        return (
        <Box key={model} gap={1} minWidth={0}>
          <Text color={index === selectedIndex ? C.running : undefined} bold={index === selectedIndex}>{index === selectedIndex ? "▶" : " "}</Text>
          <Text color={index === selectedIndex ? C.assistant : C.muted} bold={index === selectedIndex} wrap="truncate-end">
            {model === current ? "✓ " : "  "}{model}
          </Text>
          <Text dimColor wrap="truncate-end">{formatContextWindow(contextWindows[model] ?? 0)} context</Text>
        </Box>
        );
      })}
      {candidates.length > pageSize && (
        <Text dimColor wrap="truncate-end">Showing {start + 1}-{Math.min(start + pageSize, candidates.length)} / {candidates.length}</Text>
      )}
      <Text dimColor wrap="truncate-end">Enter select  ↑↓ navigate  Esc cancel</Text>
    </Box>
  );
}

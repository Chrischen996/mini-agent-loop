import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

// ─── Command palette ─────────────────────────────────────────────────────────

export type CommandDef = {
  name: string;       // e.g. "read"
  usage: string;      // e.g. "/read <path>"
  description: string;
};

export const SLASH_COMMANDS: CommandDef[] = [
  { name: "model", usage: "/model [ref] [--base-url URL] [--api-key-env ENV]", description: "切换模型和网关" },
  { name: "image", usage: "/image <path>",            description: "添加本地图片" },
  { name: "paste-image", usage: "/paste-image",      description: "添加剪贴板图片" },
  { name: "read",  usage: "/read <path>",          description: "读取文件内容" },
  { name: "bash",  usage: "/bash <cmd>",            description: "执行 Shell 命令" },
  { name: "ls",    usage: "/ls [path]",             description: "列出目录" },
  { name: "find",  usage: "/find <glob> [path]",   description: "按 glob 查找文件" },
  { name: "grep",  usage: "/grep <pattern> [path]", description: "搜索文件内容" },
  { name: "clear", usage: "/clear",                 description: "清空对话" },
  { name: "help",  usage: "/help",                  description: "显示帮助" },
  { name: "exit",  usage: "/exit",                  description: "退出" },
];

type CommandPaletteProps = {
  filter: string;         // what the user typed after /
  selectedIndex: number;
  candidates: CommandDef[];
  maxVisible?: number;
};

function visibleWindow<T>(items: T[], selectedIndex: number, maxVisible: number): { visible: T[]; start: number } {
  const count = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - count + 1, items.length - count));
  return { visible: items.slice(start, start + count), start };
}

export function CommandPalette({ filter, selectedIndex, candidates, maxVisible = 6 }: CommandPaletteProps): React.ReactElement | null {
  if (candidates.length === 0) return null;
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 命令 /{filter} ──────────────</Text>
      {visible.map((cmd, i) => {
        const index = start + i;
        return (
        <Box key={cmd.name} gap={2}>
          <Text color={index === selectedIndex ? C.selection : undefined}>
            {index === selectedIndex ? "▶" : " "}
          </Text>
          <Text color={index === selectedIndex ? C.assistant : C.muted} bold={index === selectedIndex}>
            {cmd.usage}
          </Text>
          <Text dimColor>{cmd.description}</Text>
        </Box>
        );
      })}
      <Text dimColor>Tab/Enter 选中  ↑↓ 导航  Esc 关闭</Text>
    </Box>
  );
}

// ─── File autocomplete ────────────────────────────────────────────────────────

type FileAutocompleteProps = {
  candidates: string[];
  selectedIndex: number;
  prefix: string;
  maxVisible?: number;
};

export function FileAutocomplete({ candidates, selectedIndex, prefix, maxVisible = 8 }: FileAutocompleteProps): React.ReactElement | null {
  if (candidates.length === 0) return null;
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 文件 {prefix} ──────────────</Text>
      {visible.map((candidate, i) => {
        const index = start + i;
        return (
        <Box key={candidate} gap={1}>
          <Text color={index === selectedIndex ? C.selection : undefined}>
            {index === selectedIndex ? "▶" : " "}
          </Text>
          <Text
            color={index === selectedIndex ? C.assistant : C.muted}
            bold={index === selectedIndex}
          >
            {candidate}
          </Text>
        </Box>
        );
      })}
      {candidates.length > visible.length && <Text dimColor>显示 {start + 1}-{start + visible.length} / {candidates.length}</Text>}
      <Text dimColor>Tab/→ 补全  ↑↓ 导航  Esc 关闭</Text>
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
};

export function formatContextWindow(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024) * 10) / 10}M`;
  if (value >= 1024) return `${Math.round(value / 1024)}K`;
  return String(value);
}

export function ModelPicker({ candidates, contextWindows, selectedIndex, query, current, maxVisible = 12 }: ModelPickerProps): React.ReactElement | null {
  const pageSize = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, candidates.length - pageSize));
  const visible = candidates.slice(start, start + pageSize);
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 模型 {query || "全部"} ──────────────</Text>
      {visible.length === 0 && <Text color={C.running}>没有匹配的模型</Text>}
      {visible.map((model, i) => {
        const index = start + i;
        return (
        <Box key={model} gap={1}>
          <Text color={index === selectedIndex ? C.selection : undefined}>{index === selectedIndex ? "▶" : " "}</Text>
          <Text color={index === selectedIndex ? C.assistant : C.muted} bold={index === selectedIndex}>
            {model === current ? "✓ " : "  "}{model}
          </Text>
          <Text dimColor>{formatContextWindow(contextWindows[model] ?? 0)} context</Text>
        </Box>
        );
      })}
      {candidates.length > pageSize && (
        <Text dimColor>显示 {start + 1}-{Math.min(start + pageSize, candidates.length)} / {candidates.length}</Text>
      )}
      <Text dimColor>Enter 选择  ↑↓ 导航  Esc 取消</Text>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";

// ─── Command palette ─────────────────────────────────────────────────────────

export type CommandDef = {
  name: string;       // e.g. "read"
  usage: string;      // e.g. "/read <path>"
  description: string;
};

export const SLASH_COMMANDS: CommandDef[] = [
  { name: "model", usage: "/model [ref]", description: "切换模型" },
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
};

export function CommandPalette({ filter, selectedIndex, candidates }: CommandPaletteProps): React.ReactElement | null {
  if (candidates.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 命令 /{filter} ──────────────</Text>
      {candidates.map((cmd, i) => (
        <Box key={cmd.name} gap={2}>
          <Text color={i === selectedIndex ? "cyan" : undefined}>
            {i === selectedIndex ? "▶" : " "}
          </Text>
          <Text color={i === selectedIndex ? "white" : "gray"} bold={i === selectedIndex}>
            {cmd.usage}
          </Text>
          <Text dimColor>{cmd.description}</Text>
        </Box>
      ))}
      <Text dimColor>Tab/Enter 选中  ↑↓ 导航  Esc 关闭</Text>
    </Box>
  );
}

// ─── File autocomplete ────────────────────────────────────────────────────────

type FileAutocompleteProps = {
  candidates: string[];
  selectedIndex: number;
  prefix: string;
};

export function FileAutocomplete({ candidates, selectedIndex, prefix }: FileAutocompleteProps): React.ReactElement | null {
  if (candidates.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 文件 {prefix} ──────────────</Text>
      {candidates.slice(0, 8).map((candidate, i) => (
        <Box key={candidate} gap={1}>
          <Text color={i === selectedIndex ? "cyan" : undefined}>
            {i === selectedIndex ? "▶" : " "}
          </Text>
          <Text
            color={i === selectedIndex ? "white" : "gray"}
            bold={i === selectedIndex}
          >
            {candidate}
          </Text>
        </Box>
      ))}
      {candidates.length > 8 && (
        <Text dimColor>  … {candidates.length - 8} more</Text>
      )}
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
};

export function formatContextWindow(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024) * 10) / 10}M`;
  if (value >= 1024) return `${Math.round(value / 1024)}K`;
  return String(value);
}

export function ModelPicker({ candidates, contextWindows, selectedIndex, query, current }: ModelPickerProps): React.ReactElement | null {
  const pageSize = 12;
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, candidates.length - pageSize));
  const visible = candidates.slice(start, start + pageSize);
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>── 模型 {query || "全部"} ──────────────</Text>
      {visible.length === 0 && <Text color="yellow">没有匹配的已认证模型</Text>}
      {visible.map((model, i) => {
        const index = start + i;
        return (
        <Box key={model} gap={1}>
          <Text color={index === selectedIndex ? "cyan" : undefined}>{index === selectedIndex ? "▶" : " "}</Text>
          <Text color={index === selectedIndex ? "white" : "gray"} bold={index === selectedIndex}>
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

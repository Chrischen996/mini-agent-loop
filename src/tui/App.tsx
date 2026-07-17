import React, { useReducer, useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { readdir, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { MessageFeed } from "./components/MessageFeed.tsx";
import {
  FileAutocomplete,
  CommandPalette,
  formatContextWindow,
  ModelPicker,
  SLASH_COMMANDS,
  type CommandDef,
} from "./components/FileAutocomplete.tsx";
import { tuiReducer, createInitialState } from "./state.ts";
import {
  createAgentHistory,
  runAgentTurn,
  type LoopEvent,
} from "../loop.ts";
import { loadLlmConfigFromEnv, switchLlmModel, type LlmConfig } from "../llm.ts";
import { findExactModelReferenceMatch, getAvailableModels } from "../models.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createAllTools, createDefaultTools } from "../tools/index.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentMessage, MessageContent } from "../types.ts";

type AppProps = { cwd: string };

function modelChoices(query = "", models = getAvailableModels()): {
  references: string[];
  contextWindows: Record<string, number>;
} {
  const filtered = models.filter((model) =>
    `${model.provider}/${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return {
    references: filtered.map((model) => `${model.provider}/${model.id}`),
    contextWindows: Object.fromEntries(
      filtered.map((model) => [`${model.provider}/${model.id}`, model.contextWindow]),
    ),
  };
}

// ─── slash command parser ────────────────────────────────────────────────────

type SlashCommand =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | null;

function parseSlashCommand(input: string): SlashCommand {
  const s = input.trim();
  if (!s.startsWith("/")) return null;
  const parts = s.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  switch (cmd) {
    case "read": { const path = parts.slice(1).join(" "); return path ? { cmd: "read", path } : null; }
    case "bash": case "sh": { const command = parts.slice(1).join(" "); return command ? { cmd: "bash", command } : null; }
    case "ls": return { cmd: "ls", path: parts[1] ?? "." };
    case "find": return { cmd: "find", pattern: parts[1] ?? "*", path: parts[2] ?? "." };
    case "grep": { const pattern = parts[1] ?? ""; const path = parts[2] ?? "."; return pattern ? { cmd: "grep", pattern, path } : null; }
    default: return null;
  }
}

// Commands that accept a path argument (trigger file autocomplete after selection)
const PATH_COMMANDS = new Set(["read", "ls", "find", "grep"]);

// ─── autocomplete modes ──────────────────────────────────────────────────────

type AcMode = "command" | "file" | "model" | "model-picker" | null;

type FileAcTrigger = {
  fragment: string;
  replaceFn: (chosen: string) => string;
};

function extractFileAcTrigger(input: string): FileAcTrigger | null {
  // @file reference at end
  const atMatch = input.match(/@([\w./\\-]*)$/);
  if (atMatch) {
    const fragment = atMatch[1];
    return { fragment, replaceFn: (chosen) => input.replace(/@[\w./\\-]*$/, `@${chosen}`) };
  }
  // /read <path> or /ls <path> at end
  const slashMatch = input.match(/^\/(read|ls|find|grep)\s+([\w./\\-]*)$/i);
  if (slashMatch) {
    const cmd = slashMatch[1];
    const fragment = slashMatch[2];
    return { fragment, replaceFn: (chosen) => input.replace(/(\/(?:read|ls|find|grep)\s+)[\w./\\-]*$/i, `/${cmd} ${chosen}`) };
  }
  return null;
}

// ─── file listing ────────────────────────────────────────────────────────────

async function listCandidates(cwd: string, fragment: string): Promise<string[]> {
  try {
    const lastSlash = fragment.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fragment.slice(0, lastSlash + 1) : "";
    const prefix = lastSlash >= 0 ? fragment.slice(lastSlash + 1) : fragment;
    const absDir = nodePath.join(cwd, dir || ".");
    let entries: string[];
    try { entries = await readdir(absDir); } catch { return []; }
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      if (entry.startsWith(".") && !prefix.startsWith(".")) continue;
      const rel = dir + entry;
      try {
        const info = await stat(nodePath.join(cwd, rel));
        candidates.push(info.isDirectory() ? `${rel}/` : rel);
      } catch { candidates.push(rel); }
    }
    return candidates.slice(0, 20);
  } catch { return []; }
}

// ─── @file resolver ──────────────────────────────────────────────────────────

function parseAtRefs(input: string): string[] {
  const matches = input.match(/@([\w./\\-]+)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

// ─── main app ────────────────────────────────────────────────────────────────

export function App({ cwd }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const vision = loadVisionConfigFromEnv();
  const allToolsRef = useRef<Tool[]>(createAllTools(cwd));
  const agentToolsRef = useRef<Tool[]>(createDefaultTools(cwd));

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  const [input, setInput] = useState("");
  const historyRef = useRef<AgentMessage[]>(createAgentHistory());
  const abortRef = useRef<AbortController>(new AbortController());

  // ── autocomplete state ───────────────────────────────────────────────────
  const [acMode, setAcMode] = useState<AcMode>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [cmdCandidates, setCmdCandidates] = useState<CommandDef[]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState("");
  const [fileFragment, setFileFragment] = useState("");
  const fileTriggerRef = useRef<FileAcTrigger | null>(null);
  const acDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAc = useCallback(() => {
    setAcMode(null);
    setCmdCandidates([]);
    setFileCandidates([]);
    setModelCandidates([]);
    setModelContextWindows({});
    setModelQuery("");
    setFileFragment("");
    fileTriggerRef.current = null;
    setAcIndex(0);
  }, []);

  // Watch input → update autocomplete
  useEffect(() => {
    if (acDebounceRef.current) clearTimeout(acDebounceRef.current);

    if (acMode === "model-picker") {
      const choices = modelChoices(input);
      setModelQuery(input);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex((index) => Math.min(index, Math.max(0, choices.references.length - 1)));
      return;
    }

    // Command palette: input starts with / and no space yet
    if (/^\/[^/\s]*$/.test(input)) {
      const typed = input.slice(1).toLowerCase();
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
      setCmdCandidates(matches);
      setFileCandidates([]);
      setAcMode(matches.length > 0 ? "command" : null);
      setAcIndex(0);
      return;
    }

    const modelTrigger = input.match(/^\/model(?:\s+(.*))?$/i);
    if (modelTrigger) {
      const query = modelTrigger[1] ?? "";
      const choices = modelChoices(query);
      setModelQuery(query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setCmdCandidates([]);
      setFileCandidates([]);
      setAcMode("model");
      setAcIndex(0);
      return;
    }

    // File autocomplete: @ref or /cmd <path>
    const fileTrigger = extractFileAcTrigger(input);
    if (fileTrigger) {
      fileTriggerRef.current = fileTrigger;
      setFileFragment(fileTrigger.fragment);
      setCmdCandidates([]);
      acDebounceRef.current = setTimeout(async () => {
        const candidates = await listCandidates(cwd, fileTrigger.fragment);
        setFileCandidates(candidates);
        setAcMode(candidates.length > 0 ? "file" : null);
        setAcIndex(0);
      }, 150);
      return;
    }

    // No trigger → clear
    clearAc();

    return () => { if (acDebounceRef.current) clearTimeout(acDebounceRef.current); };
  }, [input, cwd, clearAc, acMode]);

  // Accept command candidate
  const acceptCommand = useCallback((idx: number) => {
    const cmd = cmdCandidates[idx];
    if (!cmd) return;
    if (PATH_COMMANDS.has(cmd.name)) {
      // Expand command and leave cursor after the space for path input
      setInput(`/${cmd.name} `);
      // File autocomplete will trigger on next render because of /read + space
    } else {
      setInput(`/${cmd.name}`);
      clearAc();
    }
    setAcMode(null);
    setCmdCandidates([]);
    setAcIndex(0);
  }, [cmdCandidates, clearAc]);

  // Accept file candidate
  const acceptFile = useCallback((idx: number) => {
    const trigger = fileTriggerRef.current;
    const chosen = fileCandidates[idx];
    if (!trigger || !chosen) return;
    setInput(trigger.replaceFn(chosen));
    clearAc();
  }, [fileCandidates, clearAc]);

  const openModelPicker = useCallback((query = "") => {
    const choices = modelChoices(query);
    setModelQuery(query);
    setModelCandidates(choices.references);
    setModelContextWindows(choices.contextWindows);
    setAcIndex(0);
    setInput(query);
    setAcMode("model-picker");
  }, []);

  const selectModel = useCallback((reference: string) => {
    const match = findExactModelReferenceMatch(reference, getAvailableModels());
    if (!match) {
      const choices = modelChoices();
      setModelQuery(reference);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex(0);
      setInput(reference);
      setAcMode("model-picker");
      return;
    }
    if (match.ambiguous || !match.model) {
      const choices = modelChoices("", match.matches);
      setModelQuery(reference);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex(0);
      setInput(reference);
      setAcMode("model-picker");
      return;
    }
    try {
      setLlm((current) => switchLlmModel(current, match.model!));
      dispatch({ type: "MODEL_CHANGED", modelName: match.model.id });
      setInput("");
      clearAc();
    } catch (error) {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "model", name: "model", arguments: {} }, result: { content: error instanceof Error ? error.message : String(error), isError: true } } });
      clearAc();
    }
  }, [clearAc]);

  // ── keyboard handler ─────────────────────────────────────────────────────

  useInput((_ch: string, key: Key) => {
    if (key.ctrl && _ch === "c") { abortRef.current.abort(); exit(); return; }

    if (acMode === "command") {
      const len = cmdCandidates.length;
      if (key.upArrow)   { setAcIndex((i) => (i - 1 + len) % len); return; }
      if (key.downArrow) { setAcIndex((i) => (i + 1) % len); return; }
      if (key.tab)       { acceptCommand(acIndex); return; }
      if (key.escape)    { clearAc(); return; }
      return;
    }

    if (acMode === "file") {
      const len = fileCandidates.length;
      if (key.upArrow)   { setAcIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setAcIndex((i) => Math.min(len - 1, i + 1)); return; }
      if (key.tab || key.rightArrow) { acceptFile(acIndex); return; }
      if (key.escape)    { clearAc(); return; }
    }

    if (acMode === "model" || acMode === "model-picker") {
      const len = modelCandidates.length;
      if (key.upArrow && len > 0) { setAcIndex((i) => (i - 1 + len) % len); return; }
      if (key.downArrow && len > 0) { setAcIndex((i) => (i + 1) % len); return; }
      if (key.tab) {
        const chosen = modelCandidates[acIndex];
        if (chosen) { setInput(`/model ${chosen}`); clearAc(); }
        return;
      }
      if (key.escape) { setInput(""); clearAc(); return; }
    }
  });

  // ── direct tool invocation ────────────────────────────────────────────────

  const runDirectTool = useCallback(async (toolName: string, args: Record<string, unknown>) => {
    const tool = allToolsRef.current.find((t) => t.name === toolName);
    const fakeCall = { id: `direct-${Date.now()}`, name: toolName, arguments: args };
    if (!tool) {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result: { content: `Unknown tool: ${toolName}`, isError: true } } });
      return;
    }
    dispatch({ type: "LOOP_EVENT", event: { type: "tool_start", call: fakeCall } });
    try {
      const result = await tool.execute(args, undefined);
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result } });
    } catch (err) {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result: { content: err instanceof Error ? err.message : String(err), isError: true } } });
    }
  }, []);

  // ── @file resolver ────────────────────────────────────────────────────────

  const resolveAtRefs = useCallback(async (text: string): Promise<MessageContent> => {
    const paths = parseAtRefs(text);
    if (paths.length === 0) return text;
    const readTool = allToolsRef.current.find((t) => t.name === "read");
    if (!readTool) return text;
    const parts: MessageContent = [{ type: "text", text }];
    for (const p of paths) {
      try {
        const result = await readTool.execute({ path: p }, undefined);
        const content = typeof result.content === "string" ? result.content : "";
        parts.push({ type: "text", text: `\n\n[File: ${p}]\n\`\`\`\n${content}\n\`\`\`` });
      } catch { /* skip */ }
    }
    return parts;
  }, []);

  // ── submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return;

    clearAc();

    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/clear") {
      historyRef.current = createAgentHistory();
      dispatch({ type: "RESET" });
      setInput("");
      return;
    }
    if (trimmed === "/help" || trimmed === "/?") {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "help", name: "help", arguments: {} }, result: { content: SLASH_COMMANDS.map((c) => `${c.usage.padEnd(28)} ${c.description}`).join("\n"), isError: false } } });
      setInput("");
      return;
    }

    if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
      const reference = trimmed.replace(/^\/model\s*/i, "").trim();
      if (!reference) {
        setInput("");
        openModelPicker();
      } else {
        const match = findExactModelReferenceMatch(reference, getAvailableModels());
        if (match?.model && !match.ambiguous) selectModel(match.model.id);
        else openModelPicker(reference);
      }
      return;
    }

    // Slash commands → direct tool
    const slashCmd = parseSlashCommand(trimmed);
    if (slashCmd) {
      setInput("");
      dispatch({ type: "USER_MESSAGE", text: trimmed });
      switch (slashCmd.cmd) {
        case "read": await runDirectTool("read", { path: slashCmd.path }); break;
        case "bash": await runDirectTool("bash", { command: slashCmd.command }); break;
        case "ls":   await runDirectTool("ls",   { path: slashCmd.path }); break;
        case "find": await runDirectTool("find", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
        case "grep": await runDirectTool("grep", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
      }
      dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
      return;
    }

    // Normal LLM message
    setInput("");
    dispatch({ type: "USER_MESSAGE", text: trimmed });
    abortRef.current = new AbortController();
    try {
      const userContent = await resolveAtRefs(trimmed);
      historyRef.current = await runAgentTurn(historyRef.current, trimmed, {
        llm, tools: agentToolsRef.current,
        preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        signal: abortRef.current.signal,
        userContent,
        onEvent: (event: LoopEvent) => { dispatch({ type: "LOOP_EVENT", event }); },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "llm-error", name: "llm", arguments: {} }, result: { content: errMsg, isError: true } } });
      dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
    }
  }, [state.busy, llm, vision, exit, runDirectTool, resolveAtRefs, clearAc]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={2}>
        <Text color="cyan" bold>mini-agent</Text>
        {state.busy
          ? <Box gap={1}><Text color="yellow"><Spinner type="dots" /></Text><Text dimColor>{state.status}</Text></Box>
          : <Text dimColor>{state.status}</Text>
        }
        <Text dimColor>[/help] [Ctrl+C]</Text>
      </Box>
      <Text dimColor>{"─".repeat(termWidth)}</Text>

      <MessageFeed messages={state.messages} streamingText={state.streamingText} />

      <Text dimColor>{"─".repeat(termWidth)}</Text>

      {/* Command palette */}
      {acMode === "command" && (
        <CommandPalette
          filter={input.slice(1)}
          selectedIndex={acIndex}
          candidates={cmdCandidates}
        />
      )}

      {/* File autocomplete */}
      {acMode === "file" && (
        <FileAutocomplete
          candidates={fileCandidates}
          selectedIndex={acIndex}
          prefix={fileFragment}
        />
      )}

      {(acMode === "model" || acMode === "model-picker") && (
        <ModelPicker
          candidates={modelCandidates}
          contextWindows={modelContextWindows}
          selectedIndex={acIndex}
          query={modelQuery}
          current={`${llm.provider}/${llm.model}`}
        />
      )}

      {/* Input row */}
      <Box paddingX={1} gap={1}>
        <Text color="green" bold>{state.busy ? "…" : ">"}</Text>
        <Box flexGrow={1}>
          {state.busy
            ? <Text dimColor>等待中...</Text>
            : (
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={(val) => {
                  if ((acMode === "model" || acMode === "model-picker") && modelCandidates[acIndex]) {
                    selectModel(modelCandidates[acIndex]!);
                  } else {
                    void handleSubmit(val);
                  }
                }}
                placeholder={acMode === "model-picker" ? "搜索模型" : "输入消息，/ 命令，或 @文件 引用"}
              />
            )
          }
        </Box>
        <Text dimColor>{state.modelName} · {state.usedTokens > 0 ? `${formatContextWindow(state.usedTokens)} / ` : ""}{formatContextWindow(llm.contextWindow)}</Text>
      </Box>
    </Box>
  );
}

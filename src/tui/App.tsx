import React, { useReducer, useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
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
  MaxTurnsExceededError,
  runAgentTurn,
  type LoopEvent,
} from "../loop.ts";
import { loadLlmConfigFromEnv, switchLlmModel, type LlmConfig, type ModelSwitchOverrides } from "../llm/index.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import { findExactModelReferenceMatch, getAllModels, resolveModel, searchModels, type ModelRef } from "../models.ts";
import {
  activateProfile,
  listProfiles,
  loadProfileStore,
  removeProfile,
  saveProfile,
  type ModelProfileStore,
} from "../profile-store.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createAllTools, createTools } from "../tools/index.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../tools/types.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import { createMcpApprovalGate, mcpAutoApproveFromEnv } from "../mcp/approval.ts";
import { createSubagentTool } from "../subagent/index.ts";
import type { SubagentEvent, SubagentProfile } from "../subagent/types.ts";

const DEFAULT_SUBAGENT_PROFILES: SubagentProfile[] = [
  {
    name: "researcher",
    description: "Reads, searches, and analyzes files to gather information and answer questions",
    systemPrompt: [
      "You are a research assistant. Your job is to gather information from the workspace.",
      "Read files, search for patterns, and list directories to find relevant information.",
      "Summarize your findings clearly and concisely. Include file paths and line numbers when citing code.",
      "Do not modify any files. Only read and analyze.",
    ].join("\n"),
    allowedTools: ["read", "grep", "find", "ls", "bash", "codebase_open", "codebase_search", "codebase_read"],
    maxTurns: 8,
  },
  {
    name: "coder",
    description: "Writes, edits, and creates code files based on specifications",
    systemPrompt: [
      "You are a coding assistant. Write clean, well-structured code.",
      "Read existing files first to understand the codebase style and conventions.",
      "Use `edit` for small changes and `write` for new files or complete rewrites.",
      "Always verify your changes compile or pass basic sanity checks when possible.",
    ].join("\n"),
    allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    maxTurns: 10,
  },
  {
    name: "reviewer",
    description: "Reviews code quality, finds bugs, and suggests improvements",
    systemPrompt: [
      "You are a code reviewer. Analyze the given code for:",
      "- Bugs and logic errors",
      "- Code style and consistency issues",
      "- Performance concerns",
      "- Security vulnerabilities",
      "- Missing error handling",
      "Provide specific, actionable feedback with file paths and line numbers.",
      "Do not modify any files. Only read and analyze.",
    ].join("\n"),
    allowedTools: ["read", "grep", "find", "ls"],
    maxTurns: 6,
  },
];

type AppProps = { cwd: string; agentTools?: ToolProvider; allTools?: ToolProvider };

function modelChoices(query = "", models = getAllModels()): {
  references: string[];
  contextWindows: Record<string, number>;
} {
  const filtered = query.trim() ? searchModels(query, models) : models;
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

type ModelCommand = {
  reference: string;
  overrides: ModelSwitchOverrides;
};

function parseModelCommand(raw: string): ModelCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const referenceParts: string[] = [];
  const overrides: ModelSwitchOverrides = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--base-url") {
      overrides.baseUrl = tokens[++index];
    } else if (token === "--api-key") {
      overrides.apiKey = tokens[++index];
    } else if (token === "--api-key-env") {
      const envName = tokens[++index];
      if (envName) overrides.apiKey = process.env[envName];
    } else {
      referenceParts.push(token);
    }
  }
  return { reference: referenceParts.join(" "), overrides };
}

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

type AcMode = "command" | "file" | "model" | "model-picker" | "model-setup" | "profile-name" | "profile-list" | null;

type ModelSetupState = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
  field: "baseUrl" | "apiKey";
  error?: string;
};

type ProfileListState = {
  profiles: ReturnType<typeof listProfiles>;
  selectedIndex: number;
};

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

export function App({ cwd, agentTools, allTools }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const vision = loadVisionConfigFromEnv();
  const allToolsRef = useRef<ToolProvider>(allTools ?? createAllTools(cwd));
  const agentToolsRef = useRef<ToolProvider>(agentTools ?? createTools(cwd, { codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0" }));

  // Create the subagent tool — dispatches SubagentEvents to the TUI reducer
  const subagentToolRef = useRef<Tool | null>(null);
  const getSubagentTool = useCallback((): Tool => {
    if (!subagentToolRef.current) {
      subagentToolRef.current = createSubagentTool({
        parentLlm: llm,
        parentTools: agentToolsRef.current,
        profiles: DEFAULT_SUBAGENT_PROFILES,
        preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        onSubagentEvent: (event: SubagentEvent) => {
          dispatch({ type: "SUBAGENT_EVENT", event });
        },
      }) as Tool;
    }
    return subagentToolRef.current;
  }, [llm, vision]);

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  const [input, setInput] = useState("");
  const historyRef = useRef<AgentMessage[]>(createAgentHistory());
  const abortRef = useRef<AbortController>(new AbortController());
  // Profile state
  const [pendingProfileSetup, setPendingProfileSetup] = useState<{ model: ModelRef; baseUrl: string; apiKey: string } | null>(null);
  const [profileListState, setProfileListState] = useState<ProfileListState | null>(null);
  const [profileStore, setProfileStore] = useState<ModelProfileStore | null>(null);
  // ink-text-input still receives the same keystroke as useInput; after Ctrl/Alt+T
  // it may append "t" (or a control char). Swallow that one onChange tick.
  const suppressInputEchoRef = useRef(false);

  // Throttle assistant_delta events to reduce TUI flicker during streaming.
  // Buffer deltas and flush every 50ms instead of dispatching each token immediately.
  const deltaBufferRef = useRef<{ text: string; kind: "reasoning" | "answer" }>({ text: "", kind: "answer" });
  const deltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup delta timer on unmount
  useEffect(() => {
    return () => {
      if (deltaTimerRef.current) {
        clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = null;
      }
    };
  }, []);

  const setInputSafe = useCallback((value: string) => {
    if (suppressInputEchoRef.current) {
      suppressInputEchoRef.current = false;
      return;
    }
    // Drop control characters that terminals may inject with Ctrl/Alt combos.
    setInput(value.replace(/[\u0000-\u001F\u007F]/g, ""));
  }, []);

  // ── autocomplete state ───────────────────────────────────────────────────
  const [acMode, setAcMode] = useState<AcMode>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [cmdCandidates, setCmdCandidates] = useState<CommandDef[]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState("");
  const [modelSetup, setModelSetup] = useState<ModelSetupState | undefined>();
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
    setModelSetup(undefined);
    setFileFragment("");
    fileTriggerRef.current = null;
    setAcIndex(0);
    setPendingProfileSetup(null);
    setProfileListState(null);
  }, []);

  // Load profile store on mount
  useEffect(() => {
    loadProfileStore().then(setProfileStore).catch(() => { /* non-fatal */ });
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

    if (acMode === "model-setup") return;

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

  const startModelSetup = useCallback((model: ModelRef, overrides: ModelSwitchOverrides = {}) => {
    const providerKey = model.apiKeyEnv
      .map((name) => process.env[name])
      .find((value): value is string => Boolean(value));
    const canReuseCurrentKey = model.provider === llm.provider && model.baseUrl === llm.baseUrl;
    setModelSetup({
      model,
      baseUrl: overrides.baseUrl || model.baseUrl,
      apiKey: overrides.apiKey ?? (canReuseCurrentKey ? llm.apiKey : providerKey ?? ""),
      field: "baseUrl",
    });
    setInput(overrides.baseUrl || model.baseUrl);
    setAcMode("model-setup");
    setAcIndex(0);
  }, [llm.apiKey, llm.baseUrl, llm.provider]);

  const commitModelSetup = useCallback(async (setup: ModelSetupState, apiKey: string) => {
    try {
      const newLlmConfig = switchLlmModel(llm, setup.model, {
        baseUrl: setup.baseUrl,
        apiKey,
      });
      setLlm(newLlmConfig);
      dispatch({ type: "MODEL_CHANGED", modelName: setup.model.id });

      // Adapt existing conversation history for the new model's capabilities
      if (historyRef.current.length > 1) {
        historyRef.current = adaptHistoryForModel(historyRef.current, {
          targetCapabilities: newLlmConfig.capabilities,
          sourceCapabilities: llm.capabilities,
        });
      }

      setModelSetup(undefined);
      setAcMode(null);
      setInput("");
      // Auto-save as a named profile (fire-and-forget, non-fatal)
      const defaultName = `${setup.model.provider}-${setup.model.id}`
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 40);
      try {
        const updated = await saveProfile(defaultName, {
          model: `${setup.model.provider}/${setup.model.id}`,
          baseUrl: setup.baseUrl,
          apiKey,
        });
        setProfileStore(updated);
      } catch { /* non-fatal: model is already switched in memory */ }
    } catch (error) {
      setModelSetup({ ...setup, apiKey, error: error instanceof Error ? error.message : String(error) });
      setInput(apiKey);
    }
  }, []);

  const openProfileList = useCallback(async () => {
    try {
      const store = await loadProfileStore();
      setProfileStore(store);
      const profiles = listProfiles(store);
      setProfileListState({ profiles, selectedIndex: 0 });
      setAcMode("profile-list");
      setInput("");
    } catch {
      // ignore
    }
  }, []);

  const selectModel = useCallback((reference: string, overrides: ModelSwitchOverrides = {}) => {
    const match = findExactModelReferenceMatch(reference, getAllModels());
    if (!match) {
      // An unknown id is a valid custom OpenAI-compatible model. Let the
      // user configure its gateway instead of trapping them in an empty picker.
      startModelSetup(resolveModel(reference, overrides.baseUrl), overrides);
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
    startModelSetup(match.model, overrides);
  }, [startModelSetup]);

  // ── keyboard handler ─────────────────────────────────────────────────────

  useInput((_ch: string, key: Key) => {
    if (key.ctrl && (_ch === "c" || _ch === "C")) { abortRef.current.abort(); exit(); return; }

    // Ctrl+T: cycle global thinking mode (hidden → summary → full)
    // Some terminals report ctrl+t as input="t" + key.ctrl, others as a control char.
    if (key.ctrl && (_ch === "t" || _ch === "T" || _ch === "\u0014")) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_THINKING_MODE" });
      return;
    }
    // Alt+T: toggle expand/collapse of focused (or last) reasoning message.
    if (key.meta && (_ch === "t" || _ch === "T") && !key.ctrl) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_MESSAGE_THINKING" });
      return;
    }
    // Alt+↑ / Alt+↓: move focus among reasoning messages
    if (!acMode && key.meta && key.upArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: -1 });
      return;
    }
    if (!acMode && key.meta && key.downArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: 1 });
      return;
    }

    if (acMode === "profile-name") {
      if (key.escape) {
        // User skipped saving — just clear
        setInput("");
        clearAc();
      }
      return;
    }

    if (acMode === "profile-list" && profileListState) {
      const len = profileListState.profiles.length;
      if (key.upArrow && len > 0) {
        setProfileListState((s) => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + len) % len } : s);
        return;
      }
      if (key.downArrow && len > 0) {
        setProfileListState((s) => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % len } : s);
        return;
      }
      if (key.escape) {
        setInput("");
        clearAc();
        return;
      }
      return;
    }

    if (acMode === "model-setup") {
      if (key.escape) {
        setInput("");
        clearAc();
      }
      return;
    }

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
    const tool = resolveToolProvider(allToolsRef.current).find((t) => t.name === toolName);
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
    const readTool = resolveToolProvider(allToolsRef.current).find((t) => t.name === "read");
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
    const allowEmptyApiKey = acMode === "model-setup" && modelSetup?.field === "apiKey";
    if ((!trimmed && !allowEmptyApiKey) || state.busy) return;

    // Profile name step: save the new/updated profile
    if (acMode === "profile-name" && pendingProfileSetup) {
      const profileName = trimmed || "default";
      try {
        const updated = await saveProfile(profileName, {
          model: `${pendingProfileSetup.model.provider}/${pendingProfileSetup.model.id}`,
          baseUrl: pendingProfileSetup.baseUrl,
          apiKey: pendingProfileSetup.apiKey,
        });
        setProfileStore(updated);
      } catch { /* non-fatal */ }
      setPendingProfileSetup(null);
      setInput("");
      setAcMode(null);
      return;
    }

    // Profile list: activate selected profile on Enter
    if (acMode === "profile-list" && profileListState) {
      const selected = profileListState.profiles[profileListState.selectedIndex];
      if (selected) {
        try {
          const updated = await activateProfile(selected.name);
          setProfileStore(updated);
          const previousLlm = llm;
          const newLlm = loadLlmConfigFromEnv();
          setLlm(newLlm);
          dispatch({ type: "MODEL_CHANGED", modelName: newLlm.model });
          // Adapt existing conversation history for the new model's capabilities
          if (historyRef.current.length > 1) {
            historyRef.current = adaptHistoryForModel(historyRef.current, {
              targetCapabilities: newLlm.capabilities,
              sourceCapabilities: previousLlm.capabilities,
            });
          }
        } catch { /* non-fatal */ }
      }
      setInput("");
      clearAc();
      return;
    }

    if (acMode === "model-setup" && modelSetup) {
      if (modelSetup.field === "baseUrl") {
        const baseUrl = trimmed.replace(/\/$/, "");
        setModelSetup({ ...modelSetup, baseUrl, field: "apiKey", error: undefined });
        setInput(modelSetup.apiKey);
      } else {
        void commitModelSetup(modelSetup, trimmed);
      }
      return;
    }

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

    // /profiles: show profile list
    if (/^\/profiles?$/i.test(trimmed)) {
      await openProfileList();
      return;
    }

    // /profiles delete <name>
    const profileDeleteMatch = trimmed.match(/^\/profiles?\s+delete\s+(.+)$/i);
    if (profileDeleteMatch) {
      const name = profileDeleteMatch[1]!.trim();
      try {
        const updated = await removeProfile(name);
        setProfileStore(updated);
        dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "profiles-delete", name: "profiles delete", arguments: {} }, result: { content: `Profile "${name}" deleted.`, isError: false } } });
      } catch (err) {
        dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "profiles-delete", name: "profiles delete", arguments: {} }, result: { content: err instanceof Error ? err.message : String(err), isError: true } } });
      }
      setInput("");
      dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
      return;
    }

    if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
      const parsed = parseModelCommand(trimmed.replace(/^\/model\s*/i, ""));
      if (!parsed.reference) {
        setInput("");
        openModelPicker();
      } else {
        const match = findExactModelReferenceMatch(parsed.reference, getAllModels());
        if (match?.model && !match.ambiguous) selectModel(parsed.reference, parsed.overrides);
        else openModelPicker(parsed.reference);
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

    const MAX_AUTO_CONTINUES = 5;
    let autoContinueCount = 0;
    let currentUserText = trimmed;
    let currentUserContent = await resolveAtRefs(trimmed);

    const onLoopEvent = (event: LoopEvent) => {
      // Throttle assistant_delta to reduce flicker
      if (event.type === "assistant_delta") {
        deltaBufferRef.current.text += event.text;
        deltaBufferRef.current.kind = event.kind;
        if (!deltaTimerRef.current) {
          deltaTimerRef.current = setTimeout(() => {
            const buffered = deltaBufferRef.current;
            if (buffered.text) {
              dispatch({
                type: "LOOP_EVENT",
                event: { type: "assistant_delta", text: buffered.text, kind: buffered.kind },
              });
              deltaBufferRef.current = { text: "", kind: "answer" };
            }
            deltaTimerRef.current = null;
          }, 50);
        }
        return;
      }
      // Flush any pending delta buffer before dispatching a non-delta event.
      if (deltaTimerRef.current) {
        clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = null;
        const buffered = deltaBufferRef.current;
        if (buffered.text) {
          dispatch({
            type: "LOOP_EVENT",
            event: { type: "assistant_delta", text: buffered.text, kind: buffered.kind },
          });
          deltaBufferRef.current = { text: "", kind: "answer" };
        }
      }
      // All other events dispatch immediately
      dispatch({ type: "LOOP_EVENT", event });
    };

    // Auto-continue loop: re-invoke runAgentTurn when maxTurns is exceeded
    while (true) {
      try {
        historyRef.current = await runAgentTurn(historyRef.current, currentUserText, {
          llm, tools: () => [...resolveToolProvider(agentToolsRef.current), getSubagentTool()],
          preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
          signal: abortRef.current.signal,
          userContent: currentUserContent,
          authorizeTool: createMcpApprovalGate({
            allow: mcpAutoApproveFromEnv(),
            approvalHint: "Restart with MINI_AGENT_MCP_AUTO_APPROVE=1 to approve MCP calls in the TUI.",
          }),
          onEvent: onLoopEvent,
        });
        break; // Normal completion — exit the auto-continue loop
      } catch (err) {
        if (err instanceof MaxTurnsExceededError) {
          historyRef.current = err.messages;
          autoContinueCount++;
          if (autoContinueCount >= MAX_AUTO_CONTINUES || abortRef.current.signal.aborted) {
            // Hit safety cap or aborted — stop auto-continuing
            dispatch({ type: "LOOP_EVENT", event: { type: "error", message: `已达到自动续跑上限 (${MAX_AUTO_CONTINUES} 次)` } });
            dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
            break;
          }
          // Auto-continue: send "继续" as next user message
          currentUserText = "继续完成之前的工作";
          currentUserContent = currentUserText;
          dispatch({ type: "LOOP_EVENT", event: {
            type: "context_compacted",
            beforeTokens: 0,
            afterTokens: 0,
            reason: `自动续跑 (${autoContinueCount}/${MAX_AUTO_CONTINUES})`,
          }});
          continue;
        }
        // Other errors — report and stop
        const errMsg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "LOOP_EVENT", event: { type: "error", message: errMsg } });
        dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
        break;
      }
    }
  }, [state.busy, acMode, modelSetup, pendingProfileSetup, profileListState, llm, vision, exit, runDirectTool, resolveAtRefs, clearAc, commitModelSetup, openProfileList]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={2}>
        <Text color="cyan" bold>mini-agent</Text>
        <Text dimColor>[/help] [Ctrl+C]</Text>
      </Box>
      <Text dimColor>{"─".repeat(termWidth)}</Text>

      <MessageFeed
        messages={state.messages}
        streamingText={state.streamingText}
        streamingReasoning={state.streamingReasoning}
        thinkingMode={state.thinkingMode}
        expandedThinking={state.expandedThinking}
        focusedMessageIndex={state.focusedMessageIndex}
        busy={state.busy}
        status={state.status}
      />

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

      {acMode === "model-setup" && modelSetup && (
        <Box flexDirection="column" paddingX={2}>
          <Text color="cyan" bold>── 配置模型 ──</Text>
          <Text>模型: {modelSetup.model.provider}/{modelSetup.model.id}</Text>
          <Text dimColor>Base URL: {modelSetup.field === "baseUrl" ? "正在编辑" : modelSetup.baseUrl}</Text>
          <Text dimColor>API Key: {modelSetup.field === "apiKey" ? "正在编辑" : "已设置"}</Text>
          {modelSetup.error && <Text color="red">{modelSetup.error}</Text>}
          <Text dimColor>Enter 确认当前字段，Esc 取消</Text>
        </Box>
      )}

      {acMode === "profile-name" && pendingProfileSetup && (
        <Box flexDirection="column" paddingX={2}>
          <Text color="cyan" bold>── 保存配置文件 ──</Text>
          <Text>模型: {pendingProfileSetup.model.provider}/{pendingProfileSetup.model.id}</Text>
          <Text dimColor>输入配置文件名称（Enter 保存，Esc 跳过）:</Text>
        </Box>
      )}

      {acMode === "profile-list" && profileListState && (
        <Box flexDirection="column" paddingX={2}>
          <Text color="cyan" bold>── 配置文件列表 ──</Text>
          {profileListState.profiles.length === 0 && <Text dimColor>无已保存的配置文件</Text>}
          {profileListState.profiles.map((p, i) => (
            <Text key={p.name} color={i === profileListState.selectedIndex ? "green" : undefined}>
              {i === profileListState.selectedIndex ? "▶ " : "  "}
              {p.active ? "✓ " : "  "}
              {p.name} ({p.model}) — {p.baseUrl}
            </Text>
          ))}
          <Text dimColor>↑↓ 选择，Enter 激活，Esc 取消，/profiles delete &lt;name&gt; 删除</Text>
        </Box>
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
                onChange={setInputSafe}
                mask={acMode === "model-setup" && modelSetup?.field === "apiKey" ? "*" : undefined}
                onSubmit={(val) => {
                  if ((acMode === "model" || acMode === "model-picker") && modelCandidates[acIndex]) {
                    selectModel(modelCandidates[acIndex]!);
                  } else {
                    void handleSubmit(val);
                  }
                }}
                placeholder={
                  acMode === "model-picker" ? "搜索模型"
                    : acMode === "model-setup" && modelSetup?.field === "baseUrl" ? "输入 Base URL"
                      : acMode === "model-setup" ? "输入 API Key，可留空使用环境变量"
                        : acMode === "profile-name" ? "输入配置文件名称（例如 coding-fast）"
                          : acMode === "profile-list" ? "↑↓ 选择配置文件，Enter 激活"
                            : "输入消息，/ 命令，或 @文件 引用"
                }
              />
            )
          }
        </Box>
        <Text dimColor>[think:{state.thinkingMode}] [Ctrl+T/Alt+T]  {state.modelName} · {state.contextTokens > 0 ? `${formatContextWindow(state.contextTokens)} / ` : ""}{formatContextWindow(llm.contextWindow)}</Text>
      </Box>
    </Box>
  );
}
